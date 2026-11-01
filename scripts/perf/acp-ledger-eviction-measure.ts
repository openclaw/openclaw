/** Synthetic ACP stdio -> Gateway flow; observe both processes and their workers. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../src/state/openclaw-state-db.js";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    samples: { type: "string", default: "1" },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert(values.out && values.observer, "--out and --observer are required");
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
const out = path.resolve(values.out);
mkdirSync(out, { recursive: true });
const entry = path.resolve(values.entry);
const children: ChildProcess[] = [];
const phases: Array<{ phase: string; elapsedMs: number }> = [];
function phase(name: string) {
  writeFileSync(path.join(out, "phase"), name);
}
function launch(args: string[], env: NodeJS.ProcessEnv, name: string) {
  const log = createWriteStream(path.join(out, `${name}.log`));
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    detached: true,
  });
  child.stderr?.pipe(log);
  children.push(child);
  return { child, log };
}
const profiles = values["cpu-profile"] ? path.join(out, "profiles") : undefined;
const observed = {
  SQLMEASURE_OUT: out,
  NODE_OPTIONS: `--require=${path.resolve(values.observer)} --enable-source-maps`,
};
try {
  phase("boot");
  const root = path.join(out, "gateway");
  mkdirSync(path.join(root, "workspace"), { recursive: true });
  const port = await getFreePort();
  const token = "synthetic-acp-ledger-benchmark";
  const cfg = {
    ...BASE_GATEWAY_BENCH_CONFIG,
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      port,
      auth: { mode: "token", token },
    },
  };
  const configPath = writeGatewayBenchConfig(root, cfg, {
    agentList: [{ id: "main", workspace: path.join(root, "workspace") }],
  });
  const { child: gateway, log } = launch(
    buildGatewayBenchChildArgs(entry, port, gatewayBenchCpuProfileArgs(profiles), "token"),
    { ...createGatewayBenchEnv(root, configPath, {}), ...observed },
    "gateway",
  );
  gateway.stdout?.pipe(log);
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway unavailable");
  for (let sample = 0; sample < samples; sample++) {
    phase(`fixture-${sample}`);
    const bridgeRoot = path.join(out, `bridge-${sample}`);
    mkdirSync(path.join(bridgeRoot, "state", "state"), { recursive: true });
    const options = { path: path.join(bridgeRoot, "state", "state", "openclaw.sqlite") };
    const db = openOpenClawStateDatabase(options).db;
    const updateJson = JSON.stringify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "x".repeat(64 * 1024) },
    });
    runOpenClawStateWriteTransaction(() => {
      const session = db.prepare(
        "INSERT INTO acp_replay_sessions (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes) VALUES (?, ?, '', 1, 100, 100, 131, ?)",
      );
      const event = db.prepare(
        "INSERT INTO acp_replay_events (session_id, seq, at, session_key, run_id, update_json, estimated_bytes) VALUES (?, ?, 100, ?, NULL, ?, ?)",
      );
      const bytes = 34 + Buffer.byteLength(updateJson);
      for (const id of ["a", "b", "c"]) {
        session.run(id, id, 34 + 130 * bytes);
        for (let seq = 1; seq <= 130; seq++) {
          event.run(id, seq, id, updateJson, bytes);
        }
      }
    }, options);
    await closeOpenClawStateDatabaseAsync();
    phase(`bridge-start-${sample}`);
    const { child: bridge } = launch(
      [
        ...gatewayBenchCpuProfileArgs(profiles),
        entry,
        "acp",
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
      ],
      { ...createGatewayBenchEnv(bridgeRoot, configPath, {}), ...observed },
      `bridge-${sample}`,
    );
    assert(bridge.stdin && bridge.stdout);
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
      ndJsonStream(
        Writable.toWeb(bridge.stdin),
        Readable.toWeb(bridge.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    for (const name of ["cold-eviction", "warm-no-eviction"]) {
      phase(`${name}-${sample}`);
      const start = performance.now();
      const result = await connection.newSession({
        cwd: path.join(root, "workspace"),
        mcpServers: [],
      });
      assert(result.sessionId);
      phases.push({ phase: `${name}-${sample}`, elapsedMs: performance.now() - start });
    }
    phase(`bridge-close-${sample}`);
    bridge.stdin.end();
    await connection.closed;
    const stopped = await stopChild(bridge, { teardownGraceMs: 30_000 });
    assert.equal(stopped.exitCode, 0, "ACP shutdown failed");
    const retained = openOpenClawStateDatabase(options).db;
    assert.equal(
      retained.prepare("SELECT COUNT(*) AS n FROM acp_replay_sessions WHERE session_id = 'a'").get()
        ?.n,
      0,
    );
    assert.deepEqual(
      {
        ...retained
          .prepare(
            "SELECT MIN(seq) AS lo, MAX(seq) AS hi, COUNT(*) AS n FROM acp_replay_events WHERE session_id = 'b'",
          )
          .get(),
      },
      { lo: 65, hi: 130, n: 66 },
    );
    await closeOpenClawStateDatabaseAsync();
  }
  writeFileSync(path.join(out, "result.json"), JSON.stringify({ ok: true, phases }, null, 2));
} finally {
  phase("shutdown");
  await closeOpenClawStateDatabaseAsync();
  for (const child of children.toReversed()) {
    if (child.exitCode === null && child.signalCode === null) {
      await stopChild(child, { teardownGraceMs: 30_000 });
    }
  }
}
