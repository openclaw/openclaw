/**
 * Real isolated Gateway WS sessions.catalog.list -> bundled Codex -> pinned native
 * app-server. A separate client proves health RPCs complete during a 350ms hold
 * inside actual native spawn. No credentials, inference, Team state, or btrfs claim.
 * node --import ./scripts/tsx.mjs scripts/perf/codex-catalog-gateway-proof.ts
 *   --state-dir <NEW task-owned directory>
 * Run the identical script on a baseline checkout for the red comparison; never
 * replace live candidate source while another test or reviewer uses it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GatewayClient } from "../../packages/gateway-client/src/client.ts";
import type { SessionsCatalogListResult } from "../../packages/gateway-protocol/src/schema/sessions-catalog.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    gateway: { type: "boolean" },
    port: { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir must name a new task-owned directory");
const root = path.resolve(values["state-dir"]);
if (values.gateway) {
  const { startGatewayServer } = await import("../../src/gateway/server.js");
  const server = await startGatewayServer(Number(values.port), {
    bind: "loopback",
    controlUiEnabled: false,
  });
  await server.startupSettled;
  process.send?.({ type: "ready" });
  process.once("message", () => {
    void server.close({ reason: "isolated Codex spawn responsiveness proof complete" }).then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
} else {
  await prove();
}

type SpawnEvent = {
  event: string;
  at: number;
  gatewayPid: number;
  threadId: number;
  isMainThread: boolean;
  childPid?: number;
  code?: number;
  signal?: string | null;
};

async function prove() {
  await mkdir(root);
  const { createNativeCatalogPerformanceFixture } =
    await import("../../extensions/codex/src/session-catalog-native-performance.test-support.js");
  const fixture = await createNativeCatalogPerformanceFixture(root, {
    count: 32,
    previewBytes: 512,
  });
  const port = await getFreePort();
  const token = "synthetic-codex-spawn-proof-token";
  const configPath = path.join(root, "openclaw.json");
  const eventPath = path.join(root, "spawn-events.jsonl");
  await writeFile(eventPath, "");
  await writeFile(
    configPath,
    JSON.stringify({
      ...BASE_GATEWAY_BENCH_CONFIG,
      logging: { file: path.join(root, "gateway.log") },
      gateway: { ...BASE_GATEWAY_BENCH_CONFIG.gateway, auth: { mode: "token", token } },
      agents: {
        defaults: { model: { primary: "synthetic/model" } },
        entries: { main: { workspace: fixture.cwd } },
      },
      plugins: {
        allow: ["codex"],
        slots: { memory: "none" },
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: { command: fixture.command, homeScope: "user" },
              sessionCatalog: { enabled: true },
            },
          },
        },
      },
      cron: { enabled: false },
    }),
  );
  const preload = new URL("./codex-catalog-gateway-preload.mjs", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("../tsx.mjs", import.meta.url).href,
      fileURLToPath(import.meta.url),
      "--state-dir",
      root,
      "--gateway",
      "--port",
      String(port),
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...createGatewayBenchEnv(path.join(root, "home"), configPath, {
          startupTrace: false,
          caseEnv: { OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_SKIP_CHANNELS: "1" },
        }),
        ...fixture.env,
        TMPDIR: tmpdir(),
        TMP: tmpdir(),
        TEMP: tmpdir(),
        NODE_OPTIONS: `--import=${preload}`,
        OPENCLAW_CODEX_GATEWAY_PROOF_COMMAND: fixture.command,
        OPENCLAW_CODEX_GATEWAY_PROOF_EVENTS: eventPath,
        // Hosted children stay in this isolated Gateway's group for bounded teardown.
        OPENCLAW_GATEWAY_HOST_LIFELINE: "stdin",
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  );
  const log = createWriteStream(path.join(root, "process.log"));
  assert(child.stdout && child.stderr, "Gateway was launched with piped stdout/stderr");
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const exited = once(child, "close");
  void exited.catch(() => {});
  let client: GatewayClient | undefined;
  let polling = true;
  let heartbeat: Promise<void> | undefined;
  const health: Array<{ start: number; end: number; latencyMs: number }> = [];
  const forceStop = () => void stopChild(child).catch(() => child.kill("SIGKILL"));
  const timeout = setTimeout(forceStop, 120_000);
  try {
    await Promise.race([
      once(child, "message"),
      exited.then(() => {
        throw new Error("Isolated Gateway exited before readiness; inspect process.log");
      }),
    ]);
    const connected = Promise.withResolvers<void>();
    const gateway = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      clientName: "gateway-client",
      clientDisplayName: "synthetic-codex-spawn-proof",
      platform: process.platform,
      mode: "backend",
      role: "operator",
      scopes: ["operator.read", "operator.admin"],
      token,
      caps: [],
      deviceIdentity: null,
      requestTimeoutMs: 30_000,
      onHelloOk: () => connected.resolve(),
      onConnectError: (error) => connected.reject(error),
    });
    client = gateway;
    gateway.start();
    await connected.promise;
    for (let index = 0; index < 3; index++) {
      await gateway.request("health", {});
    }
    assert.equal((await readFile(eventPath, "utf8")).trim(), "", "Catalog must be demand-started");
    heartbeat = (async () => {
      for (;;) {
        if (!polling) {
          break;
        }
        const start = Date.now();
        await gateway.request("health", {});
        const end = Date.now();
        health.push({ start, end, latencyMs: end - start });
        await delay(20);
      }
    })();
    void heartbeat.catch(() => {});
    const catalogStarted = performance.now();
    let result: SessionsCatalogListResult | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      result = await gateway.request<SessionsCatalogListResult>("sessions.catalog.list", {
        catalogId: "codex",
        agentId: "main",
        hostIds: ["gateway:local"],
        limitPerHost: 64,
      });
      if (
        result.catalogs.some((catalog) => catalog.hosts.some((host) => host.sessions.length === 32))
      ) {
        break;
      }
      await delay(100);
    }
    const catalogMs = performance.now() - catalogStarted;
    polling = false;
    await heartbeat;
    const events: SpawnEvent[] = (await readFile(eventPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const begin = events.find((event) => event.event === "begin");
    const returned = events.find((event) => event.event === "returned");
    assert(begin && returned, "RPC must reach the instrumented native spawn");
    const during = health.filter((sample) => sample.start >= begin.at && sample.end < returned.at);
    const overlapping = health.filter(
      (sample) => sample.start >= begin.at && sample.start < returned.at,
    );
    const sessions =
      result?.catalogs.flatMap((catalog) => catalog.hosts.flatMap((host) => host.sessions)) ?? [];
    const report = {
      nativeCommand: fixture.command,
      gatewayPid: child.pid,
      events,
      catalogMs,
      sessionCount: sessions.length,
      injectedMs: returned.at - begin.at,
      healthCompletedDuringSpawn: during.length,
      maxHealthLatencyDuringSpawnMs: Math.max(0, ...overlapping.map((sample) => sample.latencyMs)),
      health,
      catalog: result,
      limitations:
        "32 synthetic native rollouts; no inference, credentials, filesystem stall, or production data.",
    };
    await writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        ...report,
        catalog: undefined,
        health: undefined,
        nativeCommand: undefined,
      }),
    );
    assert.equal(sessions.length, 32, "Public catalog must return all synthetic native sessions");
    assert.equal(begin.isMainThread, false, "Native spawn must execute outside Gateway main");
    assert(returned.at - begin.at >= 350);
    assert(during.length >= 3, "Health RPCs must complete while native spawn is stalled");
    assert(report.maxHealthLatencyDuringSpawnMs < 150);
  } finally {
    polling = false;
    await heartbeat?.catch(() => {});
    client?.stop();
    if (child.connected) {
      child.send({ type: "stop" });
    }
    const cleanupTimeout = setTimeout(forceStop, 10_000);
    const [code, signal] = await exited;
    clearTimeout(cleanupTimeout);
    clearTimeout(timeout);
    log.end();
    assert.deepEqual([code, signal], [0, null], "Gateway must close cleanly");
  }
}
