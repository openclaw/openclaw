/**
 * Actual SDK session prompts -> default OpenAI policy -> Responses SDK -> synthetic SSE fetch.
 * Save the original extensions/openai/responses-stream.runtime.ts beside itself, then:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/responses-policy-fingerprint-measure.ts
 *   --baseline extensions/openai/.lane2106-responses-stream-baseline.ts
 * Acceptance: identical wire/input/replay fingerprints; no warm historical JSON encodings
 * or editable-input clones; lower CPU and sampled allocations (including collected objects).
 * Five counterbalanced A/A pairs per side; timing and allocation collected separately.
 * Baseline is exact original provider source; both sides use the current SDK session owner.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AssistantMessage, Context, Model } from "../../packages/llm-core/src/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    rounds: { type: "string", default: "20" },
    entries: { type: "string", default: "120" },
    samples: { type: "string", default: "5" },
  },
});
assert(values.baseline, "Supply an exact original OpenAI stream module adjacent to its owner");
assert(globalThis.gc, "Use --expose-gc");
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const rounds = integer(values.rounds, "rounds");
const entries = integer(values.entries, "entries");
const samples = integer(values.samples, "samples");
const artifactRoot = resolve(".local/lane2106-r261/session-bench");
await mkdir(artifactRoot, { recursive: true });
const root = await mkdtemp(artifactRoot + "/state-");
process.env.OPENCLAW_STATE_DIR = root;

const { configureAiTransportHost, createAiTransportHost, runWithAiTransportHost } =
  await import("../../packages/ai/src/host.js");
const { createOpenAIResponsesTransportStreamFn } =
  await import("../../packages/ai/src/transports/openai-responses-client.js");
const { captureOpenAIResponsesCompaction, buildOpenAIResponsesReasoningReplayMetadata } =
  await import("../../packages/ai/src/transports/openai-responses-compaction-replay.js");
const { cleanupSessionResources } = await import("../../packages/ai/src/session-resources.js");
const { AssistantMessageEventStream } = await import("../../packages/ai/src/utils/event-stream.js");
const { freezeJsonSnapshot, isDeeplyFrozenPlainData } =
  await import("../../src/shared/immutable-data.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const { SettingsManager } = await import("../../src/agents/sessions/settings-manager.js");
const { ModelRegistry } = await import("../../src/agents/sessions/model-registry.js");
const { AuthStorage } = await import("../../src/agents/sessions/auth-storage.js");
const { DefaultResourceLoader } = await import("../../src/agents/sessions/resource-loader.js");
const policy = await import("../../src/llm/providers/stream-wrappers/openai.js");
const { createAgentSession } = await import("../../src/agents/sessions/sdk.js");
const { buildAgentRuntimePlan } = await import("../../src/agents/runtime-plan/build.js");
const { buildAgentRuntimeAuthPlan } = await import("../../src/agents/runtime-plan/auth.js");
const { buildOpenAIProvider } = await import("../../extensions/openai/api.js");
const provider = buildOpenAIProvider();
const candidateWrapper = provider.wrapStreamFn;
assert(candidateWrapper);
// The archived baseline is loaded beside its owner so its relative imports stay exact.
const baselineModule = await import(pathToFileURL(resolve(values.baseline)).href);
const owners: Record<string, typeof candidateWrapper> = {
  baseline: baselineModule.wrapOpenAIResponsesStream,
  candidate: candidateWrapper,
};
// SDK's lazy host installer must run before selecting the synthetic scoped fetch owner.
await import("../../src/agents/ai-transport-runtime-host.js");
const model = {
  id: "gpt-5.6-luna",
  name: "Synthetic",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model;
const sessionId = "synthetic-session-fingerprint";
const usage = {
  input: 10,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage,
  stopReason: "stop",
  timestamp: 0,
});
function fixture() {
  const checkpoint = assistant([]);
  captureOpenAIResponsesCompaction(
    checkpoint,
    { type: "compaction", id: "cmp_synthetic", encrypted_content: "synthetic checkpoint" },
    0,
    model,
    buildOpenAIResponsesReasoningReplayMetadata(model, { sessionId }),
  );
  const messages: Context["messages"] = [freezeJsonSnapshot(checkpoint)];
  for (let i = 0; i < entries; i++) {
    messages.push(
      freezeJsonSnapshot({ role: "user" as const, content: `question ${i}`, timestamp: i }),
      freezeJsonSnapshot(
        assistant([
          { type: "toolCall", id: `call_${i}`, name: "lookup", arguments: { query: `item ${i}` } },
        ]),
      ),
      freezeJsonSnapshot({
        role: "toolResult" as const,
        toolCallId: `call_${i}`,
        toolName: "lookup",
        content: [
          {
            type: "text" as const,
            text: `SYNTHETIC_OUTPUT_${i}: ${"synthetic output ".repeat(512)}`,
          },
        ],
        isError: false,
        timestamp: i,
      }),
    );
  }
  return messages;
}
const sse = [
  { type: "response.created", response: { id: "resp_synthetic" } },
  {
    type: "response.completed",
    response: {
      id: "resp_synthetic",
      output: [
        {
          type: "message",
          id: "msg_synthetic",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    },
  },
]
  .map((event) => `data: ${JSON.stringify(event)}\n\n`)
  .join("");
let wire = "";
let requests = 0;
let fetchFailure = "";
let warmRequest = { inputItems: 0, wireBytes: 0 };
const host = createAiTransportHost({
  immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
  requiresManagedTransport: () => true,
  buildModelFetch: () => async (_url, init) => {
    const body = init?.body;
    assert(typeof body === "string" || body instanceof Uint8Array);
    wire =
      typeof body === "string"
        ? body
        : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString();
    requests++;
    return new Response(
      sse
        .replaceAll("resp_synthetic", `resp_synthetic_${requests}`)
        .replaceAll("msg_synthetic", `msg_synthetic_${requests}`),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
// ModelRegistry's runtime owns the process-default host, rather than its caller's scope.
configureAiTransportHost(host);
globalThis.fetch = async () => {
  fetchFailure = "Unexpected global network fetch";
  throw new Error(fetchFailure);
};
type SessionFixture = Awaited<ReturnType<typeof prepare>>;
async function prepare(side: string) {
  cleanupSessionResources();
  requests = 0;
  const header = SessionManager.inMemory(root).getHeader();
  assert(header);
  const manager = SessionManager.fromEntries([{ ...header, id: sessionId }], root);
  const auth = AuthStorage.inMemory();
  auth.setRuntimeApiKey(model.provider, "synthetic-key");
  const registry = ModelRegistry.inMemory(auth);
  const stream = createOpenAIResponsesTransportStreamFn();
  registry.registerProvider(model.provider, {
    api: model.api,
    streamSimple: (...args) => {
      const result = stream(...args);
      assert(result instanceof AssistantMessageEventStream);
      return result;
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root + "/agent",
    extensionFactories: [
      (api) => {
        api.on("tool_result", () => undefined);
      },
    ],
  });
  await resourceLoader.reload();
  assert.equal(resourceLoader.getExtensions().errors.length, 0);
  const { session } = await createAgentSession({
    model,
    thinkingLevel: "low",
    systemPrompt: "Stable synthetic instructions",
    tools: [],
    sessionManager: manager,
    modelRegistry: registry,
    resourceLoader,
    settingsManager: SettingsManager.inMemory({
      transport: "sse",
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });
  assert(!session.extensionRunner.hasHandlers("before_provider_request"));
  assert.equal(typeof session.agent.onPayload, "function");
  session.agent.streamFn = policy.createOpenAITextVerbosityWrapper(
    policy.createOpenAIFastModeWrapper(
      policy.createOpenAIResponsesContextManagementWrapper(session.agent.streamFn, {}),
    ),
    "low",
  );
  const modelRoute = {
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    authRequirement: "api-key" as const,
    requestTransportOverrides: "none" as const,
  };
  const providerRuntimeHandle = {
    prepared: true as const,
    provider: model.provider,
    modelId: model.id,
    workspaceDir: root,
    plugin: provider,
  };
  const plan = buildAgentRuntimePlan({
    config: {},
    provider: model.provider,
    modelId: model.id,
    model,
    harnessRuntime: "openclaw",
    workspaceDir: root,
    agentDir: root + "/agent",
    preparedAuthPlan: buildAgentRuntimeAuthPlan({
      provider: model.provider,
      modelId: model.id,
      providerAuthAliasesEnabled: false,
      modelRoute,
    }),
    providerRuntimeHandle,
  });
  const extraParams = plan.transport.resolveExtraParams();
  assert.deepEqual(extraParams.accessPrograms, { cyber: "standard" });
  const wrapped = owners[side]!({
    provider: model.provider,
    modelId: model.id,
    model,
    streamFn: session.agent.streamFn,
    nativeWebSearchAllowedByToolPolicy: false,
    extraParams,
  });
  assert(wrapped);
  session.agent.streamFn = wrapped;
  session.agent.state.messages = fixture();
  await session.prompt("warm synthetic turn");
  const warmed = session.agent.state.messages.at(-1);
  assert(warmed?.role === "assistant");
  assert.equal(warmed.stopReason, "stop", `${warmed.errorMessage}: ${fetchFailure}`);
  warmRequest = {
    inputItems: (JSON.parse(wire) as { input: unknown[] }).input.length,
    wireBytes: Buffer.byteLength(wire),
  };
  return session;
}
async function run(session: SessionFixture) {
  const before = requests;
  for (let index = 0; index < rounds; index++) {
    await session.prompt(`next synthetic turn ${index}`);
    const result = session.agent.state.messages.at(-1);
    assert(result?.role === "assistant");
    assert.equal(result.stopReason, "stop", result.errorMessage ?? "Synthetic turn failed");
  }
  assert.equal(requests - before, rounds);
}
function fingerprint(session: SessionFixture) {
  const request = JSON.parse(wire) as { input: unknown[]; access_programs: unknown };
  assert.deepEqual(request.access_programs, { cyber: "standard" });
  const result = session.agent.state.messages.at(-1);
  assert(result);
  return {
    wireHash: hash("sha256", wire),
    inputHash: hash("sha256", JSON.stringify(request.input)),
    replay: Reflect.get(result, "openclawResponsesInputReplay"),
    inputItems: request.input.length,
    wireBytes: Buffer.byteLength(wire),
  };
}
function ownedAllocations(profile: HeapProfiler.SamplingHeapProfile) {
  let canonical = 0;
  let clones = 0;
  let total = 0;
  const walk = (
    node: HeapProfiler.SamplingHeapProfileNode,
    inCanonical = false,
    inClone = false,
  ) => {
    const canonicalFrame =
      inCanonical ||
      /^(responsesContinuationPrefixFingerprint|contextFingerprint|sha256StableValue|writeStableStringify|stringifyStableValue)$/.test(
        node.callFrame.functionName,
      );
    const cloneFrame =
      inClone || node.callFrame.functionName === "cloneResponsesInputForPayloadHook";
    total += node.selfSize;
    if (canonicalFrame) {
      canonical += node.selfSize;
    }
    if (cloneFrame) {
      clones += node.selfSize;
    }
    for (const child of node.children) {
      walk(child, canonicalFrame, cloneFrame);
    }
  };
  walk(profile.head);
  return {
    allocationBytes: total / rounds,
    canonicalAllocationBytes: canonical / rounds,
    editableInputAllocationBytes: clones / rounds,
  };
}
const inspector = new Session();
inspector.connect();
try {
  await runWithAiTransportHost(host, async () => {
    console.log(
      JSON.stringify({
        node: process.version,
        rounds,
        samples,
        entries,
        fixtureMessages: entries * 3 + 1,
      }),
    );
    let golden: ReturnType<typeof fingerprint> | undefined;
    for (const side of ["baseline", "candidate"]) {
      const session = await prepare(side);
      try {
        await inspector.post("Profiler.enable");
        await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
        let historicalEncodings = 0;
        const original = JSON.stringify;
        JSON.stringify = new Proxy(original, {
          apply(target, receiver, args: unknown[]) {
            if (typeof args[0] === "string" && args[0].startsWith("SYNTHETIC_OUTPUT_")) {
              historicalEncodings++;
            }
            return Reflect.apply(target, receiver, args);
          },
        });
        try {
          await run(session);
        } finally {
          JSON.stringify = original;
        }
        const coverage = (await inspector.post("Profiler.takePreciseCoverage")).result;
        await inspector.post("Profiler.stopPreciseCoverage");
        await inspector.post("Profiler.disable");
        const countNames = [
          "sha256StableValue",
          "responsesContinuationPrefixFingerprint",
          "contextFingerprint",
          "cloneResponsesInputForPayloadHook",
        ];
        const counts = Object.fromEntries(
          countNames.map((name) => [
            name,
            coverage
              .flatMap((script) => script.functions)
              .filter((fn) => fn.functionName === name)
              .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0),
          ]),
        );
        const observed = fingerprint(session);
        assert(
          (counts.responsesContinuationPrefixFingerprint ?? 0) > 0,
          "Fingerprint instrumentation missed real transport work",
        );
        if (side === "candidate") {
          assert.equal(historicalEncodings, 0);
          assert.equal(counts.cloneResponsesInputForPayloadHook, 0);
        } else {
          assert(historicalEncodings >= entries * rounds);
          assert((counts.cloneResponsesInputForPayloadHook ?? 0) > 0);
        }
        if (golden) {
          assert.deepEqual(observed, golden, "Wire or persisted fingerprint semantics changed");
        }
        golden = observed;
        console.log(
          JSON.stringify({
            kind: "counts",
            side,
            historicalEncodings,
            counts,
            warmRequest,
            ...observed,
          }),
        );
      } finally {
        session.dispose();
      }
    }
    for (let sample = 0; sample < samples; sample++) {
      const arms =
        sample % 2 === 0
          ? ["baseline-A1", "candidate-A1", "baseline-A2", "candidate-A2"]
          : ["candidate-A2", "baseline-A2", "candidate-A1", "baseline-A1"];
      for (const arm of arms) {
        const side = arm.split("-")[0]!;
        const timing = await prepare(side);
        let wallMs: number;
        let cpuUs: number;
        try {
          globalThis.gc!();
          const cpu0 = process.cpuUsage();
          const start = performance.now();
          await run(timing);
          wallMs = performance.now() - start;
          const cpu = process.cpuUsage(cpu0);
          cpuUs = cpu.user + cpu.system;
          assert.deepEqual(fingerprint(timing), golden);
        } finally {
          timing.dispose();
        }
        const allocation = await prepare(side);
        try {
          globalThis.gc!();
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          await run(allocation);
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          assert.deepEqual(fingerprint(allocation), golden);
          console.log(
            JSON.stringify({
              kind: "sample",
              sample,
              arm,
              cpuUs: cpuUs / rounds,
              wallUs: (wallMs * 1000) / rounds,
              ...ownedAllocations(profile),
              load: loadavg(),
            }),
          );
        } finally {
          allocation.dispose();
        }
      }
    }
  });
} finally {
  inspector.disconnect();
  cleanupSessionResources();
  await rm(root, { recursive: true, force: true });
}
