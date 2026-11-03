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
 * --fixture source|included creates a NEW synthetic repository with 62,000 files
 * of 20,000 bytes each. Included mode tracks 12,000 and provisions 50,000 files;
 * neither mode installs dependencies or runs a setup script. --verify-fixture
 * checks every payload after readiness, outside timing. --acceleration enables
 * native source templates. Alternate built --entry revisions in separate runs;
 * --profile cpu|heap records the Gateway itself (heap includes collected objects).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayCpuUsage,
  readGatewayHeapProfile,
} from "../lib/gateway-bench-profile.ts";
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
    fixture: { type: "string" },
    "verify-fixture": { type: "boolean", default: false },
    acceleration: { type: "boolean", default: false },
    profile: { type: "string" },
    "state-dir": { type: "string" },
    "skip-warmup": { type: "boolean", default: false },
    retain: { type: "boolean", default: false },
  },
});
assert(values.repo && values.output, "--repo and --output are required");
assert(!values.profile || ["cpu", "heap"].includes(values.profile));
if (values.fixture) {
  assert(["source", "included"].includes(values.fixture));
  await fs.mkdir(path.resolve(values.repo));
  const fixture = path.resolve(values.repo);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", fixture, ...args],
      { stdio: "ignore" },
    );
  git("init", "-b", "main");
  git("config", "user.name", "Synthetic Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "maintenance.auto", "false");
  const bytes = Buffer.alloc(20_000, 120);
  for (let directory = 0; directory < 620; directory++) {
    const root = path.join(fixture, directory < 120 ? "source" : "prepared", String(directory));
    await fs.mkdir(root, { recursive: true });
    for (let file = 0; file < 100; file++) {
      bytes.writeUInt32LE(directory * 100 + file, 0);
      await fs.writeFile(path.join(root, `${file}.bin`), bytes);
    }
  }
  if (values.fixture === "included") {
    await fs.writeFile(path.join(fixture, ".gitignore"), "prepared/\n");
    await fs.writeFile(path.join(fixture, ".worktreeinclude"), "prepared/**\n");
  }
  git("add", ".");
  git("commit", "-m", "Synthetic 62000-file provisioning fixture");
}
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
    worktreeAcceleration: values.acceleration,
    logging: { level: "info", consoleLevel: "info", file: path.join(output, "runtime.log") },
  }),
);
const trace = path.join(output, "git-trace.jsonl");
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(path.resolve(values.entry), port, [
    "--import",
    path.resolve("scripts/tsx.mjs"),
    "--import",
    path.resolve("scripts/lib/gateway-bench-profile-preload.ts"),
  ]),
  {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
    env: createGatewayBenchEnv(path.join(output, "home"), configPath, {
      startupTrace: false,
      caseEnv: {
        OPENCLAW_STATE_DIR: path.resolve(values["state-dir"] ?? path.join(output, "state")),
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
const { stdout, stderr } = gateway;
assert(stdout && stderr, "Gateway must expose its piped output");
stdout.pipe(log);
stderr.pipe(log);
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
    stdout.on("data", observe);
    stderr.on("data", observe);
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
  for (let index = values["skip-warmup"] ? 1 : 0; index <= samples; index++) {
    const loadBefore = loadavg();
    const profile = values.profile as "cpu" | "heap" | undefined;
    const profilePath = path.join(
      output,
      `sample-${index}.${profile === "cpu" ? "cpuprofile" : "heapprofile"}`,
    );
    if (profile) {
      await controlGatewayProfile(gateway, profile, "start", profilePath, {
        includeCollectedObjects: true,
      });
    }
    const cpuBefore = await readGatewayCpuUsage(gateway);
    const started = performance.now();
    const record = await rpc("worktrees.create", {
      repoRoot: repo,
      baseRef: "HEAD",
      name: `measure-${randomUUID()}`,
    });
    const elapsedMs = performance.now() - started;
    const cpu = measureGatewayCpuUsage(cpuBefore, await readGatewayCpuUsage(gateway));
    if (profile) {
      await controlGatewayProfile(gateway, profile, "stop", profilePath);
    }
    assert(isRecord(record) && typeof record.id === "string" && typeof record.path === "string");
    const row = {
      warmup: index === 0,
      elapsedMs,
      cpu,
      loadBefore,
      loadAfter: loadavg(),
      ...(profile === "heap"
        ? {
            sampledAllocatedBytes: readGatewayHeapProfile(profilePath, {
              includeCollectedObjects: true,
            }).sampledAllocatedBytes,
          }
        : {}),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    if (values.fixture || values["verify-fixture"]) {
      for (let directory = 0; directory < 620; directory++) {
        const relative = path.join(directory < 120 ? "source" : "prepared", String(directory));
        assert.equal((await fs.readdir(path.join(record.path, relative))).length, 100);
        for (let file = 0; file < 100; file++) {
          const target = path.join(record.path, relative, `${file}.bin`);
          const actual = await fs.readFile(target);
          const expected = Buffer.alloc(20_000, 120);
          expected.writeUInt32LE(directory * 100 + file, 0);
          assert.deepEqual(actual, expected, target);
        }
      }
      console.log(JSON.stringify({ verifiedFiles: 62_000, verifiedBytes: 1_240_000_000 }));
    }
    if (values.retain) {
      console.log(JSON.stringify({ retained: { id: record.id, path: record.path } }));
      continue;
    }
    // The task-owned fixture is disposable; snapshot failures remain in the log.
    const removed = await rpc("worktrees.remove", { id: record.id, force: true });
    console.log(JSON.stringify({ cleanup: removed }));
    assert(
      isRecord(removed) && removed.removed === true,
      `Fixture cleanup failed: ${JSON.stringify(removed)}`,
    );
  }
  const sorted = rows
    .filter((row) => !row.warmup)
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
