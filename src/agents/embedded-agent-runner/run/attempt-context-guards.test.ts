import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import type { AgentMessage } from "../../runtime/index.js";
import { agentSessionDeferThresholdCompaction } from "../../sessions/agent-session-types.js";
import type { AgentSession } from "../../sessions/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
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

function createInput(overrides: Record<string, unknown> = {}) {
  const activeSession = {
    agent: { transformContext: undefined },
  } as unknown as AgentSession;
  const settingsManager = {
    getBlockImages: vi.fn(() => false),
    getCompactionReserveTokens: vi.fn(() => 64),
  } as unknown as AgentSession["settingsManager"];
  return {
    activeSession,
    attempt: {
      config: {
        agents: { defaults: { compaction: { midTurnPrecheck: { enabled: true } } } },
      },
      contextTokenBudget: 1_024,
      model: { api: "anthropic-messages", contextWindow: 2_048 },
      modelId: "model-1",
      provider: "provider-1",
      sessionFile: "/tmp/session.jsonl",
    },
    computerContextEpoch: { value: 3 },
    dropThinkingBlocksForEstimate: false,
    effectiveWorkspace: "/tmp/workspace",
    getCompactionReplayEnabled: () => false,
    getServerToolClearingEnabled: () => false,
    toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    repairToolUseResultPairing: false,
    sessionAgentId: "main",
    sessionManager: {},
    settingsManager,
    ...overrides,
  };
}

const cacheModel = makeProviderModelFixture({
  id: "claude-sonnet-4-6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "http://127.0.0.1:1",
  contextWindow: 2_048,
  maxTokens: 1_024,
});

function assistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  timestamp = 1,
): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    api: cacheModel.api,
    provider: cacheModel.provider,
    model: cacheModel.id,
    stopReason,
    timestamp,
  });
}

function prunableHistory(): AgentMessage[] {
  return [
    { role: "user", content: "first", timestamp: 1 },
    assistant("a1"),
    makeTextToolResult("old-tool", "read", "x".repeat(5_000), false, 1),
    assistant("a2"),
    assistant("a3"),
    assistant("a4"),
  ];
}

describe("installEmbeddedAttemptContextGuards", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.installContextEngineLoopHook.mockReturnValue(vi.fn());
    hoisted.installToolResultContextGuard.mockReturnValue(vi.fn());
    hoisted.isCacheTtlEligibleProvider.mockReturnValue(false);
    hoisted.readLastCacheTtlTimestamp.mockReturnValue(null);
  });

  it("retained cache-touch callbacks do not keep completed attempt continuations", async () => {
    const completed = Array.from({ length: 20 }, () => {
      const input = createInput();
      const continuation = { prompt: "continue", messages: prunableHistory() };
      const guards = installEmbeddedAttemptContextGuards({
        ...input,
        attempt: { ...input.attempt, continuation },
      } as never);
      guards.remove();
      return { callback: guards.recordCacheTouch, continuation: new WeakRef(continuation) };
    });
    const control = new WeakRef({});
    await nextTurn();
    queryObjects(WeakRef);
    expect(control.deref()).toBeUndefined();
    expect(completed.filter(({ continuation }) => continuation.deref())).toHaveLength(0);
    for (const { callback } of completed) {
      callback(1);
    }
  });

  it("tracks mid-turn requests and restores attempt-local transforms", async () => {
    const input = createInput();
    const originalTransform = input.activeSession.agent.transformContext;
    const guards = installEmbeddedAttemptContextGuards(input as never);
    const request = {
      context: { messages: [{ role: "user" as const, content: "x".repeat(8_000), timestamp: 1 }] },
    };
    input.activeSession[agentSessionDeferThresholdCompaction] = true;
    expect(() => guards.checkMidTurnPrecheck(request)).not.toThrow();
    expect(guards.takePendingMidTurnPrecheckRequest()).toBeNull();
    input.activeSession[agentSessionDeferThresholdCompaction] = false;
    expect(() => guards.checkMidTurnPrecheck(request)).toThrow(MidTurnPrecheckSignal);
    expect(guards.takePendingMidTurnPrecheckRequest()).toMatchObject({
      route: "compact_only",
      promptBudgetBeforeReserve: 960,
    });
    expect(guards.takePendingMidTurnPrecheckRequest()).toBeNull();

    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    ];
    await input.activeSession.agent.transformContext?.(messages, new AbortController().signal);
    expect(hoisted.invalidateComputerFrameIfMissing).toHaveBeenCalledWith({
      contextEpoch: input.computerContextEpoch,
      imagesBlocked: false,
      messages,
    });

    const removeToolResultGuard = hoisted.installToolResultContextGuard.mock.results[0]?.value;
    guards.remove();
    expect(input.activeSession.agent.transformContext).toBe(originalTransform);
    expect(removeToolResultGuard).toHaveBeenCalledOnce();
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
    const input = createInput({
      onCurrentTurnImageFailure,
      attempt: {
        ...createInput().attempt,
        model: { ...cacheModel, input: ["text", "image"] },
      },
    });
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
    const guards = installEmbeddedAttemptContextGuards(input as never);
    try {
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
    } finally {
      guards.remove();
    }
  });

  it("composes context-engine and tool-result cleanup while exposing checkpoints", () => {
    const activeContextEngine = {
      info: { id: "test-engine", ownsCompaction: true },
    };
    const guards = installEmbeddedAttemptContextGuards(
      createInput({
        activeContextEngine,
        repairToolUseResultPairing: true,
      }) as never,
    );
    const loopOptions = hoisted.installContextEngineLoopHook.mock.calls[0]?.[0];
    loopOptions.onAfterTurnCheckpoint(17);

    expect(guards.getAfterTurnCheckpoint()).toBe(17);
    expect(loopOptions.modelId).toBe("model-1");
    expect(loopOptions.contextEngine).toBe(activeContextEngine);
    expect(loopOptions.repairAssembledMessages).toEqual(expect.any(Function));

    const removeLoopHook = hoisted.installContextEngineLoopHook.mock.results[0]?.value;
    const removeToolResultGuard = hoisted.installToolResultContextGuard.mock.results[0]?.value;
    guards.remove();
    expect(removeToolResultGuard).toHaveBeenCalledOnce();
    expect(removeLoopHook).toHaveBeenCalledOnce();
  });

  it("does not inspect providers when attempt configuration is absent", () => {
    hoisted.isCacheTtlEligibleProvider.mockReturnValue(true);
    const input = createInput();
    input.attempt = { ...input.attempt, config: undefined as never };

    const guards = installEmbeddedAttemptContextGuards(input as never);

    expect(hoisted.isCacheTtlEligibleProvider).not.toHaveBeenCalled();
    expect(hoisted.readLastCacheTtlTimestamp).not.toHaveBeenCalled();
    guards.remove();
  });

  it("passes absent route opt-in to pruning eligibility", () => {
    const input = createInput();
    const model = {
      ...cacheModel,
      contextWindow: 2_048,
      provider: "openai",
      id: "gpt-4o",
      api: "openai-responses" as const,
      baseUrl: "https://proxy.example/v1",
      compat: { supportsPromptCacheKey: undefined },
      headers: { "x-test-private": "not-for-provider-hooks" },
    };
    input.attempt = {
      ...input.attempt,
      provider: "openai",
      modelId: model.id,
      model,
      config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } } as never,
    };
    const guards = installEmbeddedAttemptContextGuards(input as never);
    expect(hoisted.isCacheTtlEligibleProvider).toHaveBeenCalledExactlyOnceWith(
      "openai",
      "gpt-4o",
      "openai-responses",
      { baseUrl: model.baseUrl, supportsPromptCacheKey: undefined },
    );
    guards.remove();
  });

  it("refreshes pruning at successful request start, not stream completion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const requestStart = 1_000_000;
    vi.setSystemTime(requestStart);
    hoisted.isCacheTtlEligibleProvider.mockReturnValue(true);
    hoisted.readLastCacheTtlTimestamp.mockReturnValue(requestStart - 310_000);
    const input = createInput();
    input.attempt = {
      ...input.attempt,
      contextTokenBudget: 10_000,
      config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } } as never,
    };
    const guards = installEmbeddedAttemptContextGuards(input as never);
    onTestFinished(guards.remove);
    const history = prunableHistory();
    const project = (messages: AgentMessage[]) =>
      input.activeSession.agent.transformContext!(messages, new AbortController().signal);
    expect(await project(history)).toEqual(history);
    const onSucceeded = vi.fn(guards.recordCacheTouch);
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      () => {
        const stream = createAssistantMessageEventStream();
        vi.setSystemTime(Date.now() + 10_000);
        stream.push({ type: "done", reason: "toolUse", message: assistant("continue", "toolUse") });
        return stream;
      },
      {
        runId: "cache-ttl-clock",
        provider: cacheModel.provider,
        model: cacheModel.id,
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "cache-ttl-request",
        onSucceeded,
      },
    );
    await (await wrapped(cacheModel, { messages: [] })).result();
    expect(onSucceeded).toHaveBeenCalledExactlyOnceWith(requestStart);
    vi.setSystemTime(requestStart + 20_000);
    const expanded = [
      ...history,
      makeTextToolResult("new-tool", "read", "y".repeat(10_000), false, Date.now()),
    ];
    expect(await project(expanded)).toEqual(expanded);
    await (await wrapped(cacheModel, { messages: [] })).result();
    expect(onSucceeded).toHaveBeenCalledTimes(2);
    expect(onSucceeded).toHaveBeenLastCalledWith(requestStart + 20_000);
    vi.setSystemTime(requestStart + 320_000);
    const expired = await project(expanded);
    expect(JSON.stringify(expired)).toContain("[Tool result trimmed:");
    expect(expired).not.toEqual(expanded);
    expect(JSON.stringify(history)).toContain("x".repeat(5_000));
  });

  it.each([false, true])(
    "keeps cache-TTL tool-loop bytes stable with server clearing=%s",
    async (serverClearing) => {
      const now = Date.now();
      hoisted.isCacheTtlEligibleProvider.mockReturnValue(true);
      hoisted.readLastCacheTtlTimestamp.mockReturnValue(now - 300_000);
      const input = createInput({
        activeContextEngine: { info: { id: "test-engine", ownsCompaction: true } },
        getServerToolClearingEnabled: () => serverClearing,
      });
      const earlierProjection = "[trimmed by an earlier client-side prune]";
      if (serverClearing) {
        // A projection made before this route took over (proxy/OAuth turn, or restored
        // from the transcript marker) must keep replaying under server clearing.
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
      input.attempt = {
        ...input.attempt,
        config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } } as never,
        model: { api: "anthropic-messages", contextWindow: 2_048 },
        modelId: "claude-sonnet-4-6",
        provider: "anthropic",
      };
      const originalTransform = vi.fn(async (messages: AgentMessage[]) => messages);
      input.activeSession.agent.transformContext = originalTransform;
      let engineMessages: AgentMessage[] | undefined;
      hoisted.installContextEngineLoopHook.mockImplementation(({ agent }) => {
        const previous = agent.transformContext;
        agent.transformContext = async (messages: AgentMessage[], signal: AbortSignal) => {
          const projected = await previous(messages, signal);
          engineMessages = projected;
          return projected;
        };
        return vi.fn(() => {
          agent.transformContext = previous;
        });
      });
      const messages = prunableHistory();

      const guards = installEmbeddedAttemptContextGuards(input as never);
      await input.activeSession.agent.transformContext?.(messages, new AbortController().signal);
      const firstTool = engineMessages?.find((message) => message.role === "toolResult");
      expect(firstTool?.content[0]).toMatchObject({
        type: "text",
        text: serverClearing ? earlierProjection : expect.stringContaining("[Tool result trimmed:"),
      });

      await input.activeSession.agent.transformContext?.(messages, new AbortController().signal);
      const secondTool = engineMessages?.find((message) => message.role === "toolResult");
      expect(secondTool?.content).toEqual(firstTool?.content);

      guards.remove();
      expect(input.activeSession.agent.transformContext).toBe(originalTransform);
    },
  );
});
