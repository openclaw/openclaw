import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { stopChildProcess } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.js";
import manifest from "../package.json" with { type: "json" };
import { packagingEntrypoints } from "./install-runtime-entrypoints.test-support.mts";

const execFileAsync = promisify(execFile);
const { name: packageName, version: pluginVersion } = manifest;
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const pluginRoot = path.resolve(import.meta.dirname, "..");
const cleanups: (() => Promise<unknown>)[] = [];
let registryChild: ChildProcess | undefined;

afterEach(async () => {
  if (registryChild) {
    await stopChildProcess(registryChild, 5_000);
    registryChild = undefined;
  }
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function packPlugin(outputDir: string) {
  const stagingDir = path.join(outputDir, "package-source");
  await fs.cp(pluginRoot, stagingDir, {
    recursive: true,
    filter: (source) =>
      !["dist", "node_modules"].includes(
        path.relative(pluginRoot, source).split(path.sep)[0] ?? "",
      ),
  });
  const runPackaging = (entrypoint: keyof typeof packagingEntrypoints, args: string[]) =>
    execFileAsync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(packagingEntrypoints[entrypoint])),
        ...args,
      ],
      {
        cwd: repoRoot,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 60_000,
        env: { ...process.env, OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES: "1" },
      },
    );
  await runPackaging("runtimeBuild", [stagingDir]);
  await runPackaging("packageManifest", [
    "--run",
    stagingDir,
    "--",
    "npm",
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    outputDir,
  ]);
  return path.join(outputDir, `openclaw-diagnostics-prometheus-${pluginVersion}.tgz`);
}

async function startRegistry(root: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const tarballPath = await packPlugin(root);
  const log = await fs.open(path.join(root, "registry.log"), "a");
  const child = spawn(
    process.execPath,
    [
      "scripts/e2e/lib/plugins/npm-registry-server.mjs",
      path.join(root, "registry-port"),
      packageName,
      pluginVersion,
      tarballPath,
    ],
    { cwd: repoRoot, env, stdio: ["ignore", log.fd, log.fd, "ipc"] },
  );
  registryChild = child;
  const ready = withinTest(
    awaitGateBeforeSettlement(
      once(child, "message", { signal }),
      once(child, "close", { signal }),
      "local npm registry exited before publishing its port",
    ),
    signal,
  );
  void ready.catch(() => {});
  await log.close();
  return `http://127.0.0.1:${(await ready)[0]}`;
}

it("installs trusted Prometheus metrics with scoped HTTP access", async ({ signal }) => {
  const gatewayPassword = "prometheus-managed-install-test-password";
  const instance = await createOpenClawTestInstance({
    name: "prometheus-install",
    cwd: repoRoot,
    entrypoint: ["openclaw.mjs"],
    signal,
    stopTimeoutMs: 5_000,
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
      OPENCLAW_PLUGINS_PATHS: undefined,
      OPENCLAW_TEST_FAST: undefined,
      OPENCLAW_TEST_HOME: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      NODE_ENV: "production",
      NO_COLOR: "1",
    },
    config: {
      diagnostics: { enabled: true },
      gateway: {
        mode: "local",
        trustedProxies: ["127.0.0.1"],
        auth: {
          mode: "trusted-proxy",
          password: gatewayPassword,
          trustedProxy: {
            allowLoopback: true,
            allowUsers: ["restricted-scraper@example.com"],
            requiredHeaders: ["x-forwarded-proto"],
            userHeader: "x-forwarded-user",
          },
        },
        roles: {
          default: "metrics-denied",
          definitions: {
            "metrics-denied": {
              agents: "*",
              scopes: ["operator.approvals"],
              sessions: { others: "none" },
            },
          },
        },
      },
    },
  });
  cleanups.push(() => instance.cleanup());
  const registry = await startRegistry(instance.state.root, instance.env, signal);
  Object.assign(instance.env, { NPM_CONFIG_REGISTRY: registry, npm_config_registry: registry });

  expect(
    await instance.cli(
      ["plugins", "install", `npm:${packageName}@${pluginVersion}`, "--accept-capabilities"],
      { timeoutMs: 180_000 },
    ),
  ).toMatchObject({ code: 0, signal: null });
  await instance.startGateway();
  const gateway = expectDefined(instance.child, "Gateway fixture child");
  const gatewayClosed = once(gateway, "close", { signal });
  void gatewayClosed.catch(() => {});
  const url = `http://127.0.0.1:${instance.port}/api/diagnostics/prometheus`;
  const authenticated = await fetch(url, {
    headers: { authorization: `Bearer ${gatewayPassword}` },
  });
  expect(authenticated.status).toBe(200);
  expect(authenticated.headers.get("content-type")).toContain("text/plain");
  expect(await authenticated.text()).toContain(
    'openclaw_telemetry_exporter_total{exporter="diagnostics-prometheus",reason="configured",signal="metrics",status="started"} 1',
  );
  const restricted = await fetch(url, {
    method: "HEAD",
    headers: {
      "x-forwarded-for": "203.0.113.25",
      "x-forwarded-proto": "https",
      "x-forwarded-user": "restricted-scraper@example.com",
    },
  });
  expect(restricted.status).toBe(403);
  expect(restricted.headers.get("cache-control")).toBe("no-store");
  expect(await restricted.text()).toBe("");
  expect(restricted.headers.get("content-length")).not.toBe(
    authenticated.headers.get("content-length"),
  );
  const scrapeEventLoopMetrics = async (scrapeSignal = signal) => {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${gatewayPassword}` },
      signal: scrapeSignal,
    });
    expect(response.status).toBe(200);
    const lines = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("openclaw_gateway_event_loop_"));
    const value = (name: string) => {
      const metric = lines.find((line) => line.startsWith(`${name} `));
      return Number(metric?.split(" ").at(-1));
    };
    return {
      lines,
      count: value("openclaw_gateway_event_loop_delay_max_seconds_count"),
      sum: value("openclaw_gateway_event_loop_delay_max_seconds_sum"),
      observed: value("openclaw_gateway_event_loop_observed_seconds_total"),
    };
  };
  const waitForExportedWindow = async (afterCount: number) => {
    const controller = new AbortController();
    const waitSignal = AbortSignal.any([signal, controller.signal]);
    const pending = (async () => {
      for (;;) {
        const current = await scrapeEventLoopMetrics(waitSignal);
        if (current.count > afterCount) {
          return current;
        }
        await delay(100, undefined, { signal: waitSignal });
      }
    })();
    try {
      return await withinTest(
        awaitGateBeforeSettlement(
          pending,
          gatewayClosed,
          "Gateway exited before exporting another event-loop window",
        ),
        signal,
      );
    } finally {
      // A settlement race does not cancel its work. Stop the request/timer and
      // settle the loop before Gateway and temporary-state cleanup can begin.
      controller.abort();
      await pending.catch(() => {});
    }
  };

  // Readiness retains a sampler snapshot; diagnostics reach the exporter asynchronously.
  // Exact per-window arithmetic belongs to the controlled producer in service.event-loop.test.
  let previous = { count: 0, sum: 0, observed: 0 };
  for (let window = 0; window < 2; window++) {
    const current = await waitForExportedWindow(previous.count);
    expect(current.count).toBeGreaterThan(previous.count);
    expect(Number.isFinite(current.sum)).toBe(true);
    expect(current.sum).toBeGreaterThanOrEqual(previous.sum);
    expect(Number.isFinite(current.observed)).toBe(true);
    expect(current.observed).toBeGreaterThan(previous.observed);
    expect(current.lines.join("\n")).not.toMatch(/\{(?!le=)/u);
    previous = current;
  }
  // Background sampling may publish windows between full-Gateway scrapes.
  for (let scrape = 0; scrape < 2; scrape++) {
    const current = await scrapeEventLoopMetrics();
    expect(current.count).toBeGreaterThanOrEqual(previous.count);
    expect(current.sum).toBeGreaterThanOrEqual(previous.sum);
    expect(current.observed).toBeGreaterThanOrEqual(previous.observed);
    previous = current;
  }
  // Graceful stop drains startup work; the forced reaper is cleanup only.
  expect(process.kill(gateway.pid!, "SIGTERM")).toBe(true);
  await gatewayClosed;
  expect(gateway).toMatchObject({ exitCode: 0, signalCode: null });
}, 300_000);
