/**
 * Warm context-engine prompt preparation over eight synthetic sessions, each
 * with 256 messages, 40 tools, and 128 unrelated enclosing-attempt fields.
 * node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/context-engine-lifecycle-bench.ts --iterations 2000
 * Use --owner <path> for a pinned owner source snapshot (imports resolve at the canonical owner).
 * --long-context replays ten 360-message mixed CJK/Latin/tool/image histories with
 * 40,600-character system instructions and 5,160-character pending input. --counts instruments
 * string scans separately from timing/allocation. Acceptance: identical output hashes
 * and history budgets, half the rendered-prompt scans, lower CPU, no >20% regression.
 * Run five interleaved A/B pairs plus A/A controls; this excludes durable DB/workspace I/O.
 * Alternate base/candidate timing runs; --allocations measures collected-object
 * sampling separately. This measures the lifecycle owner, not Gateway latency.
 * Add --retained --profile <path> to exclude minor-collected objects and retain
 * the raw sampling profile for owner-frame attribution (not exact promotion).
 * --runtime-carriers includes 16 hidden carriers per history to measure filtering.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver, type PerformanceNodeEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import type { ContextEngine } from "../../src/context-engine/types.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    owner: { type: "string", default: "src/agents/harness/context-engine-lifecycle.ts" },
    allocations: { type: "boolean", default: false },
    retained: { type: "boolean", default: false },
    profile: { type: "string" },
    "runtime-carriers": { type: "boolean", default: false },
    "long-context": { type: "boolean", default: false },
    counts: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
assert(!values.retained || values.allocations, "--retained requires --allocations");
assert(!values.profile || values.allocations, "--profile requires --allocations");
const ownerUrl = pathToFileURL(resolve(values.owner));
const ownerSha256 = createHash("sha256").update(readFileSync(ownerUrl)).digest("hex");
const canonicalOwner = new URL(
  "../../src/agents/harness/context-engine-lifecycle.ts",
  import.meta.url,
).href;
const cjkUrl = new URL("../../packages/normalization-core/src/cjk-chars.ts", import.meta.url).href;
const scans = { calls: 0, chars: 0 };
Reflect.set(globalThis, Symbol.for("openclaw.perf.assembly-scans"), (chars: number) => {
  scans.calls++;
  scans.chars += chars;
});
const loader = registerHooks({
  load(url, context, next) {
    if (url === canonicalOwner) {
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(ownerUrl, "utf8")),
        shortCircuit: true,
      };
    }
    if (values.counts && url === cjkUrl) {
      const source = readFileSync(new URL(url), "utf8").replace(
        /export function estimateStringCharsWithMinimumRawWeight\([\s\S]*?\): number \{/,
        (signature) =>
          `${signature}\n globalThis[Symbol.for("openclaw.perf.assembly-scans")](text.length);`,
      );
      return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
    }
    return next(url, context);
  },
});
const { prepareHarnessContextEnginePrompt } =
  await import("../../src/agents/harness/context-engine-lifecycle.js");
loader.deregister();
const { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } =
  await import("../../src/agents/internal-runtime-context.js");
let engineCalls = 0;
let historyTokenBudget: number | undefined;
const contextEngine: ContextEngine = {
  info: { id: "legacy", name: "Synthetic pass-through" },
  async ingest() {
    return { ingested: true };
  },
  async compact() {
    return { ok: true, compacted: false };
  },
  async assemble({ messages, tokenBudget }) {
    engineCalls++;
    historyTokenBudget = tokenBudget;
    return { messages, estimatedTokens: 0 };
  },
};
const attempts = Array.from({ length: values["long-context"] ? 10 : 8 }, (_attempt, session) => ({
  ...Object.fromEntries(Array.from({ length: 128 }, (_, field) => [`attemptField${field}`, field])),
  sessionId: `synthetic-${session}`,
  sessionKey: `agent:main:synthetic-${session}`,
  modelId: "synthetic-model",
  contextEngine,
  messages: Array.from({ length: 256 }, (_, index) =>
    values["runtime-carriers"] && index % 16 === 0
      ? {
          role: "custom" as const,
          customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
          content: `Synthetic session ${session} carrier ${index}`,
          display: false,
          timestamp: index,
        }
      : {
          role: "user" as const,
          content: `Synthetic session ${session} message ${index}`,
          timestamp: index,
        },
  ) as AgentMessage[],
  availableTools: new Set(Array.from({ length: 40 }, (_, index) => `synthetic_tool_${index}`)),
  promptBudget: {
    contextTokens: 100_000,
    reserveTokens: 4096,
    systemPrompt: "Synthetic system instructions",
    prompt: "Continue synthetic work",
  },
  repairToolUseResultPairing: true,
  isOpenAIResponsesApi: false,
  warn: (message: string) => {
    throw new Error(message);
  },
}));
if (values["long-context"]) {
  for (const attempt of attempts) {
    attempt.promptBudget.systemPrompt =
      "Inspect source evidence. 保持上下文。 Report exact identifiers.\n".repeat(700);
    attempt.promptBudget.prompt = "New source evidence 中文工具结果. value = 12345;\n".repeat(120);
    attempt.messages = Array.from({ length: 360 }, (_, index): AgentMessage =>
      index % 3 === 2
        ? {
            role: "toolResult",
            toolCallId: `read-${index - 1}`,
            toolName: "read",
            isError: false,
            timestamp: index,
            content: [
              {
                type: "text",
                text: "const value = inspect(input); // 中文证据 한국어 カタカナ\n".repeat(90),
              },
            ],
          }
        : index % 3 === 1
          ? {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: `read-${index}`,
                  name: "read",
                  arguments: { path: `src/file-${index}.ts` },
                },
              ],
              api: "openai-responses",
              provider: "synthetic",
              model: "synthetic",
              stopReason: "toolUse",
              timestamp: index,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            }
          : {
              role: "user",
              timestamp: index,
              content: [
                { type: "text", text: `Inspect file ${index}` },
                { type: "image", mimeType: "image/png", data: "synthetic-image-metadata" },
              ],
            },
    );
  }
}
const fingerprint = createHash("sha256");
for (const attempt of attempts) {
  const result = await prepareHarnessContextEnginePrompt(attempt);
  fingerprint.update(JSON.stringify({ result, historyTokenBudget }));
}
const turnMs: number[] = [];
async function run(count: number) {
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    await prepareHarnessContextEnginePrompt(attempts[index % attempts.length]!);
    turnMs.push(performance.now() - started);
  }
}
await run(500);
engineCalls = 0;
turnMs.length = 0;
scans.calls = scans.chars = 0;
global.gc();
await nextTurn();
const pauses: { kind: number; duration: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    pauses.push({ kind: (entry as PerformanceNodeEntry).detail.kind, duration: entry.duration });
  }
});
const inspector = new Session();
try {
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: !values.retained,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  await run(iterations);
  const wallMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let sampledBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    if (values.profile) {
      writeFileSync(values.profile, JSON.stringify(profile));
    }
  }
  console.log(
    JSON.stringify({
      ownerSha256,
      iterations,
      engineCalls,
      sessions: attempts.length,
      messagesPerSession: attempts[0]!.messages.length,
      longContext: values["long-context"],
      scans: values.counts ? scans : undefined,
      p95TurnMs: turnMs.toSorted((a, b) => a - b)[Math.floor(iterations * 0.95)],
      unrelatedAttemptFields: 128,
      tools: 40,
      runtimeCarriersPerSession: values["runtime-carriers"] ? 16 : 0,
      mode: values.allocations ? "allocation" : "timing",
      includeMinorCollected: values.allocations ? !values.retained : undefined,
      node: process.version,
      fingerprint: fingerprint.digest("hex"),
      hostLoad,
      wallMs,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      bytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      gc: values.allocations
        ? undefined
        : {
            count: pauses.length,
            totalMs: pauses.reduce((sum, pause) => sum + pause.duration, 0),
            maxMs: Math.max(0, ...pauses.map((pause) => pause.duration)),
            collections: pauses,
          },
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
}
