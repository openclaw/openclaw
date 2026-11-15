/**
 * Actual SessionManager appends after two long, bounded transcript reads, followed by
 * a separate main-thread native-receipt delivery benchmark. Synthetic state only.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-append-receipt-measure.ts \
 *   --output .local/append-receipt/base --mode timing --iterations 2000
 * Repeat counterbalanced with --mode allocation. --owner-file substitutes a saved
 * session-actor-replica.ts on main only; native workers always use this checkout.
 * Each arm warms up one round; --text-repeats 1500 exercises an individually oversized
 * context. --check-compact asserts receipts stay below 64 KiB for the default small appends.
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
import { MessagePort, Worker } from "node:worker_threads";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    rounds: { type: "string", default: "6" },
    rows: { type: "string", default: "512" },
    "text-repeats": { type: "string", default: "500" },
    "owner-file": { type: "string" },
    "check-compact": { type: "boolean", default: false },
  },
});
assert(values.output && ["census", "timing", "allocation"].includes(values.mode));
const iterations = Number(values.iterations),
  rounds = Number(values.rounds),
  rows = Number(values.rows),
  textRepeats = Number(values["text-repeats"]);
assert(
  [iterations, rounds, rows, textRepeats].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  ),
);
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output);
const owner = pathToFileURL(path.resolve("src/config/sessions/session-actor-replica.ts"));
const source = values["owner-file"] ? pathToFileURL(path.resolve(values["owner-file"])) : owner;
const sourceDigest = createHash("sha256").update(readFileSync(source)).digest("hex");
let loaded = false;
registerHooks({
  load(url, context, next) {
    if (url !== owner.href) {
      return next(url, context);
    }
    loaded = true;
    const result = next(source.href, context);
    return { format: result.format, source: result.source, shortCircuit: true };
  },
});
const captured: unknown[] = [];
const census: Array<Record<string, unknown>> = [];
let capture = false;
assert(
  !Object.hasOwn(MessagePort.prototype, "on"),
  "Receipt census requires an unmodified port prototype",
);
MessagePort.prototype.on = function (event, listener) {
  if (event !== "message") {
    return MessagePort.prototype.addListener.call(this, event, listener);
  }
  return MessagePort.prototype.addListener.call(this, event, (message: unknown) => {
    if (
      capture &&
      isRecord(message) &&
      message.kind === "native-commit" &&
      isRecord(message.committed)
    ) {
      // Restoration mutates the received object; retain the wire shape before that callback.
      captured.push(structuredClone(message.committed.facts));
    }
    listener(message);
  });
};
const { createOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const { withSelectedTranscriptReader } =
  await import("../../src/agents/sessions/session-manager-reader.test-support.js");
const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
const { replaceTranscriptEvents } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js");
const { getWorkerMessageMetrics } = await import("../../src/infra/worker-message-metrics.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
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
const metric = (kind: "authority" | "sqlite_request") =>
  getWorkerMessageMetrics().find((item) => item.kind === kind)?.payloadBytesByRequestClass?.[
    "session.actor.appendTranscriptEvent"
  ] ?? 0;
let requestBytes = 0,
  receiptBytes = 0;
try {
  const targets = ["first", "second"].map((name) => ({
    agentId: "main",
    sessionId: `synthetic-${name}`,
    sessionKey: `agent:main:synthetic-${name}`,
    storePath: path.join(stateRoot, "openclaw-agent.sqlite"),
  }));
  const assistant = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Synthetic answer ".repeat(textRepeats) }],
    api: "openai-completions" as const,
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
      skillsSnapshot: { prompt: "Synthetic instructions. ".repeat(11000), skills: [] },
    });
    await replaceTranscriptEvents(target, [
      { type: "session", id: target.sessionId, version: 3, cwd: "/synthetic" },
      ...entries,
    ]);
  }
  const first = targets[0]!,
    second = targets[1]!;
  const limits = { maxBytes: 8 * 1024 * 1024, maxEvents: rows + rounds * 2 };
  for (const target of targets) {
    await SessionManager.openAsync(target, state.workspaceDir, limits);
  }
  await withSelectedTranscriptReader(
    first,
    async () => {
      const inFirst = AsyncLocalStorage.snapshot();
      await withSelectedTranscriptReader(
        second,
        async () => {
          for (let round = -1; round < rounds; round++) {
            const managers = [
              await inFirst(() => SessionManager.openAsync(first, state.workspaceDir, limits)),
              await SessionManager.openAsync(second, state.workspaceDir, limits),
            ];
            for (const [slot, manager] of managers.entries()) {
              const message = slot
                ? assistant
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
              if (slot === 0) {
                await inFirst(() => manager.appendMessageAsync(message));
              } else {
                await manager.appendMessageAsync(message);
              }
              capture = false;
              const appendMs = performance.now() - start;
              if (round < 0) {
                continue;
              }
              requestBytes += metric("sqlite_request") - requestsBefore;
              receiptBytes += metric("authority") - receiptsBefore;
              assert.equal(captured.length, before + 1, "Expected one native append receipt");
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
                instrumentedAppendMs: appendMs,
                receiptBytes: size(native),
                receiptFields: fields(native.receipt),
                postimageFields: fields(native.receipt.postimage),
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
        },
        true,
      );
    },
    true,
  );
} finally {
  capture = false;
  Reflect.deleteProperty(MessagePort.prototype, "on");
  await state.cleanup();
  await drainGlobalSingletonLifecycleState();
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
  requestBytes,
  receiptBytes,
  census,
  replay,
  node: process.version,
};
writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
