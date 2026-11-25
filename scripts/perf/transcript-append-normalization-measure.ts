/**
 * Real SessionManager async appends to isolated SQLite, with synthetic payloads.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-append-normalization-measure.ts \
 *   --scratch <external-volume-dir> --output <result.json> --mode timing --operations 1000
 * --owners-dir overlays repo-relative source files at their canonical URLs; freeze
 * changed owners with git show before each arm. Run >=5 A/A and counterbalanced A/B
 * pairs externally. Separate timing, allocation, counts, and owner passes. Owner
 * Profile mode writes <output>.cpuprofile at 100 microsecond sampling. Owner
 * mode wraps normalization with thread CPU/performance clocks (diagnostic overhead).
 * Linux owner mode builds a tiny Node-API clock using cc and the runtime's headers:
 * getrusage-based threadCpuUsage updates too coarsely for individual normalizations.
 * --seed-database clones an offline checkpointed synthetic DB using a required reflink;
 * --workspace reuses an offline synthetic workspace. Neither seed is modified.
 * --batch-size requires the paired IPC controller; it alternates warmup and measured
 * batches without overlapping appends. Active wall excludes explicit controller waits.
 * Acceptance: identical persisted-message hash, reduced normalization visits and
 * allocation/CPU, no established material append regression. This is the append
 * owner path, not a whole Gateway or a production-size database/I/O benchmark.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, hash } from "node:crypto";
import { once } from "node:events";
import { constants, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { createRequire, registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.js";
import type { Message } from "../../src/llm/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "owners-dir": { type: "string" },
    scratch: { type: "string" },
    "seed-database": { type: "string" },
    workspace: { type: "string" },
    output: { type: "string" },
    mode: { type: "string", default: "timing" },
    fixture: { type: "string", default: "mixed" },
    history: { type: "string", default: "12" },
    "batch-size": { type: "string" },
    operations: { type: "string", default: "1000" },
    "payload-bytes": { type: "string", default: "16384" },
  },
});
assert(values.output && values.scratch, "--output and --scratch are required");
const mode = values.mode;
assert(
  mode === "timing" ||
    mode === "allocation" ||
    mode === "counts" ||
    mode === "owner" ||
    mode === "profile",
);
assert(["mixed", "plain", "reasoning", "signature", "media", "tools"].includes(values.fixture));
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const operations = integer(values.operations, "operations");
const batchSize = values["batch-size"] ? integer(values["batch-size"], "batch-size") : 0;
assert(
  !batchSize || (mode === "timing" && typeof process.send === "function"),
  "Batches require the timing IPC controller",
);
async function batchBarrier(phase: "warmup" | "measure", completed: number): Promise<number> {
  const started = performance.now();
  const next = once(process, "message");
  process.send!({ phase, completed });
  assert.equal((await next)[0], "continue");
  return performance.now() - started;
}
const payloadBytes = integer(values["payload-bytes"], "payload-bytes");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const counters: Record<string, number> = {};
const counterKey = Symbol.for("openclaw.bench.transcript-normalization");
Object.defineProperty(globalThis, counterKey, { value: counters, configurable: true });
const cpuClockKey = Symbol.for("openclaw.bench.transcript-cpu-clock");
Object.defineProperty(globalThis, cpuClockKey, {
  value: () => {
    const cpu = process.threadCpuUsage();
    return (cpu.user + cpu.system) / 1000;
  },
  configurable: true,
});
const owners = [
  "src/config/sessions/transcript-json.ts",
  "src/config/sessions/transcript-json-normalize.ts",
  "src/config/sessions/session-accessor.sqlite-transcript-message-append.ts",
  "src/agents/sessions/session-manager-persistence-entry.ts",
  "src/agents/transcript-sanitize.ts",
  "src/media/media-facts.ts",
  "src/agents/tool-search-transcript.ts",
].map((name) => {
  const original = pathToFileURL(path.join(repo, name));
  const frozen = values["owners-dir"] && path.resolve(values["owners-dir"], name);
  const source = frozen && existsSync(frozen) ? pathToFileURL(frozen) : original;
  return { name, original, source, sha256: hash("sha256", readFileSync(source)), loaded: false };
});
registerHooks({
  load(url, context, nextLoad) {
    const owner = owners.find((entry) => entry.original.href === url);
    if (!owner) {
      return nextLoad(url, context);
    }
    owner.loaded = true;
    const loaded = nextLoad(owner.source.href, context);
    if (
      (mode !== "counts" && mode !== "owner") ||
      !owner.name.endsWith("/transcript-json-normalize.ts")
    ) {
      return { ...loaded, shortCircuit: true };
    }
    assert(typeof loaded.source === "string", "The TypeScript loader must supply source text");
    let source = loaded.source;
    if (mode === "owner") {
      const declaration = "function normalizeTranscriptJsonValue(";
      assert(source.includes(declaration), "Cannot instrument normalization owner");
      source = source.replace(declaration, "function measuredNormalizeTranscriptJsonValue(");
      source += `
function normalizeTranscriptJsonValue(value, key) {
        const counters = globalThis[Symbol.for("openclaw.bench.transcript-normalization")];
        const clock = globalThis[Symbol.for("openclaw.bench.transcript-cpu-clock")];
        const cpu = clock();
        const start = performance.now();
        try { return measuredNormalizeTranscriptJsonValue(value, key); }
        finally {
          const wallMs = performance.now() - start;
          const used = clock() - cpu;
          counters.calls = (counters.calls || 0) + 1;
          counters.wallMs = (counters.wallMs || 0) + wallMs;
          counters.threadCpuMs = (counters.threadCpuMs || 0) + used;
        }
      }`;
    }
    for (const name of mode === "counts"
      ? ["normalizeTranscriptJsonValue", "normalizePlainJson", "requiresNativeJson"]
      : []) {
      const pattern = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{`);
      assert(pattern.test(source), `Cannot instrument ${name}`);
      source = source.replace(
        pattern,
        (declaration) =>
          `${declaration} { const c = globalThis[Symbol.for("openclaw.bench.transcript-normalization")]; c.${name} = (c.${name} || 0) + 1; }`,
      );
    }
    return { ...loaded, source, shortCircuit: true };
  },
});
const [
  { createOpenClawTestState },
  { upsertSessionEntryCore, loadTranscriptEvents },
  { SessionManager },
  { guardSessionManager },
  { toolAppendFixture },
  { setRuntimeConfigSnapshot },
] = await Promise.all([
  import("../../src/test-utils/openclaw-test-state.js"),
  import("../../src/config/sessions/session-accessor.js"),
  import("../../src/agents/sessions/session-manager.js"),
  import("../../src/agents/session-tool-result-guard-wrapper.js"),
  import("./transcript-append-tool-fixture.ts"),
  import("../../src/config/runtime-snapshot.js"),
]);
assert(
  owners.every((owner) => owner.loaded),
  "An owner was not loaded",
);
function fixture(index: number): Message {
  if (values.fixture === "tools") {
    return toolAppendFixture(index, payloadBytes);
  }
  const kind =
    values.fixture === "mixed"
      ? ["plain", "reasoning", "signature", "media"][index % 4]
      : values.fixture;
  const text = `Synthetic payload ${index}: `.padEnd(payloadBytes, "x");
  const content = [{ type: "text" as const, text }];
  const details = {
    records: Array.from({ length: 32 }, (_, row) => ({ row, label: text.slice(0, 128) })),
  };
  if (kind === "reasoning" || kind === "signature") {
    return {
      role: "assistant",
      content:
        kind === "signature"
          ? [
              {
                type: "thinking",
                thinking: "Synthetic reasoning",
                thinkingSignature: JSON.stringify({
                  id: "rs_synthetic",
                  type: "reasoning",
                  summary: [{ type: "summary_text", text: "Synthetic summary" }],
                }),
              },
              ...content,
            ]
          : content,
      api: "openai-responses",
      provider: "openai",
      model: "synthetic",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: index,
      providerReplay: {
        v: 1,
        type: "openai-responses-compaction",
        data: "synthetic-invalid-replay",
        provider: "openai",
        api: "openai-responses",
        model: "synthetic",
      },
    };
  }
  return {
    role: "toolResult",
    content,
    details,
    toolCallId: `synthetic-call-${index}`,
    toolName: "read",
    isError: false,
    timestamp: index,
    ...(kind === "media"
      ? index % 2
        ? { MediaPaths: ["/synthetic/media.png"], MediaTypes: ["image/png"] }
        : { __openclaw: { media: [{ path: "/synthetic/media.png", contentType: "image/png" }] } }
      : {}),
  };
}
function allocationBytes(
  node: HeapProfiler.SamplingHeapProfileNode,
  onlyOwner = false,
  inside = false,
): number {
  const selected = inside || node.callFrame.functionName === "normalizeTranscriptJsonValue";
  return (
    (!onlyOwner || selected ? node.selfSize : 0) +
    node.children.reduce((sum, child) => sum + allocationBytes(child, onlyOwner, selected), 0)
  );
}
await mkdir(path.resolve(values.scratch), { recursive: true });
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = path.resolve(values.scratch);
const state = await createOpenClawTestState({ label: "transcript-append-normalization" });
const inspector = mode === "allocation" || mode === "profile" ? new Session() : undefined;
try {
  if (mode === "owner" && process.platform === "linux") {
    const clockPath = state.path("thread-cpu-clock.node");
    execFileSync("cc", [
      "-O2",
      "-shared",
      "-fPIC",
      "-I",
      path.resolve(path.dirname(process.execPath), "../include/node"),
      fileURLToPath(new URL("./transcript-thread-cpu-clock.c", import.meta.url)),
      "-o",
      clockPath,
    ]);
    const clock: unknown = createRequire(import.meta.url)(clockPath);
    assert(typeof clock === "function", "Thread CPU clock must be callable");
    Object.defineProperty(globalThis, cpuClockKey, { value: clock, configurable: true });
  }
  // Keep the large synthetic seed within policy; this measures append, not eviction.
  const config: OpenClawConfig = {
    session: {
      maintenance: {
        maxEntries: 10_000,
        pruneAfter: "365d",
        archiveDashboardAfter: "365d",
        maxDiskBytes: 100 * 1024 ** 3,
      },
    },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  const target = {
    agentId: "main",
    sessionId: "synthetic-append",
    sessionKey: "agent:main:synthetic-append",
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
  };
  let seedDatabaseBytes = 0;
  if (values["seed-database"]) {
    const seed = path.resolve(values["seed-database"]);
    assert.equal(
      (await stat(`${seed}-wal`).catch(() => undefined))?.size ?? 0,
      0,
      "Seed must be closed and checkpointed",
    );
    seedDatabaseBytes = (await stat(seed)).size;
    await mkdir(path.dirname(target.storePath), { recursive: true });
    if (process.platform === "darwin") {
      execFileSync("/bin/cp", ["-c", seed, target.storePath]);
    } else {
      await copyFile(seed, target.storePath, constants.COPYFILE_FICLONE_FORCE);
    }
  }
  const workspace = values.workspace ? path.resolve(values.workspace) : state.workspaceDir;
  assert((await stat(workspace)).isDirectory(), "Workspace must exist");
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: Date.now() });
  const manager = await SessionManager.openAsync(target, workspace);
  if (values.fixture === "tools") {
    guardSessionManager(manager, { allowSyntheticToolResults: false });
  }
  await manager.appendMessageAsync({
    role: "user",
    content: "Synthetic append benchmark",
    timestamp: 0,
  });
  const warmup = integer(values.history, "history");
  if (batchSize) {
    await batchBarrier("warmup", 0);
  }
  for (let index = 0; index < warmup; index++) {
    await manager.appendMessageAsync(fixture(index));
    if (batchSize && ((index + 1) % batchSize === 0 || index + 1 === warmup)) {
      await batchBarrier("warmup", index + 1);
    }
  }
  const messages =
    values.fixture === "tools"
      ? undefined
      : Array.from({ length: operations }, (_, index) => fixture(index + warmup));
  globalThis.gc?.();
  for (const key of Object.keys(counters)) {
    delete counters[key];
  }
  inspector?.connect();
  if (inspector && mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (inspector && mode === "profile") {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.setSamplingInterval", { interval: 100 });
    await inspector.post("Profiler.start");
  }
  const latencies: number[] = [];
  if (batchSize) {
    await batchBarrier("measure", 0);
  }
  let controllerWaitMs = 0;
  const hostBefore = loadavg();
  const cpuBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < operations; index++) {
    const start = performance.now();
    // Include snapshot creation: transferring ownership must not hide producer work.
    const message = messages?.[index] ?? fixture(index + warmup);
    await manager.appendMessageAsync(message);
    latencies.push(performance.now() - start);
    if (batchSize && (index + 1) % batchSize === 0 && index + 1 < operations) {
      controllerWaitMs += await batchBarrier("measure", index + 1);
    }
  }
  const wallMs = performance.now() - started - controllerWaitMs;
  const threadCpu = process.threadCpuUsage(threadBefore);
  const cpu = process.cpuUsage(cpuBefore);
  const hostAfter = loadavg();
  const measuredCounters = { ...counters };
  if (batchSize) {
    // Keep readback and cleanup out of the peer's final measured batch.
    await batchBarrier("measure", operations);
  }
  const profile =
    inspector && mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  const cpuProfile =
    inspector && mode === "profile" ? (await inspector.post("Profiler.stop")).profile : undefined;
  const events = await loadTranscriptEvents(target);
  const persisted = events.filter(
    (event) => event && typeof event === "object" && "type" in event && event.type === "message",
  );
  assert.equal(persisted.length, warmup + operations + 1, "Every append must reach SQLite");
  const digest = createHash("sha256");
  for (const event of persisted.slice(-operations)) {
    assert(event && typeof event === "object" && "message" in event);
    digest.update(JSON.stringify(event.message));
    digest.update("\n");
  }
  for (const owner of owners) {
    assert.equal(
      hash("sha256", readFileSync(owner.source)),
      owner.sha256,
      "Owner changed during measurement",
    );
  }
  const sorted = latencies.toSorted((a, b) => a - b);
  const scale = 1000 / operations;
  const result = {
    scope:
      "SessionManager async append, isolated SQLite, synthetic payloads; main-isolate allocation",
    mode,
    ...(mode === "owner"
      ? {
          normalizationCpuClock:
            process.platform === "linux" ? "CLOCK_THREAD_CPUTIME_ID" : "process.threadCpuUsage",
        }
      : {}),
    fixture: values.fixture,
    operations,
    warmupOperations: warmup,
    ...(batchSize ? { batchSize, controllerWaitMs } : {}),
    payloadBytes,
    node: process.version,
    owners: owners.map(({ name, sha256 }) => ({ name, sha256 })),
    persistedMessageSha256: digest.digest("hex"),
    seedDatabaseBytes,
    maintenance: config.session?.maintenance,
    databaseBytes: (await stat(target.storePath)).size,
    walBytes: (await stat(`${target.storePath}-wal`).catch(() => undefined))?.size ?? 0,
    hostLoad: { before: hostBefore, after: hostAfter },
    wallMs,
    processCpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
    per1000: {
      wallMs: wallMs * scale,
      processCpuMs: ((cpu.user + cpu.system) / 1000) * scale,
      mainThreadCpuMs: ((threadCpu.user + threadCpu.system) / 1000) * scale,
      ...(profile
        ? {
            sampledAllocationBytes: allocationBytes(profile.head) * scale,
            normalizationSampledAllocationBytes: allocationBytes(profile.head, true) * scale,
          }
        : {}),
    },
    latency: {
      medianMs: sorted[Math.ceil(operations * 0.5) - 1],
      p95Ms: sorted[Math.ceil(operations * 0.95) - 1],
      maxMs: sorted.at(-1),
    },
    ...(mode === "counts" ? { counters: measuredCounters } : {}),
    ...(mode === "owner" ? { normalizationOwner: measuredCounters } : {}),
  };
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  if (cpuProfile) {
    await writeFile(`${values.output}.cpuprofile`, JSON.stringify(cpuProfile));
  }
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector?.disconnect();
  await state.cleanup();
  if (previousTmp === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmp;
  }
  Reflect.deleteProperty(globalThis, counterKey);
  Reflect.deleteProperty(globalThis, cpuClockKey);
  if (batchSize && process.connected) {
    process.disconnect?.();
  }
}
