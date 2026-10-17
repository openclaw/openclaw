import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { AssistantMessage, Model } from "../../../llm/types.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import type { AgentMessage } from "../../runtime/index.js";
import { agentSessionDeferThresholdCompaction } from "../../sessions/agent-session-types.js";
import type { AgentSession } from "../../sessions/index.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";

const hoisted = vi.hoisted(() => ({
  installContextEngineLoopHook: vi.fn(),
  installToolResultContextGuard: vi.fn(),
  invalidateComputerFrameIfMissing: vi.fn(),
  isCacheTtlEligibleProvider: vi.fn(() => false),
  readLastCacheTtlTimestamp: vi.fn(() => null as number | null),
}));

vi.mock("../tool-result-context-guard.js", () => ({
  installContextEngineLoopHook: hoisted.installContextEngineLoopHook,
  installToolResultContextGuard: hoisted.installToolResultContextGuard,
}));
vi.mock("../../tools/computer-tool.js", () => ({
  invalidateComputerFrameIfMissing: hoisted.invalidateComputerFrameIfMissing,
}));
vi.mock("../cache-ttl.js", () => ({
  readCacheTtlEntries: () => [],
  isCacheTtlEligibleProvider: hoisted.isCacheTtlEligibleProvider,
  readLastCacheTtlTimestamp: hoisted.readLastCacheTtlTimestamp,
}));

import { installEmbeddedAttemptContextGuards } from "./attempt-setup.js";

const attemptDefaults = {
  config: { agents: { defaults: { compaction: { midTurnPrecheck: { enabled: true } } } } },
  contextTokenBudget: 1_024,
  model: { api: "anthropic-messages", contextWindow: 2_048 },
  modelId: "model-1",
  provider: "provider-1",
  sessionFile: "/tmp/session.jsonl",
};
const pruningConfig = { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } };
function createInput(
  overrides: Record<string, unknown> = {},
  attempt: Omit<Partial<typeof attemptDefaults>, "model"> & { model?: Partial<Model> } = {},
) {
  return {
    activeSession: { agent: { transformContext: undefined } } as unknown as AgentSession,
    agentDir: "/tmp/agent",
    attempt: { ...attemptDefaults, ...attempt },
    computerContextEpoch: { value: 3 },
    dropThinkingBlocksForEstimate: false,
    effectiveCwd: "/tmp/workspace",
    effectiveWorkspace: "/tmp/workspace",
    getPrePromptMessageCount: () => 4,
    getPromptCache: () => undefined,
    getPromptCacheRetention: () => "short" as const,
    getCompactionReplayEnabled: () => false,
    getServerToolClearingEnabled: () => false,
    toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    getSystemPrompt: () => "system prompt",
    isOpenAIResponsesApi: false,
    repairToolUseResultPairing: false,
    sessionAgentId: "main",
    sessionManager: {},
    settingsManager: {
      getBlockImages: vi.fn(() => false),
      getCompactionReserveTokens: vi.fn(() => 64),
    } as unknown as AgentSession["settingsManager"],
    ...overrides,
  };
}
const project = (input: ReturnType<typeof createInput>, messages: AgentMessage[]) =>
  input.activeSession.agent.transformContext!(messages, new AbortController().signal);
const precheckRequest = {
  context: { messages: [{ role: "user" as const, content: "x".repeat(8_000), timestamp: 1 }] },
};
function install(input: ReturnType<typeof createInput>, cleanup = true) {
  const guards = installEmbeddedAttemptContextGuards(input as never);
  if (cleanup) {
    onTestFinished(guards.remove);
  }
  return guards;
}

const cacheModel = makeProviderModelFixture({
  id: "claude-sonnet-4-6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "http://127.0.0.1:1",
  contextWindow: 2_048,
  maxTokens: 1_024,
});

const assistant = (text: string, extra: Partial<AssistantMessage> = {}) =>
  makeAssistantMessageFixture({
    content: [{ type: "text", text }],
    api: cacheModel.api,
    provider: cacheModel.provider,
    model: cacheModel.id,
    errorMessage: undefined,
    stopReason: "stop",
    timestamp: 1,
    ...extra,
  });

const toolResult = (toolCallId: string, text: string, timestamp = 1): AgentMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp,
});

const prunableHistory = (): AgentMessage[] => [
  { role: "user", content: "first", timestamp: 1 },
  assistant("a1"),
  toolResult("old-tool", "x".repeat(5_000)),
  ...["a2", "a3", "a4"].map((text) => assistant(text)),
];

afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.clearAllMocks();
  hoisted.installContextEngineLoopHook.mockReturnValue(vi.fn());
  hoisted.installToolResultContextGuard.mockReturnValue(vi.fn());
  hoisted.isCacheTtlEligibleProvider.mockReturnValue(false);
  hoisted.readLastCacheTtlTimestamp.mockReturnValue(null);
});

it("tracks mid-turn requests and restores attempt-local transforms", async () => {
  const input = createInput();
  const originalTransform = input.activeSession.agent.transformContext;
  const guards = install(input, false);
  expect(() => guards.checkMidTurnPrecheck(precheckRequest)).toThrow(MidTurnPrecheckSignal);
  expect(guards.takePendingMidTurnPrecheckRequest()).toMatchObject({
    route: "compact_only",
    promptBudgetBeforeReserve: 960,
  });
  expect(guards.takePendingMidTurnPrecheckRequest()).toBeNull();

  const messages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: 1 }];
  await project(input, messages);
  expect(hoisted.invalidateComputerFrameIfMissing).toHaveBeenCalledWith({
    contextEpoch: input.computerContextEpoch,
    imagesBlocked: false,
    messages,
  });

  guards.remove();
  expect(input.activeSession.agent.transformContext).toBe(originalTransform);
  expect(hoisted.installToolResultContextGuard.mock.results[0]?.value).toHaveBeenCalledOnce();
});

it("defers local pressure recovery while the provider request boundary owns compaction", () => {
  const input = createInput();
  input.activeSession[agentSessionDeferThresholdCompaction] = true;
  const guards = install(input);
  expect(() => guards.checkMidTurnPrecheck(precheckRequest)).not.toThrow();
  expect(guards.takePendingMidTurnPrecheckRequest()).toBeNull();
  input.activeSession[agentSessionDeferThresholdCompaction] = false;
  expect(() => guards.checkMidTurnPrecheck(precheckRequest)).toThrow(MidTurnPrecheckSignal);
});

it("hydrates current images and their failure notice before context transforms", async () => {
  const message: AgentMessage & { __openclaw: unknown } = {
    role: "user",
    content: [
      { type: "text", text: "inspect" },
      { type: "image", data: "%%%", mimeType: "image/png" },
    ],
    timestamp: 1,
    __openclaw: {
      media: [{ kind: "image" }],
      mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
    },
  };
  const original = JSON.stringify(message);
  const onCurrentTurnImageFailure = vi.fn();
  const input = createInput(
    { onCurrentTurnImageFailure },
    { model: { ...cacheModel, input: ["text", "image"] } },
  );
  input.activeSession.agent.transformContext = async (messages) =>
    messages.map((entry) =>
      entry.role === "user" && Array.isArray(entry.content)
        ? {
            ...entry,
            content: entry.content.map((block) =>
              block.type === "text" ? { ...block, text: `transformed: ${block.text}` } : block,
            ),
          }
        : entry,
    );
  install(input);
  const replay = await input.activeSession.agent.transformContext?.([message]);
  expect(onCurrentTurnImageFailure).toHaveBeenCalledWith(1);
  expect(replay?.[0]).toMatchObject({
    content: [
      { type: "text", text: "transformed: inspect" },
      {
        type: "text",
        text: expect.stringMatching(/^transformed: .*1.*image contents.*unavailable/s),
      },
    ],
  });
  expect(JSON.stringify(message)).toBe(original);
});

it("composes context-engine and tool-result cleanup while exposing checkpoints", () => {
  const activeContextEngine = { info: { id: "test-engine", ownsCompaction: true } };
  const guards = install(
    createInput({ activeContextEngine, repairToolUseResultPairing: true }),
    false,
  );
  const loopOptions = hoisted.installContextEngineLoopHook.mock.calls[0]?.[0];
  loopOptions.onAfterTurnCheckpoint(17);

  expect(guards.getAfterTurnCheckpoint()).toBe(17);
  expect(loopOptions).toMatchObject({
    contextEngine: activeContextEngine,
    modelId: "model-1",
    repairAssembledMessages: expect.any(Function),
  });

  guards.remove();
  for (const hook of [
    hoisted.installToolResultContextGuard,
    hoisted.installContextEngineLoopHook,
  ]) {
    expect(hook.mock.results[0]?.value).toHaveBeenCalledOnce();
  }
});

it("does not inspect providers when attempt configuration is absent", () => {
  hoisted.isCacheTtlEligibleProvider.mockReturnValue(true);
  install(createInput({}, { config: undefined as never }));
  expect(hoisted.isCacheTtlEligibleProvider).not.toHaveBeenCalled();
  expect(hoisted.readLastCacheTtlTimestamp).not.toHaveBeenCalled();
});

it("passes the absent resolved route opt-in to pruning eligibility", () => {
  const model = {
    ...cacheModel,
    provider: "openai",
    id: "gpt-4o",
    api: "openai-responses" as const,
    baseUrl: "https://proxy.example/v1",
    compat: { supportsPromptCacheKey: undefined },
    headers: { "x-test-private": "not-for-provider-hooks" },
  };
  const input = createInput(
    {},
    { provider: "openai", modelId: model.id, model, config: pruningConfig as never },
  );
  install(input);
  expect(hoisted.isCacheTtlEligibleProvider).toHaveBeenCalledExactlyOnceWith(
    "openai",
    "gpt-4o",
    "openai-responses",
    { baseUrl: model.baseUrl, supportsPromptCacheKey: undefined },
  );
});

it.each(["success", "throw", "error", "aborted"] as const)(
  "uses successful request start for pruning after %s",
  async (outcome) => {
    const thresholdCrossing = outcome === "success";
    vi.useFakeTimers({ toFake: ["Date"] });
    const requestStart = 1_000_000;
    vi.setSystemTime(requestStart);
    hoisted.isCacheTtlEligibleProvider.mockReturnValue(true);
    hoisted.readLastCacheTtlTimestamp.mockReturnValue(
      requestStart - (thresholdCrossing ? 310_000 : 290_000),
    );
    const input = createInput(
      {},
      {
        contextTokenBudget: thresholdCrossing ? 10_000 : 1_024,
        config: pruningConfig as never,
      },
    );
    const guards = install(input);
    const history = prunableHistory();
    expect(JSON.stringify(await project(input, history))).toBe(JSON.stringify(history));
    const response = assistant("continue", {
      stopReason: outcome === "error" || outcome === "aborted" ? outcome : "toolUse",
      timestamp: requestStart,
    });
    const onSucceeded = vi.fn(guards.recordCacheTouch);
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      () => {
        if (outcome === "throw") {
          throw new Error("failed before dispatch");
        }
        const stream = createAssistantMessageEventStream();
        // A completion-time TTL would incorrectly stay warm at the final check.
        vi.setSystemTime(Date.now() + 10_000);
        if (outcome === "error" || outcome === "aborted") {
          stream.push({ type: "error", reason: outcome, error: response });
        } else {
          stream.push({ type: "done", reason: "toolUse", message: response });
        }
        return stream;
      },
      {
        runId: "cache-ttl-clock",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "cache-ttl-request",
        onSucceeded,
      },
    );
    if (outcome === "throw") {
      expect(() => wrapped(cacheModel, { messages: [] })).toThrow("failed before dispatch");
    } else {
      await (await wrapped(cacheModel, { messages: [] })).result();
    }
    vi.setSystemTime(requestStart + 20_000);
    const expanded = thresholdCrossing
      ? [...history, toolResult("new-tool", "y".repeat(10_000), Date.now())]
      : history;
    const second = await project(input, expanded);
    if (outcome === "success") {
      expect(JSON.stringify(second)).toBe(JSON.stringify(expanded));
      expect(onSucceeded).toHaveBeenCalledExactlyOnceWith(requestStart);
      // A second successful request starts its own TTL window.
      await (await wrapped(cacheModel, { messages: [] })).result();
      expect(onSucceeded.mock.calls).toEqual([[requestStart], [requestStart + 20_000]]);
      vi.setSystemTime(requestStart + 320_000);
      const expired = await project(input, expanded);
      expect(JSON.stringify(expired)).toContain("[Tool result trimmed:");
      expect(JSON.stringify(expired)).not.toBe(JSON.stringify(expanded));
    } else {
      expect(onSucceeded).not.toHaveBeenCalled();
      expect(JSON.stringify(second)).toContain("[Tool result trimmed:");
    }
    expect(JSON.stringify(history)).toContain("x".repeat(5_000));
  },
);

it.each([false, true])(
  "keeps cache-TTL tool-loop bytes stable with server clearing=%s",
  async (serverClearing) => {
    const now = Date.now();
    hoisted.isCacheTtlEligibleProvider.mockReturnValue(true);
    hoisted.readLastCacheTtlTimestamp.mockReturnValue(now - 300_000);
    const input = createInput(
      {
        activeContextEngine: { info: { id: "test-engine", ownsCompaction: true } },
        getServerToolClearingEnabled: () => serverClearing,
      },
      { config: pruningConfig as never, modelId: "claude-sonnet-4-6", provider: "anthropic" },
    );
    const earlierProjection = "[trimmed by an earlier client-side prune]";
    if (serverClearing) {
      // Server clearing must replay client projections made before route takeover.
      const key = "tool:old-tool:1";
      input.toolResultPromptProjectionState.replacements.set(key, {
        content: [{ type: "text", text: earlierProjection }],
        cacheTtl: "soft",
      });
      input.toolResultPromptProjectionState.sourceHashByKey.set(
        key,
        createHash("sha256")
          .update(JSON.stringify(["x".repeat(5_000)]))
          .digest("base64url"),
      );
      input.toolResultPromptProjectionState.frozen.add(key);
    }
    const originalTransform = vi.fn(async (messages: AgentMessage[]) => messages);
    input.activeSession.agent.transformContext = originalTransform;
    const capture = vi.fn((messages: AgentMessage[]) => messages);
    hoisted.installContextEngineLoopHook.mockImplementation(({ agent }) => {
      const previous = agent.transformContext;
      agent.transformContext = async (messages: AgentMessage[], signal: AbortSignal) =>
        capture(await previous(messages, signal));
      return vi.fn(() => {
        agent.transformContext = previous;
      });
    });
    const capturedTool = () =>
      capture.mock.lastCall?.[0].find((message) => message.role === "toolResult");
    const messages = prunableHistory();

    const guards = install(input, false);
    expect(hoisted.isCacheTtlEligibleProvider).toHaveBeenCalledExactlyOnceWith(
      "anthropic",
      "claude-sonnet-4-6",
      "anthropic-messages",
      { baseUrl: undefined, supportsPromptCacheKey: undefined },
    );
    expect(hoisted.readLastCacheTtlTimestamp).toHaveBeenCalledExactlyOnceWith(
      input.sessionManager,
      {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
    );
    await project(input, messages);
    const firstTool = capturedTool();
    expect(firstTool?.content[0]).toMatchObject({
      type: "text",
      text: serverClearing ? earlierProjection : expect.stringContaining("[Tool result trimmed:"),
    });

    await project(input, messages);
    expect(capturedTool()?.content).toEqual(firstTool?.content);

    guards.remove();
    expect(input.activeSession.agent.transformContext).toBe(originalTransform);
  },
);
