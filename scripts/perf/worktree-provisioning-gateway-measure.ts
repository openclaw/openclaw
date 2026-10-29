/**
 * Native provisioning through an isolated built Gateway, never an existing server.
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-provisioning-gateway-measure.ts
 *   --repo <task-owned-public-clone> --output <new-dir> [--entry dist/entry.js] [--samples 5]
 * The clone must already contain the desired .worktreeinclude fixture. Run the
 * same repository and sample count for each built revision. Fresh destinations;
 * one warmup excluded. RPC wall time includes admission, checkout and provisioning.
 * Gateway logs retain the owner's inclusive preparation phases. Git Trace2 logs
 * distinguish native command costs. Cleanup runs outside the measured interval.
 * Acceptance: identical selected files, fewer unused source inspections, lower
 * owner CPU/allocation without a material provisioning latency regression.
 * Five-sample p95 is descriptive, not a tail gate. No model or whole-Gateway load.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    output: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    samples: { type: "string", default: "5" },
    port: { type: "string", default: "40980" },
  },
});
assert(values.repo && values.output, "--repo and --output are required");
const repo = await fs.realpath(values.repo);
const output = path.resolve(values.output);
const samples = Number(values.samples);
const port = Number(values.port);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(port) && port >= 40000 && port <= 65535);
await fs.mkdir(output);
await fs.mkdir(path.join(output, "tmp"));
const probe = createServer();
await new Promise<void>((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", resolve);
});
await new Promise<void>((resolve, reject) => {
  probe.close((error) => (error ? reject(error) : resolve()));
});
const configPath = path.join(output, "openclaw.json");
await fs.writeFile(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: { defaults: { workspace: repo } },
    plugins: { enabled: false },
    worktreeAcceleration: false,
    logging: { level: "info", consoleLevel: "info", file: path.join(output, "runtime.log") },
  }),
);
const trace = path.join(output, "git-trace.jsonl");
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(path.resolve(values.entry), port),
  {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: createGatewayBenchEnv(path.join(output, "home"), configPath, {
      startupTrace: false,
      caseEnv: {
        OPENCLAW_STATE_DIR: path.join(output, "state"),
        OPENCLAW_PROFILE: `provisioning-${port}`,
        OPENCLAW_SKIP_CHANNELS: "1",
        TMPDIR: path.join(output, "tmp"),
        GIT_TRACE2_EVENT: trace,
        DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
      },
    }),
  },
);
const log = createWriteStream(path.join(output, "gateway.log"));
gateway.stdout.pipe(log);
gateway.stderr.pipe(log);
let client: ReturnType<typeof createGatewayWsClient> | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Gateway startup timed out")), 120_000);
    const observe = (chunk: Buffer) => {
      if (chunk.toString().includes("http server listening (")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    gateway.stdout.on("data", observe);
    gateway.stderr.on("data", observe);
    gateway.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Gateway exited ${code}`));
    });
  });
  const readyDeadline = Date.now() + 120_000;
  for (;;) {
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    await ready.arrayBuffer();
    if (ready.ok) {
      break;
    }
    assert(Date.now() < readyDeadline, "Gateway readiness timed out");
    await delay(250);
  }
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  await client.waitOpen();
  const rpc = async (method: string, params: unknown) => {
    const response = await client!.request(method, params, 300_000);
    assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
    return response.payload;
  };
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "synthetic-worktree-measurement",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
  });
  const rows = [];
  for (let index = 0; index <= samples; index++) {
    const loadBefore = loadavg();
    const started = performance.now();
    const record = await rpc("worktrees.create", {
      repoRoot: repo,
      baseRef: "HEAD",
      name: `measure-${randomUUID()}`,
    });
    const elapsedMs = performance.now() - started;
    assert(isRecord(record) && typeof record.id === "string" && typeof record.path === "string");
    const row = { warmup: index === 0, elapsedMs, loadBefore, loadAfter: loadavg() };
    rows.push(row);
    console.log(JSON.stringify(row));
    // The task-owned fixture is disposable; snapshot failures remain in the log.
    const removed = await rpc("worktrees.remove", { id: record.id, force: true });
    console.log(JSON.stringify({ cleanup: removed }));
    assert(
      isRecord(removed) && removed.removed === true,
      `Fixture cleanup failed: ${JSON.stringify(removed)}`,
    );
  }
  const sorted = rows
    .slice(1)
    .map((row) => row.elapsedMs)
    .toSorted((a, b) => a - b);
  const result = {
    repo,
    entry: path.resolve(values.entry),
    samples,
    rows,
    p50Ms: sorted[Math.ceil(samples * 0.5) - 1],
    p95Ms: sorted[Math.ceil(samples * 0.95) - 1],
  };
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  client?.close();
  await stopChild(gateway, { teardownGraceMs: 10_000 });
  log.end();
}
