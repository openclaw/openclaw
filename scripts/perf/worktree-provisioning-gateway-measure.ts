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
 * --fixture dependencies seeds 65,880 selected dependency files with the literal
 * .env.local, .convex/, node_modules/ include and nested .artifacts dependencies.
 * Guarded-to-batched acceptance: provisionCopy <10s, >=5x owner wall/allocation.
 * Resident-parent follow-up: provisionCopy <10s, >=5x owner wall/parent spawns,
 * no >20% CPU/allocation regression.
 * Compare the first 100 concurrent probes at matched request count; full-window
 * probe tails also remain recorded but span very different preparation durations.
 * --dependency-proof verifies that shape and its creation ledger on later runs;
 * --ledger-snapshot ordinary|exact also verifies the later mode/chunks ledger.
 * --resident-gib 8 retains touched memory only in the Gateway main process and
 * forwards NODE_OPTIONS, LD_PRELOAD and MALLOC_CONF for service-runtime proofs.
 * --advance-commit is only for a disposable synthetic repository. It commits a
 * new tracked marker after warmup and before each measured preparation, exercising
 * warm templates with commit-changed misses. Never pass an operator checkout.
 * --watcher-snapshots <dir> records native watch paths and post-GC main snapshots
 * before churn, with each session/worktree active, and after retirement. The same
 * agent stays live; --watcher-agent-churn separately exercises agent retirement.
 * This adds 1,000 skill reference directories to generated fixtures. Use
 * --session-churn 200 for 1,200 create/delete cycles with the default six passes.
 * Acceptance: after warmup, retired FSWatcher counts stay flat across passes;
 * repeated readers of one root do not create duplicate native registrations.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
} from "../../src/agents/worktrees/registry-read.js";
import { drainGlobalSingletonLifecycleState } from "../../src/shared/global-singleton.js";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayCpuUsage,
  readGatewayHeapProfile,
  startGatewayDiagnostics,
} from "../lib/gateway-bench-profile.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import {
  dependencyFixturePaths,
  seedDependencyFixture,
  verifyDependencyFixture,
} from "./worktree-provisioning-dependency-fixture.js";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    output: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    samples: { type: "string", default: "5" },
    port: { type: "string", default: "40980" },
    fixture: { type: "string" },
    "dependency-proof": { type: "boolean", default: false },
    "ledger-snapshot": { type: "string" },
    "verify-fixture": { type: "boolean", default: false },
    acceleration: { type: "boolean", default: false },
    profile: { type: "string" },
    "state-dir": { type: "string" },
    "skip-warmup": { type: "boolean", default: false },
    retain: { type: "boolean", default: false },
    "watcher-snapshots": { type: "string" },
    "session-churn": { type: "string", default: "0" },
    "watcher-agent-churn": { type: "boolean", default: false },
    "resident-gib": { type: "string" },
    "advance-commit": { type: "boolean", default: false },
  },
});
assert(values.repo && values.output, "--repo and --output are required");
assert(!values.profile || ["cpu", "heap"].includes(values.profile));
assert(!values["ledger-snapshot"] || ["ordinary", "exact"].includes(values["ledger-snapshot"]));
assert(!values["ledger-snapshot"] || !values.retain);
assert(!values["advance-commit"] || (values.acceleration && !values["skip-warmup"]));
const residentGiB = Number(values["resident-gib"] ?? 0);
assert(Number.isSafeInteger(residentGiB) && residentGiB >= 0 && residentGiB <= 16);
if (values.fixture) {
  assert(["source", "included", "dependencies"].includes(values.fixture));
  await fs.mkdir(path.resolve(values.repo), { mode: 0o700 });
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
  for (
    let directory = 0;
    directory < (values.fixture === "dependencies" ? 120 : 620);
    directory++
  ) {
    const root = path.join(fixture, directory < 120 ? "source" : "prepared", String(directory));
    await fs.mkdir(root, { recursive: true });
    for (let file = 0; file < 100; file++) {
      bytes.writeUInt32LE(directory * 100 + file, 0);
      await fs.writeFile(path.join(root, `${file}.bin`), bytes);
    }
  }
  if (values.fixture === "dependencies") {
    await seedDependencyFixture(fixture);
  }
  if (values.fixture === "included") {
    await fs.writeFile(path.join(fixture, ".gitignore"), "prepared/\n");
    await fs.writeFile(path.join(fixture, ".worktreeinclude"), "prepared/**\n");
  }
  if (values["watcher-snapshots"]) {
    const skill = path.join(fixture, "skills", "synthetic-watch");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: synthetic-watch\ndescription: Synthetic watcher fixture.\n---\nSynthetic instructions.\n",
    );
    for (let index = 0; index < 1000; index++) {
      const directory = path.join(skill, "references", String(index));
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "fixture.txt"), "synthetic\n");
    }
  }
  git("add", ".");
  git("commit", "-m", "Synthetic 62000-file provisioning fixture");
}
const repo = await fs.realpath(values.repo);
const output = path.resolve(values.output);
const dependencyProof = values.fixture === "dependencies" || values["dependency-proof"];
assert(!values["ledger-snapshot"] || dependencyProof);
const stateDirectory = path.resolve(values["state-dir"] ?? path.join(output, "state"));
const registryEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDirectory };
const samples = Number(values.samples);
const sessionChurn = Number(values["session-churn"]);
assert(Number.isSafeInteger(sessionChurn) && sessionChurn >= 0);
const port = Number(values.port);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(port) && port >= 40000 && port <= 65535);
await fs.mkdir(output, { mode: 0o700 });
await fs.mkdir(path.join(output, "tmp"), { mode: 0o700 });
const probe = createServer();
await new Promise<void>((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", resolve);
});
await new Promise<void>((resolve, reject) => {
  probe.close((error) => (error ? reject(error) : resolve()));
});
const configPath = path.join(output, "openclaw.json");
const config = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  agents: {
    defaults: { workspace: repo, ...(values["watcher-snapshots"] ? { skipBootstrap: true } : {}) },
  },
  plugins: { enabled: false },
  worktreeAcceleration: values.acceleration,
  logging: { level: "info", consoleLevel: "info", file: path.join(output, "runtime.log") },
};
const mockPort = values["watcher-snapshots"] ? await getFreePort() : undefined;
if (mockPort) {
  applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-4.1" });
}
await fs.writeFile(configPath, JSON.stringify(config));
const residentPreload = path.join(output, "resident-memory.mjs");
if (residentGiB) {
  await fs.writeFile(
    residentPreload,
    `
import { isMainThread } from "node:worker_threads";
if (isMainThread && process.env.OPENCLAW_BENCH_RESIDENT_GIB) {
  const gib = Number(process.env.OPENCLAW_BENCH_RESIDENT_GIB);
  delete process.env.OPENCLAW_BENCH_RESIDENT_GIB;
  const memory = Array.from({ length: gib }, () => Buffer.alloc(1024 ** 3, 120));
  process.once("exit", () => {
    if (memory.some((bytes) => bytes[0] !== 120)) throw new Error("Resident fixture changed");
  });
}
`,
  );
}
const mock = mockPort
  ? spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MOCK_PORT: String(mockPort) },
    })
  : undefined;
const trace = path.join(output, "git-trace.jsonl");
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(path.resolve(values.entry), port, [
    ...(residentGiB ? ["--import", residentPreload] : []),
    ...(values["watcher-snapshots"]
      ? ["--expose-gc", "--import", path.resolve("scripts/perf/fswatcher-retention-preload.mjs")]
      : []),
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
        OPENCLAW_STATE_DIR: stateDirectory,
        OPENCLAW_PROFILE: `provisioning-${port}`,
        OPENCLAW_SKIP_CHANNELS: "1",
        TMPDIR: path.join(output, "tmp"),
        GIT_TRACE2_EVENT: trace,
        DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
        ...(mockPort ? { OPENAI_API_KEY: "synthetic-localhost-fixture" } : {}),
        ...(residentGiB ? { OPENCLAW_BENCH_RESIDENT_GIB: String(residentGiB) } : {}),
        ...(values["resident-gib"] === undefined
          ? {}
          : Object.fromEntries(
              ["NODE_OPTIONS", "LD_PRELOAD", "MALLOC_CONF"].flatMap((key) =>
                process.env[key] === undefined ? [] : [[key, process.env[key]]],
              ),
            )),
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
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 180_000,
  });
  assert.equal(ready.status, 200, "Gateway readiness timed out");
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  await client.waitOpen();
  const rpc = async (method: string, params: unknown) => {
    const response = await client!.request(method, params, 600_000);
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
  const concurrentKey = `agent:main:provision-probe-${randomUUID()}`;
  await rpc("sessions.create", { key: concurrentKey, agentId: "main", worktree: false });
  await rpc("chat.history", { sessionKey: concurrentKey, limit: 1 });
  const watcherCensus = async (phase: string) => {
    if (!values["watcher-snapshots"]) {
      return;
    }
    const directory = path.resolve(values["watcher-snapshots"]);
    await fs.mkdir(directory, { recursive: true });
    const snapshot = path.join(directory, `${phase}.heapsnapshot`);
    const reply = Promise.withResolvers<unknown>();
    const receive = (message: { channel?: string; snapshot?: string }) => {
      if (message.channel === "fswatcher-retention" && message.snapshot === snapshot) {
        gateway.off("message", receive);
        reply.resolve(message);
      }
    };
    gateway.on("message", receive);
    gateway.send({ channel: "fswatcher-retention", snapshot });
    const timeout = setTimeout(() => reply.reject(new Error("Watcher census timed out")), 120_000);
    try {
      const census = await reply.promise;
      await fs.writeFile(path.join(directory, `${phase}.json`), JSON.stringify(census, null, 2));
    } finally {
      clearTimeout(timeout);
      gateway.off("message", receive);
    }
  };
  if (values["watcher-snapshots"]) {
    await rpc("skills.status", { agentId: "main" });
  }
  await watcherCensus("baseline");
  const rows = [];
  const commitMarker = `.provision-benchmark-${randomUUID()}`;
  for (let index = values["skip-warmup"] ? 1 : 0; index <= samples; index++) {
    if (values["advance-commit"] && index > 0) {
      await fs.writeFile(path.join(repo, commitMarker), `Synthetic preparation ${index}\n`);
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Synthetic Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-C",
            repo,
            ...args,
          ],
          { stdio: "ignore" },
        );
      git("add", "--", commitMarker);
      git("commit", "-m", `Synthetic provisioning commit ${index}`);
    }
    const loadBefore = loadavg();
    const profile = values.profile as "cpu" | "heap" | undefined;
    const profilePath = path.join(
      output,
      `sample-${index}.${profile === "cpu" ? "cpuprofile" : "heapprofile"}`,
    );
    if (profile) {
      await controlGatewayProfile(gateway, profile, "start", profilePath, {
        includeCollectedObjects: true,
        includeWorkers: true,
      });
    }
    const cpuBefore = await readGatewayCpuUsage(gateway);
    const stopDiagnostics = profile ? undefined : await startGatewayDiagnostics(gateway);
    const concurrentRpcMs: number[] = [];
    const probeController = new AbortController();
    const probeSession = (async () => {
      while (!probeController.signal.aborted) {
        const sent = performance.now();
        await rpc("chat.history", { sessionKey: concurrentKey, limit: 1 });
        concurrentRpcMs.push(performance.now() - sent);
        await delay(50);
      }
    })();
    const started = performance.now();
    let record: unknown;
    let elapsedMs: number;
    try {
      record = await rpc("worktrees.create", {
        repoRoot: repo,
        baseRef: "HEAD",
        name: `measure-${randomUUID()}`,
      });
    } finally {
      elapsedMs = performance.now() - started;
      probeController.abort();
      await probeSession;
    }
    const cpu = measureGatewayCpuUsage(cpuBefore, await readGatewayCpuUsage(gateway));
    const diagnostics = await stopDiagnostics?.();
    if (profile) {
      await controlGatewayProfile(gateway, profile, "stop", profilePath);
    }
    assert(isRecord(record) && typeof record.id === "string" && typeof record.path === "string");
    const churnAgentId = values["watcher-agent-churn"] ? `watch-churn-${index}` : "main";
    if (values["watcher-agent-churn"]) {
      await rpc("agents.create", { name: churnAgentId, workspace: record.path, onboarding: false });
      await rpc("skills.status", { agentId: churnAgentId });
    }
    if (values["watcher-snapshots"]) {
      const sessionKey = `agent:${churnAgentId}:watch-turn-${randomUUID()}`;
      await rpc("sessions.create", {
        key: sessionKey,
        agentId: churnAgentId,
        cwd: record.path,
        worktree: false,
      });
      const turn = await rpc("chat.send", {
        sessionKey,
        message: "Reply with synthetic watcher proof.",
        idempotencyKey: randomUUID(),
      });
      assert(isRecord(turn) && typeof turn.runId === "string");
      const settled = await rpc("agent.wait", { runId: turn.runId, timeoutMs: 100_000 });
      assert(isRecord(settled) && settled.status === "ok", JSON.stringify(settled));
      await watcherCensus(`active-${index}`);
      await rpc("sessions.delete", { key: sessionKey });
    }
    for (let sessionIndex = 0; sessionIndex < sessionChurn; sessionIndex++) {
      const key = `agent:${churnAgentId}:watch-churn-${randomUUID()}`;
      await rpc("sessions.create", { key, agentId: churnAgentId, worktree: false });
      await rpc("sessions.delete", { key });
    }
    if (values["watcher-agent-churn"]) {
      await rpc("agents.delete", { agentId: churnAgentId, deleteFiles: false });
    }
    const row = {
      warmup: index === 0,
      elapsedMs,
      cpu,
      concurrentRpcMs,
      diagnostics,
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
    if (dependencyProof) {
      await verifyDependencyFixture(record.path);
      const expectedPaths = dependencyFixturePaths().toSorted();
      assert.deepEqual(
        await getRegistryWorktreeProvisionedPaths(registryEnv, record.id),
        expectedPaths,
      );
      assert.equal(await getRegistryWorktreeProvisionedState(registryEnv, record.id), undefined);
      const extents = execFileSync(
        "btrfs",
        ["filesystem", "du", "-s", "--raw", repo, record.path],
        { encoding: "utf8" },
      );
      console.log(
        JSON.stringify({
          verifiedFiles: expectedPaths.length,
          ledger: "creation-path-strings",
          extents,
        }),
      );
    }
    if (values.fixture || values["verify-fixture"]) {
      for (let directory = 0; directory < (dependencyProof ? 120 : 620); directory++) {
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
      console.log(JSON.stringify({ verifiedTrackedFiles: dependencyProof ? 12_000 : 62_000 }));
    }
    if (values.retain) {
      console.log(JSON.stringify({ retained: { id: record.id, path: record.path } }));
      continue;
    }
    // The task-owned fixture is disposable; snapshot failures remain in the log.
    const worktreePath = record.path;
    const branch = record.branch;
    assert(typeof branch === "string");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" }).trim();
    if (values["ledger-snapshot"] === "exact") {
      git("checkout", "--detach", "HEAD");
    }
    const exactState =
      values["ledger-snapshot"] === "exact"
        ? {
            ownerKind: record.ownerKind,
            ownerId: record.ownerId,
            createdAt: record.createdAt,
            lastActiveAt: record.lastActiveAt,
            head: git("rev-parse", "HEAD"),
            branchHead: git("rev-parse", `refs/heads/${branch}`),
            indexSha256: createHash("sha256")
              .update(
                await fs.readFile(
                  path.resolve(record.path, git("rev-parse", "--git-path", "index")),
                ),
              )
              .digest("hex"),
          }
        : undefined;
    const removed = await rpc("worktrees.remove", {
      id: record.id,
      ...(exactState ? { exactState } : { force: !values["ledger-snapshot"] }),
    });
    console.log(JSON.stringify({ cleanup: removed }));
    assert(
      isRecord(removed) && removed.removed === true,
      `Fixture cleanup failed: ${JSON.stringify(removed)}`,
    );
    if (values["ledger-snapshot"]) {
      assert(isRecord(removed) && removed.snapshotRef && !removed.snapshotError);
      const states = await getRegistryWorktreeProvisionedState(registryEnv, record.id);
      assert(states);
      const expected = dependencyFixturePaths().filter(
        (file) => exactState || !/(^|\/)node_modules\//u.test(file),
      );
      assert.deepEqual(states.map((state) => state.path).toSorted(), expected.toSorted());
      assert(states.every((state) => state.chunks === 1 && state.mode !== null));
      console.log(
        JSON.stringify({
          ledger: "snapshot-mode-chunks",
          kind: values["ledger-snapshot"],
          files: states.length,
        }),
      );
    }
    await delay(250);
    await watcherCensus(`retired-${index}`);
  }
  const sorted = rows
    .filter((row) => !row.warmup)
    .map((row) => row.elapsedMs)
    .toSorted((a, b) => a - b);
  const result = {
    repo,
    residentGiB,
    advanceCommit: values["advance-commit"],
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
  if (mock) {
    await stopChild(mock);
  }
  log.end();
  await drainGlobalSingletonLifecycleState();
}
