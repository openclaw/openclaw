/**
 * Real plugins.list RPCs against an owned dist Gateway with 10,800 synthetic
 * sessions and 44 synthetic plugin manifests. Never connects to a running host.
 *
 * Prepare once, then run each already-built revision (serial AB/BA, same fixture):
 * node --import ./scripts/tsx.mjs scripts/perf/plugins-list-measure.ts --state-dir .local/plugins-list --prepare
 * node --import ./scripts/tsx.mjs scripts/perf/plugins-list-measure.ts --state-dir .local/plugins-list --output .local/plugins-list-base --revision BASE --mode timing
 * Optional --start-file FILE pauses after warmup until FILE exists.
 * Repeat with --mode allocation separately; allocation sampling distorts timing.
 * Default 1,000 requests supplies enough samples for p99. The 64 sockets remain
 * connected; this targeted list workload does not claim concurrent-turn stress.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import type { PluginInstallRecord } from "../../src/config/types.plugins.js";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayHeapProfile,
  readGatewayResources,
  startGatewayDiagnostics,
} from "../lib/gateway-bench-profile.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  writeGatewayBenchConfig,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { generateTeamShapeStressFixture } from "./team-shape-stress-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    prepare: { type: "boolean" },
    entry: { type: "string", default: "dist/entry.js" },
    revision: { type: "string" },
    "start-file": { type: "string" },
    mode: { type: "string", default: "timing" },
    samples: { type: "string", default: "1000" },
    clients: { type: "string", default: "64" },
    "poll-ms": { type: "string", default: "20" },
    port: { type: "string", default: "41805" },
  },
});
assert(values["state-dir"], "--state-dir is required");
const root = path.resolve(values["state-dir"]);
const port = Number(values.port);
const samples = Number(values.samples);
const clientCount = Number(values.clients);
const pollMs = Number(values["poll-ms"]);
assert(Number.isSafeInteger(port) && port >= 40000 && port <= 65535);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(clientCount) && clientCount > 0);
assert(Number.isSafeInteger(pollMs) && pollMs >= 0);
assert(values.mode === "timing" || values.mode === "allocation");
if (values.prepare) {
  const marker = path.join(root, "plugins-list-fixture.json");
  const prior = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : undefined;
  if (prior) {
    assert.equal(prior.format, "plugins-list-v1");
  }
  const fixture = prior
    ? {
        summary: JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8")),
        env: {
          ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {}),
          OPENCLAW_STATE_DIR: root,
        },
      }
    : await generateTeamShapeStressFixture({
        stateDir: root,
        port,
        seed: 1805,
        now: Date.parse("2026-10-25T12:00:00Z"),
        transcriptMiB: 16,
      });
  if (!prior?.trackedNpm) {
    const savedEnv = process.env;
    process.env = {
      ...fixture.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      TMPDIR: path.join(root, "tmp"),
    };
    try {
      const { resolvePluginNpmProjectDir } = await import("../../src/plugins/install-paths.js");
      const { resolvePluginInstallRoots } =
        await import("../../src/plugins/install-root-context.js");
      const { withPluginLifecycleLease } =
        await import("../../src/plugins/plugin-lifecycle-lease.js");
      const { writePersistedInstalledPluginIndexInstallRecordsWithLease } =
        await import("../../src/plugins/installed-plugin-index-records.js");
      const { npmDir } = resolvePluginInstallRoots(process.env);
      const config = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
      const { pluginIds, pluginsDir } = writePluginFixtures(root, {
        count: 44,
        activationOnStartup: false,
      });
      const records: Record<string, PluginInstallRecord> = {};
      for (const id of pluginIds) {
        const packageName = `@fixture/${id}`;
        const project = resolvePluginNpmProjectDir({ npmDir, packageName });
        const installPath = path.join(project, "node_modules", "@fixture", id);
        mkdirSync(path.dirname(installPath), { recursive: true });
        renameSync(path.join(pluginsDir, id), installPath);
        writeFileSync(
          path.join(project, "package.json"),
          JSON.stringify({ private: true, dependencies: { [packageName]: "1.0.0" } }),
        );
        writeFileSync(
          path.join(installPath, "package.json"),
          JSON.stringify({
            name: packageName,
            version: "1.0.0",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        records[id] = {
          source: "npm",
          spec: `${packageName}@1.0.0`,
          resolvedName: packageName,
          resolvedSpec: `${packageName}@1.0.0`,
          version: "1.0.0",
          installPath,
        };
      }
      config.plugins = { enabled: true, allow: pluginIds, slots: { memory: "none" } };
      writeGatewayBenchConfig(root, config, {});
      await withPluginLifecycleLease({}, (lease) =>
        writePersistedInstalledPluginIndexInstallRecordsWithLease(records, { config, lease }),
      );
      writeFileSync(
        marker,
        JSON.stringify({
          format: "plugins-list-v1",
          plugins: 44,
          sessions: fixture.summary.sessionCount,
          trackedNpm: true,
        }),
      );
    } finally {
      process.env = savedEnv;
    }
  }
  console.log(
    JSON.stringify({
      fixture: root,
      plugins: 44,
      sessions: fixture.summary.sessionCount,
      trackedNpm: true,
    }),
  );
  process.exit(0);
}
assert(values.output && values.revision, "--output and --revision are required for measurement");
assert(existsSync(path.resolve(values.entry)), "Build the Gateway before measurement");
const fixture = JSON.parse(readFileSync(path.join(root, "plugins-list-fixture.json"), "utf8"));
assert.equal(fixture.format, "plugins-list-v1");
const output = path.resolve(values.output);
mkdirSync(output, { recursive: true });
const probe = createServer();
await new Promise<void>((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", resolve);
});
await new Promise<void>((resolve, reject) => {
  probe.close((error) => (error ? reject(error) : resolve()));
});
const log = createWriteStream(path.join(output, "gateway.log"));
const startupStarted = performance.now();
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(path.resolve(values.entry), port, [
    "--import",
    path.resolve("scripts/perf/team-shape-stress-loader.mjs"),
    "--import",
    path.resolve("scripts/lib/gateway-bench-profile-preload.ts"),
  ]),
  {
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
      startupTrace: false,
      caseEnv: {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_PROFILE: `plugins-list-${port}`,
        OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-plugins-list-${port}`,
        OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.plugins-list-${port}`,
        TMPDIR: path.join(root, "tmp"),
      },
    }),
  },
);
gateway.stdout?.pipe(log);
gateway.stderr?.pipe(log);
const clients: ReturnType<typeof createGatewayWsClient>[] = [];
let closed = false;
async function cleanup() {
  if (closed) {
    return;
  }
  closed = true;
  for (const client of clients) {
    client.close();
  }
  await stopChild(gateway, { teardownGraceMs: 10_000 });
  log.end();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(1));
  });
}
async function rpc(client: (typeof clients)[number], method: string, params: unknown) {
  const response = await client.request(method, params, 60_000);
  assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
  return response.payload;
}
function summarize(numbers: number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return {
    count: numbers.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}
try {
  const deadline = Date.now() + 300_000;
  while (
    !(await fetch(`http://127.0.0.1:${port}/readyz`).then(
      (r) => r.ok,
      () => false,
    ))
  ) {
    assert(gateway.exitCode === null && gateway.signalCode === null, `Gateway exited: ${output}`);
    assert(Date.now() < deadline, `Gateway readiness timeout: ${output}`);
    await delay(250);
  }
  const startupReadyMs = performance.now() - startupStarted;
  for (let index = 0; index < clientCount; index++) {
    const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    clients.push(client);
    await client.waitOpen();
    await rpc(client, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "synthetic-plugins-list",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.admin"],
      caps: [],
    });
  }
  const client = clients[0]!;
  const firstStart = performance.now();
  const first = (await rpc(client, "plugins.list", {})) as {
    plugins: Array<{ id: string; installed: boolean }>;
  };
  const firstRpcMs = performance.now() - firstStart;
  writeFileSync(path.join(output, "response.json"), JSON.stringify(first, null, 2));
  const responseSha256 = createHash("sha256").update(JSON.stringify(first)).digest("hex");
  assert.equal(
    first.plugins.filter((plugin) => plugin.installed && plugin.id.startsWith("bench-plugin-"))
      .length,
    44,
  );
  for (let index = 0; index < 20; index++) {
    await rpc(client, "plugins.list", {});
  }
  if (values["start-file"]) {
    console.log(JSON.stringify({ ready: true, waitingFor: values["start-file"] }));
    const startDeadline = Date.now() + 300_000;
    while (!existsSync(values["start-file"])) {
      assert(Date.now() < startDeadline, "Timed out waiting for --start-file");
      await delay(100);
    }
  }
  const hostLoadBefore = loadavg();
  const before = await readGatewayResources(gateway);
  const profilePath = path.join(output, "allocation.heapprofile");
  const stopDiagnostics = await startGatewayDiagnostics(gateway);
  if (values.mode === "allocation") {
    await controlGatewayProfile(gateway, "heap", "start", profilePath);
  }
  const times: number[] = [];
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    await rpc(clients[index % clients.length]!, "plugins.list", {});
    times.push(performance.now() - started);
    if (pollMs) {
      await delay(pollMs);
    }
  }
  if (values.mode === "allocation") {
    await controlGatewayProfile(gateway, "heap", "stop", profilePath);
  }
  const diagnostics = await stopDiagnostics();
  const after = await readGatewayResources(gateway);
  const result = {
    revision: values.revision,
    mode: values.mode,
    fixture,
    clients: clientCount,
    pollMs,
    startupReadyMs,
    firstRpcMs,
    responseSha256,
    latencyMs: summarize(times),
    diagnostics,
    cpu: measureGatewayCpuUsage(before, after),
    memory: { before: before.memory, after: after.memory },
    hostLoad: { before: hostLoadBefore, after: loadavg() },
    ...(values.mode === "allocation" ? { allocation: readGatewayHeapProfile(profilePath) } : {}),
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await cleanup();
}
