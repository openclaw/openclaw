/**
 * Actual SessionManager appends across --sessions retained readers (default 2), followed by
 * a separate main-thread native-receipt delivery benchmark. Synthetic state only.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-append-receipt-measure.ts \
 *   --output .local/append-receipt/base --mode timing --iterations 2000
 * Repeat counterbalanced with --mode allocation. --owner-file substitutes a saved
 * session-actor-replica.ts on main only; native workers always use this checkout.
 * Each arm warms up one round; --text-repeats 1500 exercises an individually oversized
 * context. Use --sessions 100 --rows 4 for entry-only pool pressure. --check-compact asserts receipts stay below 64 KiB for the default small appends.
 * Acceptance: identical model-context bytes, proportional receipts, lower allocation
 * or CPU, no material latency/GC regression. Census includes capture overhead; replay
 * excludes fixture preparation and sender-thread CPU. This is not Gateway load proof.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, serialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    rounds: { type: "string", default: "6" },
    sessions: { type: "string", default: "2" },
    rows: { type: "string", default: "512" },
    "text-repeats": { type: "string", default: "500" },
    "owner-file": { type: "string" },
    "check-compact": { type: "boolean", default: false },
  },
});
assert(values.output && ["census", "timing", "allocation"].includes(values.mode));
const iterations = Number(values.iterations),
  rounds = Number(values.rounds),
  sessions = Number(values.sessions),
  rows = Number(values.rows),
  textRepeats = Number(values["text-repeats"]);
assert(
  [iterations, rounds, rows, textRepeats, sessions].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  ),
);
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output);
const owner = pathToFileURL(path.resolve("src/config/sessions/session-actor-replica.ts"));
const source = values["owner-file"] ? pathToFileURL(path.resolve(values["owner-file"])) : owner;
const sourceDigest = createHash("sha256").update(readFileSync(source)).digest("hex");
const receiptOwner = pathToFileURL(path.resolve("src/config/sessions/session-actor-receipt.ts"));
const captured: unknown[] = [];
const census: Array<Record<string, unknown>> = [];
let capture = false;
const captureKey = Symbol.for("openclaw.benchmark.appendReceiptCapture");
Reflect.set(globalThis, captureKey, (outcome: unknown) => {
  if (capture) {
    captured.push(structuredClone(outcome));
  }
});
let loaded = false;
const evictions = { count: 0, bytes: 0 };
const evictionKey = Symbol.for("openclaw.benchmark.receiptEvictions");
Reflect.set(globalThis, evictionKey, evictions);
registerHooks({
  load(url, context, next) {
    if (url === receiptOwner.href) {
      const result = next(url, context);
      assert(typeof result.source === "string");
      const anchor = /function restoreSessionActorCommittedOutcome\([^)]*\)\s*\{/;
      assert(anchor.test(result.source), "Receipt restoration instrumentation anchor changed");
      return {
        ...result,
        source: result.source.replace(
          anchor,
          `$&globalThis[Symbol.for("openclaw.benchmark.appendReceiptCapture")](outcome);`,
        ),
      };
    }
    if (url !== owner.href) {
      return next(url, context);
    }
    loaded = true;
    const result = next(source.href, context);
    assert(typeof result.source === "string");
    const anchor = "discard(candidate);";
    assert(result.source.includes(anchor), "Replica eviction instrumentation anchor changed");
    const instrumented = result.source.replace(
      anchor,
      `globalThis[Symbol.for("openclaw.benchmark.receiptEvictions")][pool.snapshots > MAX_SNAPSHOTS ? "count" : "bytes"]++; ${anchor}`,
    );
    return { format: result.format, source: instrumented, shortCircuit: true };
  },
});
const { createOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const { withSelectedTranscriptReader } =
  await import("../../src/agents/sessions/session-manager-reader.test-support.js");
const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
const { replaceTranscriptEvents } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js");
const { getWorkerMessageMetrics } = await import("../../src/infra/worker-message-metrics.js");
const { drainGlobalSingletonLifecycleState, readGlobalSingleton } =
  await import("../../src/shared/global-singleton.js");
assert(loaded, "Replica owner substitution was not loaded");
const stateRoot = path.join(output, "state");
const state = await createOpenClawTestState({
  label: "append-receipt",
  scenario: "minimal",
  env: {
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  },
});
const size = (value: unknown) => serialize(value).byteLength;
function fields(value: unknown) {
  return isRecord(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, size(item)]))
    : {};
}
const metric = (kind: "authority" | "sqlite_request") => {
  const bytes = getWorkerMessageMetrics().find(
    (item) => item.kind === kind,
  )?.payloadBytesByRequestClass;
  return (
    (bytes?.["session.actor.appendTranscriptEvent"] ?? 0) +
    (bytes?.["session.actor.appendToolResult"] ?? 0)
  );
};
let requestBytes = 0,
  receiptBytes = 0;
try {
  const targets = Array.from({ length: sessions }, (_, name) => ({
    agentId: "main",
    sessionId: `synthetic-${name}`,
    sessionKey: `agent:main:synthetic-${name}`,
    storePath: path.join(stateRoot, "openclaw-agent.sqlite"),
  }));
  const assistant = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Synthetic answer ".repeat(textRepeats) }],
    api: "openai-responses" as const,
    provider: "synthetic",
    model: "synthetic",
    stopReason: "stop" as const,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1700000000001,
  };
  const entries = Array.from({ length: rows }, (_, index) => ({
    type: "message",
    id: `event-${index}`,
    parentId: index ? `event-${index - 1}` : null,
    timestamp: new Date(1700000000000 + index).toISOString(),
    message:
      index % 4 === 0
        ? { role: "user", content: `Question ${index}`, timestamp: 1700000000000 + index }
        : index % 4 === 1
          ? {
              ...assistant,
              content: [
                {
                  type: "toolCall",
                  id: `call-${index}`,
                  name: "read",
                  arguments: { path: "synthetic.txt" },
                },
              ],
            }
          : index % 4 === 2
            ? {
                role: "toolResult",
                toolCallId: `call-${index - 1}`,
                toolName: "read",
                content: assistant.content,
                isError: false,
                timestamp: 1700000000000 + index,
              }
            : { ...assistant, timestamp: 1700000000000 + index },
  }));
  for (const target of targets) {
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      skillsSnapshot: {
        prompt: "Synthetic instructions. ".repeat(10000),
        skills: Array.from({ length: 120 }, (_, index) => ({ name: `skill-${index}` })),
      },
      systemPromptReport: {
        source: "run",
        generatedAt: 1,
        sessionId: target.sessionId,
        systemPrompt: { chars: 260000, projectContextChars: 20000, nonProjectContextChars: 240000 },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 240000,
          entries: Array.from({ length: 120 }, (_, index) => ({
            name: `skill-${index}`,
            blockChars: 2000,
          })),
        },
        tools: {
          listChars: 2000,
          schemaChars: 20000,
          entries: Array.from({ length: 120 }, (_, index) => ({
            name: `tool-${index}`,
            summaryChars: 100,
            schemaChars: 1000,
            schemaHash: "f".repeat(64),
          })),
        },
      },
    });
    await replaceTranscriptEvents(target, [
      { type: "session", id: target.sessionId, version: 3, cwd: "/synthetic" },
      ...entries,
    ]);
  }
  const limits = { maxBytes: 8 * 1024 * 1024, maxEvents: rows + rounds * 2 };
  const readers: Array<ReturnType<typeof AsyncLocalStorage.snapshot>> = [];
  async function withReaders(readerIndex: number): Promise<void> {
    const selectedTarget = targets[readerIndex];
    if (selectedTarget) {
      await withSelectedTranscriptReader(
        selectedTarget,
        async () => {
          readers.push(AsyncLocalStorage.snapshot());
          await withReaders(readerIndex + 1);
        },
        true,
      );
      return;
    }
    for (let round = -1; round < rounds; round++) {
      const managers = [];
      for (const [index, target] of targets.entries()) {
        managers.push(
          await readers[index]!(() => SessionManager.openAsync(target, state.workspaceDir, limits)),
        );
      }
      for (const [slot, manager] of managers.entries()) {
        const message =
          slot % 3 === 2
            ? {
                role: "toolResult" as const,
                toolCallId: `call-${round}`,
                toolName: "read",
                content: assistant.content,
                isError: false,
                timestamp: 1700000001000 + round,
              }
            : slot
              ? {
                  ...assistant,
                  timestamp: 1700000001000 + round,
                  content: [
                    {
                      type: "text" as const,
                      text: `Answer ${round} ${assistant.content[0]!.text}`,
                    },
                  ],
                }
              : {
                  role: "user" as const,
                  content: `Next question ${round}`,
                  timestamp: 1700000001000 + round,
                };
        const requestsBefore = metric("sqlite_request"),
          receiptsBefore = metric("authority");
        const start = performance.now(),
          before = captured.length;
        capture = round >= 0;
        await readers[slot]!(() => manager.appendMessageAsync(message));
        capture = false;
        const appendMs = performance.now() - start;
        if (round < 0) {
          continue;
        }
        requestBytes += metric("sqlite_request") - requestsBefore;
        receiptBytes += metric("authority") - receiptsBefore;
        assert.equal(
          captured.length,
          before + 1,
          `Expected one native append receipt at round ${round}, slot ${slot}`,
        );
        const native = captured.at(-1);
        assert(isRecord(native) && isRecord(native.receipt));
        if (values["check-compact"]) {
          assert(size(native) < 64 * 1024, "Small append receipt exceeded 64 KiB");
        }
        const transcript = native.receipt.transcript;
        assert(isRecord(transcript));
        const append = transcript.append;
        const value = isRecord(append) ? append.value : undefined;
        const context = JSON.stringify(manager.buildSessionContext().messages);
        census.push({
          round,
          slot,
          pool: (() => {
            const pool = readGlobalSingleton(Symbol.for("openclaw.sessionActorReplicas"));
            assert(isRecord(pool));
            return { bytes: pool.bytes, snapshots: pool.snapshots };
          })(),
          instrumentedAppendMs: appendMs,
          receiptBytes: size(native),
          receiptFields: fields(native.receipt),
          postimageFields: fields(native.receipt.postimage),
          entryFields: fields(
            isRecord(native.receipt.postimage) ? native.receipt.postimage.entry : undefined,
          ),
          transcriptFields: fields(transcript),
          reloadBytes: isRecord(value) && value.reload ? size(value.reload) : 0,
          modelPromptProjectionBytes:
            isRecord(append) && append.modelPromptProjection
              ? size(append.modelPromptProjection)
              : 0,
          contextBytes: Buffer.byteLength(context),
          contextHash: createHash("sha256").update(context).digest("hex"),
        });
      }
    }
  }
  await withReaders(0);
} finally {
  capture = false;
  await state.cleanup();
  await drainGlobalSingletonLifecycleState();
  Reflect.deleteProperty(globalThis, captureKey);
  Reflect.deleteProperty(globalThis, evictionKey);
  rmSync(stateRoot, { recursive: true, force: true });
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
let replay: Record<string, unknown> | undefined;
if (values.mode !== "census") {
  // The separate sender isolates native structured-clone decoding and allocation on main.
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
    let sent = 0;
    parentPort.on('message', () => {
      const end = Math.min(sent + 32, workerData.iterations);
      while (sent < end) parentPort.postMessage(workerData.receipts[sent++ % workerData.receipts.length]);
    });
    parentPort.postMessage('ready');`,
    { eval: true, workerData: { receipts: captured, iterations } },
  );
  const inspector = new Session(),
    gc = new GCProfiler();
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
    });
    globalThis.gc?.();
    await setImmediate();
    if (values.mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const memoryBefore = process.memoryUsage(),
      hostLoadBefore = loadavg();
    gc.start();
    const cpu = process.threadCpuUsage(),
      start = performance.now();
    await new Promise<void>((resolve, reject) => {
      let received = 0;
      worker.once("error", reject);
      worker.on("message", (message: unknown) => {
        assert(isRecord(message) && message.kind === "committed");
        received++;
        if (received === iterations) {
          resolve();
        } else if (received % 32 === 0) {
          worker.postMessage("next", []);
        }
      });
      worker.postMessage("next", []);
    });
    const used = process.threadCpuUsage(cpu),
      elapsedMs = performance.now() - start;
    const pauses = gc.stop();
    const memoryAfter = process.memoryUsage();
    const profile =
      values.mode === "allocation"
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
    replay = {
      iterations,
      elapsedMs,
      mainThreadCpuUsPerReceipt: (used.user + used.system) / iterations,
      sampledBytesPerReceipt: profile ? allocated(profile.head) / iterations : undefined,
      gc: pauses,
      memoryBefore,
      memoryAfter,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    };
    if (profile) {
      writeFileSync(path.join(output, "allocation.json"), JSON.stringify(profile));
    }
  } finally {
    inspector.disconnect();
    await worker.terminate();
  }
}
const result = {
  sourceDigest,
  mode: values.mode,
  rows,
  textRepeats,
  rounds,
  sessions,
  requestBytes,
  receiptBytes,
  evictions,
  census,
  replay,
  node: process.version,
};
writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output, sessions, evictions, requestBytes, receiptBytes, replay }));
