// Source Gateway diagnostics through ordinary RPCs; no projection invalidation hooks.
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { getSessionRowSelectionMetrics } from "../../src/infra/gateway-work-metrics.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  summarizeNumbers,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    port: { type: "string", default: "62689" },
    sessions: { type: "string", default: "32" },
    lists: { type: "string", default: "100" },
    child: { type: "boolean", default: false },
  },
});
assert(values.root, "--root must name a new synthetic state directory");
const root = path.resolve(values.root);
const port = parseStrictIntegerOption({
  raw: values.port,
  label: "port",
  min: 40000,
  fallback: 62689,
});
assert(port < 65535);
const sessions = parseStrictIntegerOption({
  raw: values.sessions,
  label: "sessions",
  min: 2,
  fallback: 32,
});
const lists = parseStrictIntegerOption({
  raw: values.lists,
  label: "lists",
  min: 1,
  fallback: 100,
});
assert(sessions <= 200 && lists <= 1000);
const configPath = path.join(root, "openclaw.json");
type Snapshot = {
  cpu: NodeJS.CpuUsage;
  metrics: ReturnType<typeof getSessionRowSelectionMetrics>["materialization"];
};

if (values.child) {
  assert(typeof process.send === "function", "private controller IPC required");
  const { startGatewayServer } = await import("../../src/gateway/server.ts");
  const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  process.on("message", (message) => {
    if (message === "snapshot") {
      process.send?.({
        cpu: process.threadCpuUsage(),
        metrics: getSessionRowSelectionMetrics().materialization,
      });
    } else if (message === "stop") {
      void server.close().then(() => process.disconnect?.());
    }
  });
  process.send({ ready: true, availableParallelism: availableParallelism() });
} else {
  await measure();
}

async function measure() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const provenance = {
    revision: execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    node: process.version,
    sourceHashes: Object.fromEntries(
      [
        "src/infra/gateway-work-metrics.ts",
        "src/gateway/session-row-projection-materialize.ts",
        "scripts/perf/session-row-materialization-measure.ts",
      ].map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(path.join(repoRoot, file)))
          .digest("hex"),
      ]),
    ),
  };
  mkdirSync(root); // Never adopt existing state.
  mkdirSync(path.join(root, "tmp"));
  const config = {
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
    plugins: { enabled: false },
    cron: { enabled: true },
  };
  writeFileSync(configPath, JSON.stringify(config));
  const child = fork(fileURLToPath(import.meta.url), [...process.argv.slice(2), "--child"], {
    cwd: repoRoot,
    env: createGatewayBenchEnv(path.join(root, "home"), configPath, {
      caseEnv: {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        TMPDIR: path.join(root, "tmp"),
      },
    }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const readyReply = once(child, "message", { signal: AbortSignal.timeout(120_000) });
  let log: ReturnType<typeof createWriteStream> | undefined;
  let peer: ReturnType<typeof createGatewayWsClient> | undefined;
  const phases: unknown[] = [];
  const failures: string[] = [];
  const snapshot = async (): Promise<Snapshot> => {
    const reply = once(child, "message", { signal: AbortSignal.timeout(60_000) });
    child.send("snapshot");
    return (await reply)[0] as Snapshot;
  };
  try {
    log = createWriteStream(path.join(root, "gateway.log"));
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    const [ready] = await readyReply;
    assert(isRecord(ready) && ready.ready === true);
    const probeStart = performance.now();
    const readiness = await waitForInitialProbe({
      port,
      path: "/readyz",
      startAt: probeStart,
      deadlineAt: probeStart + 120_000,
      isDone: () => child.exitCode !== null || child.signalCode !== null,
    });
    assert.equal(readiness.status, 200, "Gateway admission did not become ready");
    peer = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    await peer.waitOpen();
    const rpc = async (method: string, params: unknown) => {
      const response = await peer!.request(method, params, 60_000);
      assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
      return response.payload;
    };
    await rpc("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "gateway-client", version: "dev", platform: process.platform, mode: "backend" },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [],
    });
    const keys = Array.from({ length: sessions }, (_, i) => `agent:main:materialization-${i}`);
    for (const key of keys) {
      await rpc("sessions.create", {
        key,
        visibility: "shared",
        displayName: "Synthetic materialization",
      });
    }
    const job = await rpc("cron.add", {
      name: "Synthetic materialization",
      enabled: false,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "main",
      sessionKey: keys[0],
      agentId: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Synthetic materialization control" },
    });
    assert(isRecord(job) && typeof job.id === "string");
    const list = async () => {
      const response = await rpc("sessions.list", { limit: 200 });
      assert(isRecord(response) && Array.isArray(response.sessions));
      const rows = response.sessions.filter(isRecord);
      assert(
        keys.every((key) => rows.some((row) => row.key === key)),
        "fixture rows missing",
      );
      return rows.find((row) => row.key === keys[0])!;
    };
    await list();
    const phase = async (
      name: string,
      mutate?: () => Promise<unknown>,
      expected?: { hasAutomation?: boolean; label?: string },
    ) => {
      const before = await snapshot();
      const start = performance.now();
      await mutate?.();
      const latencies: number[] = [];
      for (let i = 0; i < lists; i++) {
        const at = performance.now();
        const row = await list();
        latencies.push(performance.now() - at);
        if (expected?.hasAutomation !== undefined) {
          assert.equal(Boolean(row.hasAutomation), expected.hasAutomation);
        }
        if (expected?.label !== undefined) {
          assert.equal(row.label, expected.label);
        }
      }
      const after = await snapshot();
      const materialization = Object.fromEntries(
        (["created", "reused", "rebuilt", "skipped", "deepComparisons"] as const).map((key) => [
          key,
          after.metrics[key] - before.metrics[key],
        ]),
      );
      const sampledFirstDifferences = Object.fromEntries(
        Object.entries(after.metrics.sampledFirstDifferences)
          .map(([key, count]) => [key, count - (before.metrics.sampledFirstDifferences[key] ?? 0)])
          .filter(([, count]) => count !== 0),
      );
      const mainCpuMs =
        (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000;
      phases.push({
        name,
        lists,
        elapsedMs: performance.now() - start,
        mainCpuMs,
        mainCpuMsPerList: mainCpuMs / lists,
        cpuScope: "Gateway main thread including phase mutation and background work",
        listMs: summarizeNumbers(latencies),
        materialization: { ...materialization, sampledFirstDifferences },
      });
    };
    await phase("ordinary-lists");
    await phase(
      "cron-rename-no-membership-change",
      () => rpc("cron.update", { id: job.id, patch: { name: "Synthetic renamed" } }),
      { hasAutomation: false },
    );
    await phase("cron-enable", () => rpc("cron.update", { id: job.id, patch: { enabled: true } }), {
      hasAutomation: true,
    });
    await phase(
      "cron-disable",
      () => rpc("cron.update", { id: job.id, patch: { enabled: false } }),
      { hasAutomation: false },
    );
    await phase(
      "label-change",
      () => rpc("sessions.patch", { key: keys[0], label: "Synthetic changed label" }),
      { label: "Synthetic changed label" },
    );
    await phase(
      "label-noop",
      () => rpc("sessions.patch", { key: keys[0], label: "Synthetic changed label" }),
      { label: "Synthetic changed label" },
    );
    writeFileSync(
      path.join(root, "result.json"),
      JSON.stringify({ provenance, host: ready, readiness, sessions, phases, failures }, null, 2),
    );
  } catch (error) {
    failures.push(String(error));
    writeFileSync(
      path.join(root, "failure.json"),
      JSON.stringify({ provenance, phases, failures }, null, 2),
    );
    throw error;
  } finally {
    peer?.close();
    if (child.connected) {
      const closed = once(child, "close", { signal: AbortSignal.timeout(10_000) });
      child.send("stop");
      await closed.catch(() => stopChild(child));
    } else {
      await stopChild(child);
    }
    log?.end();
  }
}
