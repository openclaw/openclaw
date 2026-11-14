/**
 * Measures prompt-series initialization with a resident, synthetic SessionManager.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-prompt-begin-measure.ts
 *   --entries 4096 --iterations 3000 [--allocation] [--disabled]
 * Save the old session-prompt-state.ts with git show, then pass --baseline-source <file>
 * to load that exact owner at its original URL and use its eager entries contract.
 * Run timing and sampled-allocation passes separately, alternating revision order.
 * Preparation/warmup are excluded. This measures branch acquisition + begin, not
 * transcript hydration, writer contention, provider latency, or full Gateway startup.
 * --continuations measures --sessions interleaved prompt pins (default 65, 64 KiB each) over alternating
 * visible/omitted compaction markers, with the same authoritative boundary count.
 * It reports unnecessary series restarts; CPU/allocation are owner costs, not billing.
 * In this mode --baseline-source accepts the current-main owner before the repair.
 * --provider-requests also prepares real Responses requests over distinct frozen
 * 600-message tool histories, measured compaction prefixes and accepted continuations.
 * Test --sessions 65/256 here and 1024 owner-only; histories share immutable payloads,
 * not message identities. Prompts and replay identities are distinct. Exact
 * request/pressure hashes are checked outside timing before and after the loop.
 * Use the same baseline source for both A/A arms, then >=5 alternating A/B arms.
 * This excludes database/workspace scale, provider I/O and full Gateway overhead.
 */
import assert from "node:assert/strict";
import { createHash, hash } from "node:crypto";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { Type } from "typebox";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { recordResponsesContextUsage } from "../../packages/ai/src/transports/openai-responses-context-usage.js";
import {
  resolveResponsesContinuationRequest,
  type ResponsesContinuationState,
} from "../../packages/ai/src/transports/openai-responses-continuation.js";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { prepareSystemPrompt } from "../../packages/ai/src/utils/system-prompt-cache-boundary.js";
import { CURRENT_SESSION_VERSION } from "../../src/config/sessions/version.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    entries: { type: "string", default: "4096" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
    disabled: { type: "boolean", default: false },
    continuations: { type: "boolean", default: false },
    sessions: { type: "string", default: "65" },
    "provider-requests": { type: "boolean", default: false },
    "baseline-source": { type: "string" },
  },
});
const count = (name: "entries" | "iterations" | "sessions", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback });
const entryCount = count("entries", 4096);
const iterations = count("iterations", 3000);
const sessions = count("sessions", 65);
const continuations = values.continuations || values["provider-requests"];
const ownerUrl = new URL(
  "../../src/agents/embedded-agent-runner/session-prompt-state.ts",
  import.meta.url,
).href;
const wasOwnerReplaced = registerPerfOwnerReplacement(ownerUrl, values["baseline-source"]);
const { beginSessionSystemPrompt, prepareSessionSystemPrompt, retainEmbeddedSessionPromptState } =
  await import("../../src/agents/embedded-agent-runner/session-prompt-state.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
assert.equal(wasOwnerReplaced(), Boolean(values["baseline-source"]));
const { resolveProjectedRequestPressure } =
  await import("../../src/agents/embedded-agent-runner/run/preemptive-compaction.js");
const { transformTransportMessages } =
  await import("../../src/agents/transport-message-transform.js");
const manager = SessionManager.fromEntries([
  {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "synthetic-prompt-begin",
    timestamp: "2026-10-01T00:00:00Z",
    cwd: "/synthetic",
  },
  ...Array.from({ length: entryCount }, (_, index) => ({
    type: "message",
    id: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    timestamp: "2026-10-01T00:00:00Z",
    message: {
      role: "user",
      content: `Synthetic history ${index}. ${"x".repeat(256)}`,
      timestamp: index,
    },
  })),
]);
assert.equal(manager.getBranch().length, entryCount);
const lease = retainEmbeddedSessionPromptState("agent:synthetic:lane2428-begin");
const sessionKeys = Array.from(
  { length: sessions },
  (_, index) => `agent:synthetic:lane2428-${index}`,
);
const continuationLeases = continuations
  ? sessionKeys.map((sessionKey) => retainEmbeddedSessionPromptState(sessionKey))
  : [];
const history = manager.getBranch();
const compactedHistory = [
  {
    type: "compaction" as const,
    id: "existing-compaction",
    parentId: null,
    timestamp: "2026-10-01T00:00:00Z",
    summary: "Synthetic summary",
    firstKeptEntryId: history[0]!.id,
    tokensBefore: 300_000,
  },
  ...history,
];
const prompts = sessionKeys.map((sessionKey) =>
  `## Instructions\n${sessionKey}\nKeep these bytes.\n`.padEnd(65_536, "x"),
);
let operation = 0;
for (const [index, retained] of continuationLeases.entries()) {
  prepareSessionSystemPrompt({
    state: retained.state,
    routeKey: "synthetic-route",
    systemPrompt: prompts[index]!,
    entries: compactedHistory,
    historyBoundaryCount: 1,
  }).commit();
}
let conversions = 0;
configureAiTransportHost({
  transformTransportMessages: (...args) => {
    conversions++;
    return transformTransportMessages(...args);
  },
  immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
});
const model: Model = {
  id: "synthetic-model",
  name: "Synthetic",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  timestamp: 1,
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const providerHistory: Context["messages"] = [];
if (values["provider-requests"]) {
  for (let index = 0; index < 200; index++) {
    providerHistory.push(
      { role: "user", timestamp: index, content: `Question ${index} `.padEnd(1024, "u") },
      {
        ...assistant([
          {
            type: "toolCall",
            id: `call_${index}`,
            name: "lookup",
            arguments: { query: `query ${index}`.padEnd(2048, "q") },
          },
        ]),
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolName: "lookup",
        toolCallId: `call_${index}`,
        timestamp: index,
        isError: false,
        content: [{ type: "text", text: `result ${index}`.padEnd(8192, "r") }],
      },
    );
  }
  providerHistory.forEach(freezeJsonSnapshot);
}
const providerFixtures = values["provider-requests"]
  ? sessionKeys.map((sessionKey, index) => {
      const identity = { sessionId: sessionKey, authProfileId: "synthetic-profile" };
      const options = { ...identity, replayResponsesItemIds: true };
      const checkpoint = assistant([]);
      captureOpenAIResponsesCompaction(
        checkpoint,
        { type: "compaction", encrypted_content: "synthetic-checkpoint" },
        0,
        model,
        buildOpenAIResponsesReasoningReplayMetadata(model, identity),
      );
      freezeJsonSnapshot(checkpoint);
      const context: Context = {
        systemPrompt: prompts[index],
        preparedSystemPrompt: prepareSystemPrompt(prompts[index]!),
        messages: [
          checkpoint,
          ...providerHistory.map((message) => freezeJsonSnapshot({ ...message })),
        ],
        tools: [
          {
            name: "lookup",
            description: "Read synthetic records",
            parameters: Type.Object({ query: Type.String() }),
          },
        ],
      };
      const lastRequest = buildOpenAIResponsesParams(model, context, options);
      const measured = assistant([
        { type: "text", text: "Completed inspection", textSignature: "msg_measured" },
      ]);
      measured.usage.contextUsage = {
        state: "available",
        promptTokens: 100_000,
        totalTokens: 100_100,
      };
      recordResponsesContextUsage(measured, model, identity, lastRequest, [], "transport");
      context.messages.push(
        freezeJsonSnapshot(measured),
        freezeJsonSnapshot({
          role: "user" as const,
          content: "Continue inspection",
          timestamp: 999,
        }),
      );
      const continuation: ResponsesContinuationState = {
        lastRequest,
        lastResponseId: "resp_measured",
        lastResponseItems: [
          {
            type: "message",
            id: "msg_measured",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "Completed inspection", annotations: [], logprobs: [] },
            ],
          },
        ],
      };
      return { context, options, continuation };
    })
  : [];
function providerRequest(index: number, systemPrompt: string) {
  const fixture = providerFixtures[index]!;
  const context = { ...fixture.context, systemPrompt };
  const pressure = resolveProjectedRequestPressure({
    context,
    contextTokenBudget: 200_000,
    reserveTokens: 0,
    replay: { model, ...fixture.options },
  });
  const full = buildOpenAIResponsesParams(model, context, fixture.options);
  const continued = resolveResponsesContinuationRequest(fixture.continuation, full);
  assert.equal(pressure.pressureSource, "provider_context_usage");
  assert.equal(pressure.route, "fits");
  assert.equal(continued.continuationStatus, "continued");
  assert.equal(continued.request.previous_response_id, "resp_measured");
  return { full, wire: continued.request, pressure };
}
function preparePrompt(index: number, entries = history) {
  const prepared = prepareSessionSystemPrompt({
    state: continuationLeases[index]!.state,
    routeKey: "synthetic-route",
    systemPrompt: prompts[index]!,
    entries,
    historyBoundaryCount: 1,
  });
  prepared.commit();
  assert.equal(prepared.systemPrompt, prompts[index]);
  assert.equal(prepared.update, undefined);
  return prepared;
}
function verifyProviderRequests() {
  const full = createHash("sha256");
  const wire = createHash("sha256");
  const pressure = createHash("sha256");
  for (let index = 0; index < providerFixtures.length; index++) {
    const result = providerRequest(index, preparePrompt(index).systemPrompt);
    full.update(hash("sha256", JSON.stringify(result.full)));
    wire.update(hash("sha256", JSON.stringify(result.wire)));
    pressure.update(hash("sha256", JSON.stringify(result.pressure)));
  }
  return {
    fullRequestSha256: full.digest("hex"),
    wireSha256: wire.digest("hex"),
    pressureSha256: pressure.digest("hex"),
  };
}
const providerHashes = values["provider-requests"] ? verifyProviderRequests() : undefined;
let branchReads = 0;
const getEntries = () => {
  branchReads++;
  return manager.getBranch();
};
// The baseline owner predates universal pinning: it takes route parameters and reads the branch.
type BaselineBegin = (params: {
  state: typeof lease.state;
  routeKey: string;
  enabled: boolean;
  entries: unknown;
  getEntries: () => unknown;
}) => boolean;
function runOne() {
  if (continuations) {
    const index = operation++;
    const session = index % continuationLeases.length;
    const prepared = preparePrompt(
      session,
      Math.floor(index / continuationLeases.length) % 2 ? compactedHistory : history,
    );
    if (values["provider-requests"]) {
      providerRequest(session, prepared.systemPrompt);
    }
    return prepared.restart;
  }
  if (values["baseline-source"]) {
    // SAFETY: --baseline-source replaces this module with the historical owner and its signature.
    return (beginSessionSystemPrompt as unknown as BaselineBegin)({
      state: lease.state,
      routeKey: "synthetic-route",
      enabled: !values.disabled,
      entries: getEntries(),
      getEntries,
    });
  }
  // Every route now pins its series; beginning one no longer reads the branch.
  beginSessionSystemPrompt(lease.state);
  return false;
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
const inspector = new Session();
try {
  for (let index = 0; index < Math.max(200, continuationLeases.length * 2); index++) {
    const restarted = runOne();
    if (!continuations) {
      assert.equal(restarted, false);
    }
  }
  branchReads = 0;
  conversions = 0;
  globalThis.gc?.();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: values["provider-requests"] ? 8192 : 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  let retirements = 0;
  for (let index = 0; index < iterations; index++) {
    retirements += Number(runOne());
  }
  const elapsedMs = performance.now() - start;
  const usedCpu = process.threadCpuUsage(cpu);
  const allocatedBytes = values.allocation
    ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  const measuredConversions = conversions;
  if (providerHashes) {
    assert.deepEqual(verifyProviderRequests(), providerHashes);
  }
  if (!continuations || !values["baseline-source"]) {
    assert.equal(retirements, 0);
  }
  assert.equal(branchReads, !continuations && values["baseline-source"] ? iterations : 0);
  console.log(
    JSON.stringify({
      revision: values["baseline-source"] ? "base" : "candidate",
      mode: values.allocation ? "allocation" : "timing",
      enabled: !values.disabled,
      continuations,
      sessions: continuations ? sessions : 1,
      providerRequests: values["provider-requests"],
      providerMessages: providerHistory.length,
      providerHashes,
      conversionsPerRequest: values["provider-requests"]
        ? measuredConversions / iterations
        : undefined,
      retirements,
      entryCount,
      iterations,
      branchReads,
      elapsedMs,
      wallUsPerRequest: (elapsedMs * 1000) / iterations,
      cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      mainThreadCpuUsPerRequest: (usedCpu.user + usedCpu.system) / iterations,
      sampledBytesPerRequest:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      allocatedBytes,
      hostLoad,
      node: process.version,
    }),
  );
} finally {
  inspector.disconnect();
  lease[Symbol.dispose]();
  for (const retained of continuationLeases) {
    retained[Symbol.dispose]();
  }
}
