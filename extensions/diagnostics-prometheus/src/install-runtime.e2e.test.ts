import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { acquireTestPortBlock, stopChildProcess } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
import { packagingEntrypoints } from "./install-runtime-entrypoints.test-support.mts";

const execFileAsync = promisify(execFile);
const packageName = "@openclaw/diagnostics-prometheus";
const pluginId = "diagnostics-prometheus";
const pluginVersion = manifest.version.trim();
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const pluginRoot = path.resolve(import.meta.dirname, "..");
const cleanups: (() => Promise<unknown>)[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  const stopped = await Promise.allSettled(
    children.splice(0).map((child) => stopChildProcess(child, 5_000)),
  );
  const errors = stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "failed to stop Prometheus E2E children");
  }
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function isolatedEnv(root: string, registry?: string) {
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_PLUGIN_CATALOG_PATHS",
    "OPENCLAW_PLUGINS_PATHS",
    "OPENCLAW_TEST_FAST",
    "OPENCLAW_TEST_HOME",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
    "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
    "VITEST",
    "VITEST_POOL_ID",
    "VITEST_WORKER_ID",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NODE_ENV: "production",
    NO_COLOR: "1",
    ...(registry && { NPM_CONFIG_REGISTRY: registry, npm_config_registry: registry }),
  };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  // E2E setup owns shared dist; a child rebuild can delete running siblings' chunks.
  const result = await execFileAsync(process.execPath, ["openclaw.mjs", ...args], {
    cwd: repoRoot,
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 180_000,
  });
  return result.stdout;
}

async function spawnLogged(args: string[], logPath: string, env: NodeJS.ProcessEnv, ipc = false) {
  const log = await fs.open(logPath, "a");
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", log.fd, log.fd, ...(ipc ? ["ipc" as const] : [])],
  });
  children.push(child);
  return { child, closeLog: () => log.close() };
}

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
        ...(entrypoint === "packageManifest" && {
          env: { ...process.env, OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES: "1" },
        }),
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
  const tarballPath = path.join(outputDir, `openclaw-${pluginId}-${pluginVersion}.tgz`);
  const entries = await execFileAsync("tar", ["-tzf", tarballPath], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
  expect(entries.stdout).toMatch(/^package\/dist\/index\.(?:js|mjs|cjs)\r?$/mu);
  return tarballPath;
}

async function startRegistry(root: string, tarballPath: string, signal: AbortSignal) {
  const { child, closeLog } = await spawnLogged(
    [
      "scripts/e2e/lib/plugins/npm-registry-server.mjs",
      path.join(root, "registry-port"),
      packageName,
      pluginVersion,
      tarballPath,
    ],
    path.join(root, "registry.log"),
    isolatedEnv(root),
    true,
  );
  const ready = withinTest(
    awaitGateBeforeSettlement(
      once(child, "message", { signal }),
      once(child, "close", { signal }),
      "local npm registry exited before publishing its port",
    ),
    signal,
  );
  void ready.catch(() => {});
  await closeLog();
  const [port] = await ready;
  expect(port).toEqual(expect.any(Number));
  return `http://127.0.0.1:${port}`;
}

async function waitForGateway(child: ChildProcess, logPath: string, port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Readiness is authoritative only after the HTTP endpoint responds.
    }
    await delay(200);
  }
  const logs = await fs.readFile(logPath, "utf8").catch(() => "");
  throw new Error(
    `Gateway did not become ready (exit=${child.exitCode}, signal=${child.signalCode}):\n${logs.slice(-8_000)}`,
  );
}

it("installs trusted Prometheus metrics with scoped HTTP access", async ({ signal }) => {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-prometheus-install-",
  });
  cleanups.push(() => workspace.cleanup());
  const root = workspace.dir;
  const paths = isolatedEnv(root);
  const gatewayLog = path.join(root, "gateway.log");
  const gatewayPassword = "prometheus-managed-install-test-password";
  const { port: gatewayPort, release } = await acquireTestPortBlock({ offsets: [0], signal });
  cleanups.push(release);
  await Promise.all(
    [paths.HOME, paths.OPENCLAW_STATE_DIR].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
  const config = {
    diagnostics: { enabled: true },
    gateway: {
      mode: "local",
      controlUi: { enabled: false },
      bind: "loopback",
      port: gatewayPort,
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
  };
  await fs.writeFile(paths.OPENCLAW_CONFIG_PATH, JSON.stringify(config), "utf8");

  expect(pluginVersion).not.toBe("");
  const tarballPath = await packPlugin(root);
  const registry = await startRegistry(root, tarballPath, signal);
  const env = isolatedEnv(root, registry);

  await runCli(
    ["plugins", "install", `npm:${packageName}@${pluginVersion}`, "--accept-capabilities"],
    env,
  );
  const inspect = JSON.parse(
    await runCli(["plugins", "inspect", pluginId, "--runtime", "--json"], env),
  ) as {
    install?: { artifactKind?: unknown; installPath?: unknown; sourcePath?: unknown };
    plugin?: { origin?: unknown };
  };
  expect(inspect).toMatchObject({
    install: {
      source: "npm",
      resolvedName: packageName,
      resolvedVersion: pluginVersion,
    },
    plugin: {
      id: pluginId,
      enabled: true,
      status: "loaded",
      trustedOfficialInstall: true,
    },
  });
  expect(typeof inspect.install?.installPath).toBe("string");
  expect(inspect.install?.artifactKind).toBeUndefined();
  expect(inspect.install?.sourcePath).toBeUndefined();
  expect(["config", "global"]).toContain(inspect.plugin?.origin);

  const { child: gateway, closeLog } = await spawnLogged(
    ["openclaw.mjs", "gateway", "run", "--bind", "loopback", "--port", String(gatewayPort)],
    gatewayLog,
    env,
  );
  const gatewayClosed = once(gateway, "close", { signal });
  // Setup can fail before this waiter is awaited; afterEach still owns forced cleanup.
  void gatewayClosed.catch(() => {});
  await closeLog();
  await waitForGateway(gateway, gatewayLog, gatewayPort);

  const url = `http://127.0.0.1:${gatewayPort}/api/diagnostics/prometheus`;
  const unauthenticated = await fetch(url);
  expect([401, 403]).toContain(unauthenticated.status);
  const authenticated = await fetch(url, {
    headers: { authorization: `Bearer ${gatewayPassword}` },
  });
  expect(authenticated.status).toBe(200);
  expect(authenticated.headers.get("content-type")).toContain("text/plain");
  expect(await authenticated.text()).toContain(
    'openclaw_telemetry_exporter_total{exporter="diagnostics-prometheus",reason="configured",signal="metrics",status="started"} 1',
  );
  const restrictedHeaders = {
    "x-forwarded-for": "203.0.113.25",
    "x-forwarded-proto": "https",
    "x-forwarded-user": "restricted-scraper@example.com",
  };
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(url, { headers: restrictedHeaders, method });
    expect({
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: await response.text(),
    }).toEqual({
      status: 403,
      cacheControl: "no-store",
      body: method === "HEAD" ? "" : "missing scope: operator.read",
    });
    if (method === "HEAD") {
      expect(response.headers.get("content-length")).not.toBe(
        authenticated.headers.get("content-length"),
      );
    }
  }
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
  const gatewayLogs = await fs.readFile(gatewayLog, "utf8");
  expect(gatewayLogs).not.toContain(
    "diagnostics-prometheus: internal diagnostics capability unavailable",
  );
  // Graceful stop drains startup work; the forced reaper is cleanup only.
  expect(gateway.kill("SIGTERM")).toBe(true);
  await gatewayClosed;
  expect(gateway).toMatchObject({ exitCode: 0, signalCode: null });
}, 300_000);
