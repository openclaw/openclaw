import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { expectCallCount as expectCalls } from "../../test-utils/mock-call-assertions.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";
import type { BlockReplyPayload } from "../embedded-agent-payloads.js";
import type { AgentHarness } from "../harness/types.js";
import { captureAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import { completionConfig, completionModelDefinition } from "../simple-completion.test-support.js";
import { buildEmbeddedRunnerAssistant } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedAcquireAgentRunPreparedModelRuntime as acquire,
  mockedBuildEmbeddedRunPayloads as buildPayloads,
  mockedRunEmbeddedAttempt as attempt,
  createOverflowRunParams,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import {
  createFreshRunIntegrationState,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let InitialAdmissionError: typeof import("../prepared-model-runtime.errors.js").PreparedModelRuntimeInitialRunAdmissionError;
let OwnerNotPublishedError: typeof import("../prepared-model-runtime.errors.js").PreparedModelRuntimeOwnerNotPublishedError;
let runAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let registerHarness: typeof import("../harness/registry.js").registerAgentHarness;

function run(overrides: Partial<Parameters<typeof runAgent>[0]> = {}) {
  return runAgent({ ...fixtureRunParams(), ...overrides });
}
function emptyAttempt(result: Parameters<typeof makeAttemptResult>[0]) {
  return makeAttemptResult({ assistantTexts: [], ...result });
}
function queueRefresh(result: Parameters<typeof makeAttemptResult>[0]) {
  attempt.mockImplementationOnce(async (params) => {
    requestRefresh(params);
    return emptyAttempt(result);
  });
}
function finalAttempt(text: string) {
  attempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: [text] }));
}
function assistant(text: string) {
  return buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
}
const succeeded = (...names: string[]) => names.map((toolName) => ({ toolName, isError: false }));
const userMessage = (content: string, timestamp = 1) => ({
  role: "user" as const,
  content,
  timestamp,
});
const completedItem = { startedCount: 1, completedCount: 1, activeCount: 0 };
const textPayloads = ({ assistantTexts }: { assistantTexts: string[] }) =>
  assistantTexts.map((text) => ({ text }));
function delivered(payload: { text: string; mediaUrls?: string[] }, to = "telegram:123") {
  return {
    toolMetas: succeeded("message", "plugins"),
    didSendViaMessagingTool: true,
    messagingToolSentTexts: [payload.text],
    messagingToolSentMediaUrls: payload.mediaUrls ?? [],
    messagingToolSentTargets: [{ tool: "message", provider: "telegram", to, ...payload }],
  };
}
function tokenUsage(input: number, output: number, cost?: number) {
  return {
    input,
    output,
    total: input + output,
    cost: cost === undefined ? undefined : { total: cost },
  };
}
function acquireRuntime() {
  return acquire({
    agentId: "main",
    agentDir: state.agentDir(),
    config: {},
    workspaceDir: state.workspaceDir,
  });
}
function fixtureRunParams() {
  return {
    ...createOverflowRunParams(state),
    agentHarnessId: "openclaw",
    provider: "fixture-provider",
    model: "fixture-model",
    sessionKey: undefined,
  };
}
function requestRefresh(
  params: Pick<Parameters<AgentHarness["runAttempt"]>[0], "registerPluginRuntimeRefreshConsumer">,
) {
  params.registerPluginRuntimeRefreshConsumer?.(() => true);
  expect(captureAgentPluginRuntimeRefresh().request()).toBe(true);
}
function expectOneLifecycleEvent(events: ReturnType<typeof vi.fn>, phase: string) {
  expect(
    events.mock.calls.filter(
      ([event]) => event.stream === "lifecycle" && event.data.phase === phase,
    ),
  ).toHaveLength(1);
}
function settledWrite(): EmbeddedRunAttemptResult["messagesSnapshot"] {
  const id = "committed-write";
  const args = { path: "receipt.txt", content: "AMBER-731" };
  return [
    buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "write", arguments: args }],
    }),
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "write",
      content: [{ type: "text", text: "Created receipt AMBER-731." }],
      isError: false,
      timestamp: 2,
    },
  ];
}

beforeAll(async () => {
  runAgent = await loadSharedRunIntegrationHarness();
  ({
    PreparedModelRuntimeInitialRunAdmissionError: InitialAdmissionError,
    PreparedModelRuntimeOwnerNotPublishedError: OwnerNotPublishedError,
  } = await import("../prepared-model-runtime.errors.js"));
  ({ registerAgentHarness: registerHarness } = await import("../harness/registry.js"));
});

beforeEach(async () => {
  state = await createFreshRunIntegrationState("plugin-runtime-refresh");
});

afterEach(async () => {
  attempt.mockReset();
  acquire.mockReset();
  await state?.cleanup();
});

it.each([false, true])(
  "wraps only initial admission refusals (committed: %s)",
  async (committed) => {
    const refusal = new OwnerNotPublishedError("Model runtime replacement is in progress", {
      admissionBlocked: true,
    });
    if (committed) {
      const base = await acquireRuntime();
      acquire.mockClear();
      acquire.mockResolvedValueOnce(base);
      queueRefresh({ toolMetas: succeeded("write", "plugins") });
    }
    acquire.mockRejectedValueOnce(refusal);
    const onAttemptStart = vi.fn();
    const pending = run({ onAttemptStart });
    if (committed) {
      await expect(pending).rejects.toBe(refusal);
    } else {
      const error = await pending.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InitialAdmissionError);
      expect(error).toMatchObject({ admissionBlocked: true, cause: refusal });
    }
    expect(acquire).toHaveBeenCalledTimes(committed ? 2 : 1);
    expectCalls(committed ? 1 : 0, onAttemptStart, attempt);
  },
);

it("retains settled work from an overloaded attempt through a later plugin refresh", async () => {
  const originalPrompt = "write the receipt, reload the plugin, then report the receipt ID";
  const originalMessage = userMessage(originalPrompt);
  const settledMessages = settledWrite();
  const refreshedMessage = assistant("Plugin refreshed; receipt verification remains.");
  attempt.mockResolvedValueOnce(
    emptyAttempt({
      messagesSnapshot: settledMessages,
      toolMetas: [{ toolName: "write", toolCallId: "committed-write", isError: false }],
      itemLifecycle: completedItem,
      terminal: {
        kind: "failed",
        source: "prompt",
        error: Object.assign(new Error("server_overloaded: server is overloaded"), {
          status: 503,
          code: "server_overloaded",
        }),
      },
    }),
  );
  attempt.mockImplementationOnce(async (params) => {
    expect(params.continuation).toEqual({ prompt: originalPrompt, messages: settledMessages });
    requestRefresh(params);
    return emptyAttempt({
      pluginRuntimeRefreshMessages: [originalMessage, refreshedMessage],
      toolMetas: succeeded("plugins"),
    });
  });
  attempt.mockImplementationOnce(async (params) => {
    expect(params.pluginRuntimeRefreshMessages).toEqual([
      ...settledMessages,
      originalMessage,
      refreshedMessage,
    ]);
    expect(params.continuation).toBeUndefined();
    return makeAttemptResult({ assistantTexts: ["Receipt AMBER-731 verified."] });
  });
  const result = await run({ prompt: originalPrompt });
  expect(result.meta.error).toBeUndefined();
  expect(attempt).toHaveBeenCalledTimes(3);
});

it.each([true, false])("preserves refresh usage totals (CLI priced: %s)", async (priced) => {
  const cliDispatch = await import("./cli-backend-dispatch.js");
  const terminalUsage = tokenUsage(30, 3, priced ? 0.2 : undefined);
  using dispatch = vi
    .spyOn(cliDispatch, "runEmbeddedAgentViaCliBackendIfEligible")
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({
      payloads: [{ text: "Receipt verified." }],
      meta: {
        durationMs: 1,
        stopReason: "completed",
        agentMeta: {
          sessionId: "test-session",
          provider: "cli-provider",
          model: "cli-model",
          contextTokens: 64_000,
          promptTokens: 30,
          usage: terminalUsage,
          diagnosticUsage: tokenUsage(300, 30, priced ? 0.4 : undefined),
          lastCallUsage: terminalUsage,
        },
      },
    });
  queueRefresh({
    toolMetas: succeeded("plugins"),
    attemptUsage: tokenUsage(100, 10, 0.1),
  });

  const result = await run();

  expect(result.payloads).toEqual([{ text: "Receipt verified." }]);
  expect(result.meta.agentMeta).toMatchObject({
    provider: "cli-provider",
    model: "cli-model",
    contextTokens: 64_000,
    promptTokens: 30,
    usage: { input: 130, output: 13, total: 143 },
    diagnosticUsage: { input: 400, output: 40, total: 440 },
    lastCallUsage: terminalUsage,
  });
  for (const [usage, expected] of [
    [result.meta.agentMeta?.usage, 0.3],
    [result.meta.agentMeta?.diagnosticUsage, 0.5],
  ] as const) {
    const cost = estimateAggregateUsageCost({
      usage,
      cost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    });
    if (priced) {
      expect(cost).toBeCloseTo(expected, 9);
    } else {
      expect(cost).toBeUndefined();
    }
  }
  expect(attempt).toHaveBeenCalledOnce();
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it("preserves same-route text delivery dedupe across refresh", async () => {
  const text = "The requested result was delivered by the original plugin generation.";
  const payload = { text };
  queueRefresh(delivered(payload));
  finalAttempt(text);
  buildPayloads.mockReturnValue([payload]);
  const onAttemptStart = vi.fn();
  const result = await run({
    prompt: "send the result, reload the plugin, then verify the result",
    onAttemptStart,
  });
  expect(result.meta.error).toBeUndefined();
  expect(attempt.mock.calls[1]?.[0]?.pluginRuntimeRefreshMessages).toEqual([]);
  expectCalls(2, attempt, onAttemptStart);
  const final = await buildReplyPayloads({
    payloads: result.payloads ?? [],
    messagingToolSentTexts: result.messagingToolSentTexts,
    messagingToolSentMediaUrls: result.messagingToolSentMediaUrls,
    messagingToolSentTargets: result.messagingToolSentTargets,
    messageProvider: "telegram",
    originatingTo: "telegram:123",
    blockStreamingEnabled: false,
    blockReplyPipeline: null,
    replyToMode: "off",
  });
  expect(final.replyPayloads).toEqual([]);
});

it("reacquires generations while preserving run authority, committed work, and one terminal", async () => {
  const { getPluginRuntimeGatewayRequestScope, withPluginRuntimeGatewayRequestScope } =
    await import("../../plugins/runtime/gateway-request-scope.js");
  const { getPluginRuntimeGenerationRegistry, withPluginRuntimeGenerationScope } =
    await import("../../plugins/runtime/generation-scope.js");
  const {
    getPreparedModelRuntimeBorrowedSnapshot,
    getPreparedModelRuntimePluginGeneration,
    withPreparedModelRuntimePluginGenerationScope,
  } = await import("../prepared-model-runtime-generation-scope.js");
  const { getAgentRunContext } = await import("../../infra/agent-run-registry.js");
  const runParams = fixtureRunParams();
  const originalPrompt = "edit and reload twice";
  const originalMessage = userMessage(originalPrompt);
  const onUserMessagePersisted = vi.fn();
  const onAgentEvent = vi.fn();
  const base = await acquireRuntime();
  // Distinct registries prove that an old ambient owner cannot supply the next generation.
  // oxlint-disable-next-line no-map-spread -- Every generation needs an independent registry, not mutations of its predecessor.
  const snapshots = ["first", "next", "final"].map((policyHash) => ({
    ...base.snapshot,
    metadataSnapshot: {
      ...base.snapshot.metadataSnapshot,
      policyHash,
      workspaceDir: state.workspaceDir,
    },
    pluginRegistry: {
      ...base.snapshot.pluginRegistry!,
      tools: [...(base.snapshot.pluginRegistry?.tools ?? [])],
    },
  }));
  const first = snapshots[0]!;
  const generation: PreparedModelRuntimePluginGeneration = {
    remoteCatalog: null,
    configuredCatalogEntries: [],
    inlineProviderModels: [],
    pluginMetadataSnapshot: first.metadataSnapshot,
    pluginRegistry: first.pluginRegistry,
  };
  const releases = snapshots.map(() => vi.fn(async () => {}));
  const caller = { isWebchatConnect: () => false, invokeWithSessionNodeAuthority: vi.fn() };
  acquire.mockClear();
  let admittedOwner: unknown;
  const staleOwners: ReturnType<typeof captureAgentPluginRuntimeRefresh>[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    acquire.mockImplementationOnce(async () => {
      if (index > 0) {
        expect(releases[index - 1]).toHaveBeenCalledOnce();
        expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
        expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBeUndefined();
        expect(getPluginRuntimeGatewayRequestScope()?.invokeWithSessionNodeAuthority).toBe(
          caller.invokeWithSessionNodeAuthority,
        );
      }
      return { ...base, snapshot, [Symbol.asyncDispose]: releases[index]! };
    });
    attempt.mockImplementationOnce(async (params) => {
      // This fixture replaces attempt execution; the real embedded consumer is covered by the agent loop tests.
      params.registerPluginRuntimeRefreshConsumer?.(() => true);
      if (index === 0) {
        admittedOwner = getAgentRunContext(params.runId)?.delegatedAuthority;
        expect(admittedOwner).toBeDefined();
        expect(params.prompt).toBe(originalPrompt);
        params.onUserMessagePersisted?.(originalMessage);
      } else {
        expect(getAgentRunContext(params.runId)?.delegatedAuthority).toBe(admittedOwner);
        expect(params.prompt).toContain("Continue the current task from the transcript");
        expect(params.prompt).not.toContain(originalPrompt);
        expect(params.pluginRuntimeRefreshMessages).toEqual(
          Array.from({ length: index }, (_, previous) =>
            userMessage(`committed effect ${previous}`, previous),
          ),
        );
        expect(params).toMatchObject({
          skipPreparedUserTurnMessage: true,
          suppressNextUserMessagePersistence: true,
        });
        for (const stale of staleOwners) {
          expect(() => stale.assertCurrent()).toThrow("Plugin runtime changed");
        }
      }
      expect(params.sessionId).toBe("test-session");
      expect(getPluginRuntimeGenerationRegistry()).toBe(snapshot.pluginRegistry);
      params.hostCapabilities?.assertActive();
      if (index < 2) {
        const owner = captureAgentPluginRuntimeRefresh();
        staleOwners.push(owner);
        expect(owner.request()).toBe(true);
        return emptyAttempt({
          sessionIdUsed: params.sessionId,
          pluginRuntimeRefreshMessages: [userMessage(`committed effect ${index}`, index)],
          toolMetas: [
            { toolName: " plugins ", isError: false },
            { toolName: "failed", isError: true },
            { toolName: "unknown" },
            ...(index === 1 ? [{ toolName: "read", isError: false }] : []),
          ],
          successfulNestedToolNames: index === 0 ? ["zeta", "alpha", "plugins"] : ["beta"],
        });
      }
      return makeAttemptResult({
        assistantTexts: ["new behavior verified"],
        sessionIdUsed: params.sessionId,
        toolMetas: succeeded("final_check"),
      });
    });
  }
  buildPayloads.mockReturnValue([{ text: "new behavior verified" }]);
  const result = await withPluginRuntimeGatewayRequestScope(caller, () =>
    withPreparedModelRuntimePluginGenerationScope(
      generation,
      () =>
        withPluginRuntimeGenerationScope(first, () =>
          runAgent({
            ...runParams,
            prompt: originalPrompt,
            onUserMessagePersisted,
            onAgentEvent,
          }),
        ),
      () => first as NonNullable<ReturnType<typeof getPreparedModelRuntimeBorrowedSnapshot>>,
    ),
  );
  expect(result.payloads).toEqual([{ text: "new behavior verified" }]);
  expect(result.meta.agentMeta?.terminalReceipt).toMatchObject({
    runId: runParams.runId,
    sessionId: "test-session",
    successfulToolNames: ["plugins", "alpha", "zeta", "read", "beta", "final_check"],
  });
  expectCalls(3, attempt, acquire);
  expect(onUserMessagePersisted).toHaveBeenCalledExactlyOnceWith(originalMessage);
  expectOneLifecycleEvent(onAgentEvent, "end");
  for (const release of releases) {
    expect(release).toHaveBeenCalledOnce();
  }
  finalAttempt("separate operator turn");
  const next = await runAgent({ ...createOverflowRunParams(state), prompt: "new task" });
  expect(next.meta.agentMeta?.terminalReceipt?.successfulToolNames).toEqual([]);
});
it.each(["generated", "host-owned", "tts", "foreign-tts"])(
  "retains %s media provenance",
  async (kind) => {
    useOpenAIPlatformAuthFixture();
    const { getReplyPayloadMetadata } = await import("../../auto-reply/reply-payload.js");
    const { markCoreTtsAttemptResult } = await import("../tools/tts-tool-result-provenance.js");
    const { createOperationalRunInstanceRef, prepareAgentRunAdmission } =
      await import("../admitted-run-context.js");
    const runParams = createOverflowRunParams(state);
    const selected = "https://example.test/selected-output.opus";
    const alternate = "https://example.test/alternate-output.opus";
    const audio = kind === "tts" || kind === "foreign-tts";
    const mediaUrls = audio ? [selected] : [selected, alternate];
    const finalText = `Selected ![output](${selected})`;
    const onAgentEvent = vi.fn();
    const operationalRunInstance = createOperationalRunInstanceRef(runParams.runId);
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance,
      facts: {
        runId: runParams.runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "pending-media-fixture", state: "present" },
      },
    });
    attempt.mockImplementationOnce(async (params) => {
      requestRefresh(params);
      const mediaAttempt = emptyAttempt({
        toolMetas: succeeded("produce_media"),
        toolMediaUrls: mediaUrls,
        hostOwnedToolMediaUrls: kind === "host-owned" ? [selected, alternate] : undefined,
        toolAudioAsVoice: audio,
        toolTrustedLocalMedia: true,
      });
      return audio
        ? markCoreTtsAttemptResult(
            mediaAttempt,
            mediaUrls,
            kind === "foreign-tts"
              ? createOperationalRunInstanceRef(params.runId)
              : operationalRunInstance,
          )
        : mediaAttempt;
    });
    finalAttempt(finalText);
    buildPayloads.mockImplementation(textPayloads);
    const result = await runAgent({
      ...runParams,
      provider: "openai",
      model: "fixture-model",
      sessionKey: undefined,
      onAgentEvent,
      preparedRunAdmission: admission,
      ...(kind === "generated" ? {} : { sourceReplyDeliveryMode: "message_tool_only" as const }),
    }).finally(() => admission.close());
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(result.didSendViaMessagingTool).not.toBe(true);
    expect(result.messagingToolSentMediaUrls ?? []).toEqual([]);
    expect(result.meta.agentMeta?.terminalReceipt?.sourceReplyDelivered).not.toBe(true);
    expectOneLifecycleEvent(onAgentEvent, "end");
    const mediaPayloads = (result.payloads ?? []).filter((payload) => payload.mediaUrls?.length);
    const deliverable =
      kind === "generated"
        ? mediaPayloads
        : mediaPayloads.filter(
            (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression,
          );
    if (kind === "foreign-tts") {
      expect(deliverable).toEqual([]);
    } else {
      expect(deliverable.flatMap((payload) => payload.mediaUrls ?? [])).toEqual([selected]);
      expect({
        trusted: deliverable[0]?.trustedLocalMedia,
        voice: deliverable[0]?.audioAsVoice,
      }).toEqual({ trusted: true, voice: audio || undefined });
    }
  },
);
it("does not readmit completed work after a provider-shaped handoff failure", async () => {
  const onAgentEvent = vi.fn();
  const completedEffect = vi.fn();
  attempt.mockImplementation(async (params) => {
    requestRefresh(params);
    completedEffect();
    return emptyAttempt({
      sessionIdUsed: params.sessionId,
      toolMetas: [{ toolName: "plugins", replaySafe: false }],
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      terminal: {
        kind: "failed",
        source: "prompt",
        error: new AggregateError(
          [Object.assign(new Error("service unavailable"), { status: 503 })],
          "Plugin runtime changed, but runtime continuation failed. Do not repeat completed actions.",
        ),
      },
    });
  });
  const result = await run({ prompt: "reload and verify", onAgentEvent });
  expectCalls(1, completedEffect, attempt, acquire);
  expect(result.meta.error).toBeDefined();
  expectOneLifecycleEvent(onAgentEvent, "error");
});
it.each([false, true])("requires producer-owned finalization context (%s)", async (hasContext) => {
  const messages = settledWrite();
  const handoffError = new Error(
    hasContext
      ? "Attempt ended without an answer."
      : "Plugin runtime changed, but runtime continuation failed. Do not repeat completed actions.",
  );
  const finalizedContext = { source: "openclaw-transcript" as const, messages };
  const finalizer = vi.fn<NonNullable<AgentHarness["finalizeSettledTurn"]>>(
    async ({ settledAttempt }) => {
      expect(settledAttempt.settledTurnFinalizationContext).toEqual(finalizedContext);
      return { assistant: assistant("Recovered summary") };
    },
  );
  const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (params) => {
    if (!hasContext) {
      requestRefresh(params);
    }
    return emptyAttempt({
      terminal: { kind: "failed", source: "prompt", error: handoffError },
      messagesSnapshot: messages,
      toolMetas: [{ toolName: "write", toolCallId: "committed-write", replaySafe: false }],
      itemLifecycle: completedItem,
      settledTurnFinalizationContext: hasContext ? finalizedContext : undefined,
    });
  });
  registerHarness({
    id: "handoff-fixture",
    label: "Handoff fixture",
    supports: () => ({ supported: true }),
    runAttempt,
    finalizeSettledTurn: finalizer,
  });
  buildPayloads.mockImplementation(textPayloads);
  const result = await run({
    agentHarnessId: "handoff-fixture",
    config: completionConfig("fixture-provider", {
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-responses",
      apiKey: "synthetic-test-key",
      models: [
        completionModelDefinition({
          name: "Fixture model",
          contextWindow: 128000,
          maxTokens: 4096,
        }),
      ],
    }),
  });
  expect(runAttempt).toHaveBeenCalledOnce();
  if (hasContext) {
    expect(finalizer).toHaveBeenCalledOnce();
    expect(result.meta.error).toBeUndefined();
    expect(result.payloads).toEqual([{ text: "Recovered summary" }]);
  } else {
    expect(finalizer).not.toHaveBeenCalled();
    expect(result.meta.error?.message).toContain(handoffError.message);
    expect(result.payloads).toBeUndefined();
  }
});

it.each([
  { name: "another target", otherRoute: true, toolOnly: false, mirror: false },
  { name: "source mirrors", otherRoute: false, toolOnly: false, mirror: true },
  {
    name: "tool-only source with owned media",
    otherRoute: false,
    toolOnly: true,
    mirror: false,
  },
])("retains committed delivery before successor callbacks for $name", async (scenario) => {
  const {
    getReplyPayloadMetadata,
    markReplyPayloadForSourceSuppressionDelivery,
    setReplyPayloadMetadata,
  } = await import("../../auto-reply/reply-payload.js");
  const text =
    "The original plugin generation already delivered the requested detailed status report to this conversation.";
  const prefix = text.slice(0, 60);
  const divergent = `${prefix}but the subsequent verification found a different result.`;
  const unrelated = "The remaining independent check is now complete.";
  const mediaUrl = "https://example.test/already-delivered.png";
  const duplicate = { text, mediaUrls: [mediaUrl] };
  const remaining = { text: unrelated, mediaUrls: [mediaUrl] };
  const mirror = setReplyPayloadMetadata(
    markReplyPayloadForSourceSuppressionDelivery({ ...duplicate }),
    {
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:streaming-delivery",
        idempotencyKey: "retained-source-mirror",
        text,
        mediaUrls: [mediaUrl],
      },
    },
  );
  const ownedMedia = markReplyPayloadForSourceSuppressionDelivery({
    mediaUrls: ["https://example.test/new-owned-voice.opus"],
    audioAsVoice: true,
    trustedLocalMedia: true,
  });
  const partials: string[] = [];
  const blocks: BlockReplyPayload[] = [];
  const reasoning: string[] = [];
  queueRefresh({
    ...delivered(duplicate, scenario.otherRoute ? "telegram:999" : "telegram:123"),
    sourceReplyDelivered: scenario.toolOnly ? true : undefined,
    didDeliverSourceReplyViaMessageTool: scenario.toolOnly,
    messagingToolSourceReplyPayloads: scenario.toolOnly
      ? [{ text, mediaUrls: [mediaUrl], sourceReplyFinal: true, idempotencyKey: "source-send" }]
      : [],
  });
  attempt.mockImplementationOnce(async (params) => {
    await params.onPartialReply?.({ text: prefix });
    const prefixDeliveries = partials.length;
    await params.onPartialReply?.({ text: divergent });
    await params.onPartialReply?.({ text });
    await params.onPartialReply?.({ text: unrelated });
    await params.onBlockReply?.(scenario.mirror ? mirror : duplicate);
    await params.onBlockReply?.(remaining);
    if (scenario.toolOnly) {
      await params.onBlockReply?.(ownedMedia);
    }
    await params.onReasoningStream?.({
      text: "Checking the independent result.",
      isReasoning: true,
    });
    expect({ prefixDeliveries, partials, blocks, reasoning }).toEqual({
      prefixDeliveries: scenario.otherRoute ? 1 : 0,
      partials: scenario.toolOnly
        ? []
        : scenario.otherRoute
          ? [prefix, divergent, text, unrelated]
          : [divergent, unrelated],
      blocks: scenario.toolOnly
        ? [ownedMedia]
        : scenario.otherRoute
          ? [duplicate, remaining]
          : [...(scenario.mirror ? [mirror] : []), { text: unrelated }],
      reasoning: scenario.toolOnly ? [] : ["Checking the independent result."],
    });
    if (scenario.mirror) {
      expect(
        blocks.map(
          (payload) =>
            getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror?.idempotencyKey,
        ),
      ).toContain("retained-source-mirror");
    }
    return makeAttemptResult({ assistantTexts: ["Final verification complete."] });
  });
  buildPayloads.mockReturnValue([{ text: "Final verification complete." }]);
  const result = await run({
    prompt: "send the result, reload, then continue verification",
    messageChannel: "telegram",
    messageProvider: "telegram",
    messageTo: "telegram:123",
    currentChannelId: "telegram:123",
    currentMessagingTarget: "telegram:123",
    sourceReplyDeliveryMode: scenario.toolOnly ? "message_tool_only" : "automatic",
    onPartialReply: ({ text: partialText }) => {
      partials.push(partialText ?? "");
      return true;
    },
    onBlockReply: (payload) => {
      blocks.push(payload);
    },
    onReasoningStream: ({ text: reasoningText }) => {
      reasoning.push(reasoningText ?? "");
    },
  });
  expect(result.meta.error).toBeUndefined();
  expect(attempt).toHaveBeenCalledTimes(2);
});
