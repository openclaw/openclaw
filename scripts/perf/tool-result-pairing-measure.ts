/**
 * Full transcript-pairing repair CPU/allocation benchmark, synthetic history only.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-result-pairing-measure.ts
 *   --source .local/tool-result-pairing-base.ts --scenario canonical --iterations 2000
 * Save the baseline owner before editing; --source replaces only that module.
 * Run five interleaved baseline/candidate pairs per scenario, reversing launch order.
 * Accept lower allocation/CPU with identical output hashes and no material regression.
 * Timing is untraced; allocation is a separate sampling pass including collected objects.
 * --request --turns 50 --calls 2 exercises the request replay + transport owners
 * on 200 messages. For baseline request runs, --base-dir names a directory containing
 * original versions of changed modules at their repository-relative paths. Relative
 * imports still resolve against the working checkout; only saved modules substitute.
 * The baseline's separate Responses replay wrapper runs only when that export exists.
 * This measures synchronous replay preparation, not Gateway RPC or model latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Context, Model } from "@openclaw/llm-core";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "base-dir": { type: "string" },
    request: { type: "boolean", default: false },
    turns: { type: "string", default: "100" },
    calls: { type: "string", default: "4" },
    scenario: { type: "string", default: "canonical" },
    iterations: { type: "string", default: "2000" },
  },
});
const iterations = Number(values.iterations);
const turns = Number(values.turns);
const callsPerTurn = Number(values.calls);
for (const value of [iterations, turns, callsPerTurn]) {
  assert(Number.isSafeInteger(value) && value > 0);
}
assert(!(values.source && values["base-dir"]), "Choose --source or --base-dir");
assert(values.scenario === "canonical" || values.scenario === "legacy");
assert(global.gc, "Run with --expose-gc");
const owner = path.resolve("packages/agent-core/src/harness/session/tool-result-pairing.ts");
const root = process.cwd();
const baseDir = values["base-dir"] ? path.resolve(values["base-dir"]) : undefined;
const source = path.resolve(
  values.source ?? (baseDir ? path.join(baseDir, path.relative(root, owner)) : owner),
);
const substitutions = new Set<string>();
const originals = new Map<string, string>();
const hooks =
  values.source || baseDir
    ? registerHooks({
        resolve(specifier, context, nextResolve) {
          const parentURL = context.parentURL
            ? (originals.get(context.parentURL) ?? context.parentURL)
            : undefined;
          const resolved = nextResolve(specifier, { ...context, parentURL });
          if (!resolved.url.startsWith("file:")) {
            return resolved;
          }
          const original = fileURLToPath(resolved.url);
          const relative = path.relative(root, original);
          const replacement = values.source
            ? original === owner
              ? source
              : undefined
            : !relative.startsWith("..") && baseDir
              ? path.join(baseDir, relative)
              : undefined;
          if (!replacement || !existsSync(replacement)) {
            return resolved;
          }
          const replacementURL = pathToFileURL(replacement).href;
          originals.set(replacementURL, resolved.url);
          substitutions.add(relative);
          return nextResolve(replacementURL, context);
        },
      })
    : undefined;
const { repairToolUseResultPairing } =
  await import("../../src/agents/session-transcript-repair.js");
assert(!hooks || substitutions.size > 0, "Baseline modules must be substituted");
const messages: Context["messages"] = [];
for (let turn = 0; turn < turns; turn++) {
  messages.push({ role: "user", content: `Synthetic request ${turn}`, timestamp: turn });
  const calls = Array.from({ length: callsPerTurn }, (_, index) => ({
    type: "toolCall" as const,
    id: `call_${index}`,
    name: "read",
    arguments: { path: `/synthetic/${turn}/${index}` },
  }));
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: "Reading synthetic inputs" }, ...calls],
    api: "openai-responses",
    provider: "openai",
    model: "synthetic",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: turn,
  });
  for (const [index, call] of calls.entries()) {
    if (values.scenario === "legacy" && turn % 10 === 0 && index === callsPerTurn - 1) {
      continue;
    }
    messages.push({
      role: "toolResult",
      toolCallId: values.scenario === "legacy" ? "  " : call.id,
      ...(values.scenario === "legacy" ? { call_id: ` ${call.id} ` } : {}),
      toolName: "read",
      content: [{ type: "text", text: "Synthetic result ".repeat(64) }],
      isError: false,
      timestamp: turn,
    });
  }
}
const options = { missingToolResultTimestamp: "assistant" as const };
let execute = () => repairToolUseResultPairing(messages, options);
if (values.request) {
  type ReplayModule =
    typeof import("../../src/agents/embedded-agent-runner/run/attempt-tool-call-replay-sanitization.js") & {
      sanitizeOpenAIResponsesReplayForStream?: (input: AgentMessage[]) => AgentMessage[];
    };
  const replay: ReplayModule =
    await import("../../src/agents/embedded-agent-runner/run/attempt-tool-call-replay-sanitization.js");
  const { transformTransportMessages } =
    await import("../../src/agents/transport-message-transform.js");
  const { AssistantMessageEventStream } = await import("@openclaw/llm-core/event-stream");
  const model: Model<"openai-responses"> = {
    id: "synthetic",
    name: "synthetic",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "http://127.0.0.1:49999/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
  const stream = new AssistantMessageEventStream();
  let output: AgentMessage[] = [];
  const wrapped = replay.wrapStreamFnSanitizeMalformedToolCalls((_model, context) => {
    const prepared = replay.sanitizeOpenAIResponsesReplayForStream
      ? replay.sanitizeOpenAIResponsesReplayForStream(context.messages)
      : context.messages;
    output = transformTransportMessages(prepared as Context["messages"], model);
    return stream;
  });
  execute = () => {
    void wrapped(model, { messages });
    return { messages: output, added: [] };
  };
}
const expected = execute();
const outputHash = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
if (values.scenario === "canonical" && !values.request) {
  assert.equal(expected.messages, messages);
}
let checksum = 0;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const result = execute();
    checksum += result.messages.length + result.added.length;
  }
}
run(200);
global.gc();
const hostLoadBefore = loadavg();
const cpu = process.threadCpuUsage();
const started = performance.now();
run(iterations);
const elapsedMs = performance.now() - started;
const used = process.threadCpuUsage(cpu);
global.gc();
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval: 16384,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
run(iterations);
const { profile } = await inspector.post("HeapProfiler.stopSampling");
await inspector.post("Profiler.enable");
await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
execute();
const { result: coverage } = await inspector.post("Profiler.takePreciseCoverage");
await inspector.post("Profiler.stopPreciseCoverage");
inspector.disconnect();
const classificationPasses = coverage
  .flatMap((script) => script.functions)
  .filter((fn) => fn.functionName === "classifyToolUseResultPairing")
  .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
let bytes = 0;
const classificationAllocation: Record<string, number> = {};
const nodes = [{ node: profile.head, stack: [] as string[] }];
for (let entry = nodes.pop(); entry; entry = nodes.pop()) {
  const { node } = entry;
  const stack = [...entry.stack, node.callFrame.functionName];
  bytes += node.selfSize;
  const classifier = stack.indexOf("classifyToolUseResultPairing");
  if (classifier >= 0) {
    const callers = stack
      .slice(0, classifier)
      .toReversed()
      .filter(Boolean)
      .slice(0, 4)
      .join(" <- ");
    classificationAllocation[callers] = (classificationAllocation[callers] ?? 0) + node.selfSize;
  }
  nodes.push(...node.children.map((child) => ({ node: child, stack })));
}
assert.equal(createHash("sha256").update(JSON.stringify(execute())).digest("hex"), outputHash);
console.log(
  JSON.stringify({
    scenario: values.scenario,
    workload: values.request ? "request" : "repair",
    substitutedModules: [...substitutions],
    sourceHash: createHash("sha256").update(readFileSync(source)).digest("hex"),
    node: process.version,
    messages: messages.length,
    calls: turns * callsPerTurn,
    iterationsPerPass: iterations,
    warmup: 200,
    cpuMs: (used.user + used.system) / 1000,
    elapsedMs,
    allocationBytes: bytes,
    bytesPerOperation: bytes / iterations,
    classificationPasses,
    classificationBytesPerOperation: Object.fromEntries(
      Object.entries(classificationAllocation).map(([caller, total]) => [
        caller,
        total / iterations,
      ]),
    ),
    cpuUsPerOperation: (used.user + used.system) / iterations,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    outputHash,
    checksum,
  }),
);
hooks?.deregister();
