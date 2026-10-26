import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "retention" },
    "source-dir": { type: "string" },
    "start-file": { type: "string" },
    "ready-file": { type: "string" },
    "warm-start-file": { type: "string" },
    "warm-ready-file": { type: "string" },
    "done-file": { type: "string" },
    "release-file": { type: "string" },
    samples: { type: "string" },
    "context-first": { type: "boolean", default: false },
    operations: { type: "string" },
    output: { type: "string" },
    "trace-log": { type: "string" },
  },
});
assert(values.mode === "retention" || values.mode === "cost", "Unknown measurement mode");
assert(values.output, "--output is required");
assert.equal(
  Boolean(values["done-file"]),
  Boolean(values["release-file"]),
  "--done-file and --release-file require each other",
);
assert(!values["done-file"] || values.mode === "cost", "The paired teardown barrier is cost-only");
const output = path.resolve(values.output);
assert(!existsSync(output), "Refusing to overwrite an existing result");
const samples = parseStrictIntegerOption({
  raw: values.samples,
  fallback: 5,
  min: 1,
  label: "samples",
});
const operations = parseStrictIntegerOption({
  raw: values.operations,
  fallback: 2000,
  min: 1,
  label: "operations",
});
const tracing = process.execArgv.includes("--trace-gc-nvp");
assert.equal(
  tracing,
  Boolean(values["trace-log"]),
  "--trace-gc-nvp and --trace-log require each other",
);
assert(!tracing || values.mode === "cost", "Retention is not a promotion measurement");
assert(global.gc, "--expose-gc is required for retention or post-capture release checks");
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(stateDir && path.isAbsolute(stateDir), "Set OPENCLAW_STATE_DIR to prepared synthetic state");
const storePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
assert(
  existsSync(storePath),
  "Prepared synthetic database is missing; this script never seeds fixtures",
);
const sourceRoot = path.resolve(
  values["source-dir"] ?? fileURLToPath(new URL("../../", import.meta.url)),
);
const sourceFiles = [
  "src/agents/sessions/session-manager.ts",
  "src/agents/sessions/session-manager-codec.ts",
  "src/config/sessions/transcript-snapshot.ts",
];
const sources = sourceFiles.map((file) => ({
  file,
  canonicalUrl: new URL(`../../${file}`, import.meta.url).href,
  replacementUrl: pathToFileURL(path.join(sourceRoot, file)),
  sha256: hash("sha256", readFileSync(path.join(sourceRoot, file)), "hex"),
  loads: 0,
}));
registerHooks({
  load(url, context, nextLoad) {
    const source = sources.find((entry) => entry.canonicalUrl === url);
    if (!source) {
      return nextLoad(url, context);
    }
    source.loads++;
    const loaded = nextLoad(source.replacementUrl.href, context);
    return { format: loaded.format, source: loaded.source, shortCircuit: true };
  },
});

// Preserve canonical module identity and normal worker/admission paths on both arms.
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const sessionManagerReadInitialContext: typeof import("../../src/agents/sessions/session-manager-current-turn.js").sessionManagerReadInitialContext =
  (await import("../../src/agents/sessions/session-manager-current-turn.js"))
    .sessionManagerReadInitialContext;
const { closeOpenClawAgentDatabaseByPathAsync } =
  await import("../../src/state/openclaw-agent-db.js");
type Manager = Awaited<ReturnType<typeof SessionManager.openBoundedAsync>>;
type Context = Awaited<ReturnType<Manager[typeof sessionManagerReadInitialContext]>>;
type Root = { manager: Manager; context?: Context };
const target = {
  agentId: "main",
  env: process.env,
  storePath,
  sessionId: "synthetic-session",
  sessionKey: "agent:main:synthetic-session",
};
const bounds = { cwd: "/synthetic", maxEvents: 2000, maxBytes: 8 * 1024 * 1024 };
const liveCount = 20;
const warmupOperations = values.mode === "cost" ? 32 : 1;
const intervalMs = 1;
const digest = (value: unknown) => hash("sha256", JSON.stringify(value), "hex");

function verifySources() {
  for (const source of sources) {
    assert(source.loads > 0, `Source hook did not load ${source.file}`);
    assert.equal(
      hash("sha256", readFileSync(source.replacementUrl), "hex"),
      source.sha256,
      `Source changed during measurement: ${source.file}`,
    );
  }
}

async function open(withContext: boolean): Promise<Root> {
  const manager = await SessionManager.openBoundedAsync(target, bounds);
  const context = withContext ? await manager[sessionManagerReadInitialContext]() : undefined;
  return { manager, context };
}

function inspect({ manager, context }: Root) {
  const entries = manager.getEntries();
  const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const selected = context?.messages ?? [];
  let equalToolPayloads = 0;
  let equalToolPayloadUtf8Bytes = 0;
  for (const message of selected) {
    if (message.role !== "toolResult") {
      continue;
    }
    const resident = messages.find(
      (candidate) => candidate.role === "toolResult" && candidate.toolCallId === message.toolCallId,
    );
    if (
      resident?.role === "toolResult" &&
      JSON.stringify(resident.content) === JSON.stringify(message.content)
    ) {
      equalToolPayloads++;
      for (const part of message.content) {
        if (part.type === "text") {
          equalToolPayloadUtf8Bytes += Buffer.byteLength(part.text, "utf8");
        }
      }
    }
  }
  return {
    entries: entries.length,
    branch: manager.getBranch().length,
    messages: context?.messages.length,
    messageAliases: selected.filter((message) => messages.includes(message)).length,
    contentArrayAliases: selected.filter(
      (message) =>
        "content" in message &&
        Array.isArray(message.content) &&
        messages.some((resident) => "content" in resident && resident.content === message.content),
    ).length,
    frozenMessages: selected.filter((message) => Object.isFrozen(message)).length,
    frozenContentArrays: selected.filter(
      (message) =>
        "content" in message && Array.isArray(message.content) && Object.isFrozen(message.content),
    ).length,
    frozenManagerMessages: messages.filter((message) => Object.isFrozen(message)).length,
    frozenManagerContentArrays: messages.filter(
      (message) =>
        "content" in message && Array.isArray(message.content) && Object.isFrozen(message.content),
    ).length,
    equalToolPayloads,
    equalToolPayloadUtf8Bytes,
  };
}

async function verifyFixture() {
  const root = await open(true);
  assert(root.context);
  const shape = inspect(root);
  assert.equal(shape.entries, 1201, "Expected the prepared bounded entries");
  assert.equal(shape.branch, 1201, "Expected the prepared 400-turn active branch");
  assert.equal(shape.messages, 661, "Expected compaction retaining from turn 180");
  const goldenSha256 = digest(root.context);
  const managerSha256 = digest(root.manager.getEntries());
  const tool = root.context.messages.find((message) => message.role === "toolResult");
  assert(tool?.role === "toolResult");
  const text = tool.content.find((part) => part.type === "text");
  assert(text?.type === "text");
  assert.equal(
    Reflect.set(text, "text", "synthetic context mutation"),
    true,
    "Public context must be writable",
  );
  assert.equal(
    digest(root.manager.getEntries()),
    managerSha256,
    "Context mutation reached manager",
  );
  const next = await root.manager[sessionManagerReadInitialContext]();
  assert.equal(digest(next), goldenSha256, "Context mutation reached persisted replay");
  const resident = root.manager
    .getEntries()
    .find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === tool.toolCallId,
    );
  assert(resident?.type === "message" && resident.message.role === "toolResult");
  const residentText = resident.message.content.find((part) => part.type === "text");
  assert(residentText?.type === "text");
  assert.equal(Reflect.set(residentText, "text", "synthetic manager mutation"), true);
  assert.equal(digest(next), goldenSha256, "Manager mutation reached returned context");
  assert.equal(
    digest(await root.manager[sessionManagerReadInitialContext]()),
    goldenSha256,
    "Unpersisted manager mutation replaced authoritative model context",
  );
  return { goldenSha256, shape };
}

async function collect() {
  assert(global.gc);
  for (let index = 0; index < 8; index++) {
    await setImmediate();
    global.gc();
  }
}

async function barrier(readyFile: string | undefined, startFile: string | undefined) {
  if (readyFile) {
    await writeFile(readyFile, `${process.pid}\n`, { flag: "wx" });
  }
  if (startFile) {
    while (!existsSync(startFile)) {
      await delay(50);
    }
    const startAt = Number(readFileSync(startFile, "utf8").trim());
    assert(Number.isSafeInteger(startAt) && startAt > Date.now(), "Missed synchronized start");
    await delay(startAt - Date.now());
  }
}

function markGc(phase: string) {
  if (tracing) {
    writeSync(
      1,
      `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath: output })}\n`,
    );
  }
}

function summarize(latencies: Float64Array) {
  const sorted = latencies.toSorted();
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    totalMs,
    meanMs: totalMs / sorted.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
    maxMs: sorted.at(-1),
  };
}

async function retentionSample(sample: number, withContext: boolean, goldenSha256: string) {
  await collect();
  const beforeBytes = process.memoryUsage().heapUsed;
  const live: Root[] = [];
  for (let index = 0; index < liveCount; index++) {
    live.push(await open(withContext));
  }
  await collect();
  const retainedBytes = process.memoryUsage().heapUsed;
  // These traversals happen only after the heap reading and return primitive summaries.
  const { shape, refs } = inspectRetained(live, withContext, goldenSha256);
  live.length = 0;
  await collect();
  const releasedBytes = process.memoryUsage().heapUsed;
  return {
    sample,
    withContext,
    liveCount,
    beforeBytes,
    retainedBytes,
    releasedBytes,
    retainedHeapBytes: retainedBytes - beforeBytes,
    bytesPerLiveManager: (retainedBytes - beforeBytes) / liveCount,
    releasedDeltaBytes: releasedBytes - beforeBytes,
    managerSurvivors: refs.filter((ref) => ref.manager.deref()).length,
    contextSurvivors: refs.filter((ref) => ref.context?.deref()).length,
    shape,
  };
}

function inspectRetained(live: Root[], withContext: boolean, goldenSha256: string) {
  const first = live[0];
  assert(first);
  if (withContext) {
    for (const root of live) {
      assert.equal(digest(root.context), goldenSha256);
    }
  }
  return {
    shape: inspect(first),
    refs: live.map((root) => ({
      manager: new WeakRef(root.manager),
      context: root.context ? new WeakRef(root.context) : undefined,
    })),
  };
}

try {
  const fixture = await verifyFixture();
  verifySources();
  if (tracing) {
    markGc("identify-start");
    global.gc?.();
    markGc("identify-stop");
  }
  await barrier(values["warm-ready-file"], values["warm-start-file"]);
  const ring: Root[] = [];
  for (let index = 0; index < warmupOperations; index++) {
    if (values.mode === "cost") {
      ring[index % liveCount] = await open(true);
    } else {
      await open(true);
    }
    await delay(intervalMs);
  }
  console.log("PHASE warmed");
  await barrier(values["ready-file"], values["start-file"]);
  const common = {
    scope:
      "Prepared synthetic bounded SessionManager open and initial model-context read; no provider, Gateway turn, or deployed gain claim",
    mode: values.mode,
    runtime: process.version,
    pid: process.pid,
    sourceRoot,
    sourceScope: "Three main-isolate modules; workers use the common frozen checkout",
    fixture,
    bounds,
    warmupOperations,
    liveCount,
    intervalMs,
    timingGateEligible: values.mode === "cost" && !tracing,
  };
  let measurement: object;
  if (values.mode === "retention") {
    const results = [];
    for (let sample = 0; sample < samples; sample++) {
      const contextFirst = Boolean(sample % 2) !== values["context-first"];
      for (const withContext of contextFirst ? [true, false] : [false, true]) {
        results.push(await retentionSample(sample, withContext, fixture.goldenSha256));
      }
    }
    measurement = {
      samples,
      forcedCollectionsPerBoundary: 8,
      results,
      caveat:
        "Forced-GC retained heap, not natural GC/promotion or string-backing-store attribution",
    };
  } else {
    const whole = new Float64Array(operations);
    const initial = new Float64Array(operations);
    assert.equal(ring.length, liveCount);
    const finishDiagnostics = startGatewayBenchDiagnostics();
    const cpuBefore = process.cpuUsage();
    markGc("diagnostics-start");
    for (let index = 0; index < operations; index++) {
      const started = performance.now();
      const manager = await SessionManager.openBoundedAsync(target, bounds);
      const readStarted = performance.now();
      const context = await manager[sessionManagerReadInitialContext]();
      initial[index] = performance.now() - readStarted;
      ring[(warmupOperations + index) % liveCount] = { manager, context };
      whole[index] = performance.now() - started;
      await delay(intervalMs);
    }
    markGc("diagnostics-stop");
    const cpu = process.cpuUsage(cpuBefore);
    const diagnostics = finishDiagnostics();
    await barrier(values["done-file"], values["release-file"]);
    const promotion = values["trace-log"]
      ? readGatewayGcTrace(values["trace-log"], output, "diagnostics")
      : undefined;
    const { shape, refs } = inspectRetained(ring, true, fixture.goldenSha256);
    ring.length = 0;
    await collect();
    measurement = {
      operations,
      openCalls: operations,
      readCalls: operations,
      latency: summarize(whole),
      initialContextLatency: summarize(initial),
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuScope:
        "Process CPU includes worker threads; GC/loop diagnostics cover the main isolate only",
      diagnostics,
      gcMsPerOperation: (diagnostics.gc.durationMs?.total ?? 0) / operations,
      postCapture: {
        shape,
        forcedCollections: 8,
        managerSurvivors: refs.filter((ref) => ref.manager.deref()).length,
        contextSurvivors: refs.filter((ref) => ref.context?.deref()).length,
      },
      ...(promotion
        ? {
            promotion: {
              ...promotion,
              promotedBytesPerOperation: promotion.promotedBytes / operations,
            },
          }
        : {}),
    };
  }
  verifySources();
  const result = {
    ...common,
    ...measurement,
    sources: sources.map(({ file, sha256, loads }) => ({ file, sha256, loads })),
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(result));
} finally {
  await closeOpenClawAgentDatabaseByPathAsync(storePath, target.agentId);
}
