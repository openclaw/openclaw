import { expectDefined } from "@openclaw/normalization-core";
import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolCall,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, onTestFinished, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as agentEvents from "../infra/agent-events.js";
import { runAgentLoop, type AgentEvent } from "../plugin-sdk/agent-core.js";
import { createEmbeddedRunContextRecoveryState } from "./embedded-agent-runner/run/context-recovery-state.js";
import { createEmbeddedRunFailoverRetryController } from "./embedded-agent-runner/run/failover-retry-controller.js";
import { createSubscribedSessionHarness as subscribe } from "./embedded-agent-subscribe.e2e-harness.js";
import { SessionManager } from "./sessions/session-manager.js";
import { recordSessionModelUsage } from "./sessions/session-model-usage.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { makeZeroUsageSnapshot } from "./usage.js";

function createSubscribedSessionHarness(params: Parameters<typeof subscribe>[0]) {
  const harness = subscribe(params);
  onTestFinished(() => harness.subscription.unsubscribe());
  return harness;
}

const retryingCompactionEnd = () =>
  ({
    type: "compaction_end",
    reason: "overflow",
    outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: true },
  }) as const;

type StreamUsage = AssistantMessage["usage"] & { reasoningTokens?: number };
type UsageCall = Pick<AssistantMessage, "responseId" | "turnId"> & {
  usage: StreamUsage;
  streamedUsage?: StreamUsage;
  text?: string;
  asyncTool?: boolean;
  stopReason?: "stop" | "error" | "aborted";
};

function makeUsage(
  values: Partial<Omit<StreamUsage, "cost">> & { cost?: number; billed?: boolean } = {},
): StreamUsage {
  const { cost = 0, billed, ...tokens } = values;
  const usage = { ...makeZeroUsageSnapshot(), ...tokens };
  usage.totalTokens =
    tokens.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  usage.cost = {
    ...usage.cost,
    total: cost,
    ...(billed ? { totalOrigin: "provider-billed" } : {}),
  };
  return usage;
}

async function runUsageCalls(
  { emit, subscription }: ReturnType<typeof createSubscribedSessionHarness>,
  calls: UsageCall[],
  onEvent?: (event: AgentEvent) => void,
): Promise<AssistantMessage[]> {
  const model: Model = {
    id: "usage-model",
    name: "Usage Model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
  const completed: AssistantMessage[] = [];
  let callIndex = 0;
  await runAgentLoop(
    [{ role: "user", content: "First request.", timestamp: 0 }],
    {
      systemPrompt: "",
      messages: [],
      tools: [
        {
          name: "lookup",
          label: "Lookup",
          description: "Fixture lookup",
          parameters: Type.Object({}),
          execute: async () => ({ content: [], details: {}, terminate: true }),
        },
      ],
    },
    {
      model,
      convertToLlm: (messages) =>
        messages.filter(
          (message): message is Message =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult",
        ),
      getFollowUpMessages: async () =>
        callIndex < calls.length
          ? [{ role: "user", content: "Next request.", timestamp: callIndex }]
          : [],
    },
    async (event) => {
      emit(event);
      // AgentSession persists assistant messages after its listeners return.
      if (event.type === "message_end" && event.message.role === "assistant") {
        completed.push(structuredClone(event.message));
      }
      onEvent?.(event);
      if (event.type === "agent_end") {
        await subscription.waitForPendingEvents();
      }
    },
    undefined,
    () => {
      const call = expectDefined(calls[callIndex++], "Expected a configured model call");
      const text = call.text ?? "Reply.";
      const asyncCall: ToolCall = {
        type: "toolCall",
        id: "lookup-1",
        name: "lookup",
        arguments: {},
        async: true,
      };
      const message: AssistantMessage = {
        role: "assistant",
        content: [...(call.asyncTool ? [asyncCall] : []), { type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        responseId: call.responseId,
        turnId: call.turnId,
        usage: call.usage,
        stopReason: call.stopReason ?? "stop",
        ...(call.stopReason && call.stopReason !== "stop"
          ? { errorMessage: "Provider stopped." }
          : {}),
        timestamp: callIndex,
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [], usage: makeUsage() } });
      if (call.asyncTool) {
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: asyncCall,
          partial: { ...message, content: [asyncCall] },
        });
      }
      if (call.streamedUsage) {
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: text,
          partial: { ...message, usage: call.streamedUsage },
        });
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        stream.push({ type: "done", reason: "stop", message });
      }
      stream.end();
      return stream;
    },
  );
  expect(callIndex).toBe(calls.length);
  return completed;
}

describe("subscribeEmbeddedAgentSession model state", () => {
  it("does not count a provider refusal as recovered model progress", () => {
    const recovery = createEmbeddedRunContextRecoveryState();
    recovery.overflowCompactionAttempts = 2;
    recovery.toolResultTruncationAttempted = true;
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-progress",
      onContextAccountingEvent: (event) => recovery.observeContextAccounting(event),
    });
    const message = makeAssistantMessageFixture({
      content: [{ type: "text", text: "Response" }],
      errorMessage: undefined,
      stopReason: "stop",
      diagnostics: [{ type: "provider_refusal", timestamp: 1 }],
    });
    emit({ type: "message_start", message });
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Response" },
    });
    expect(subscription.hasSuccessfulModelResponse()).toBe(false);

    emit({ type: "message_end", message });
    expect(subscription.hasSuccessfulModelResponse()).toBe(false);
    expect(recovery.overflowCompactionAttempts).toBe(2);
    expect(recovery.toolResultTruncationAttempted).toBe(true);
    emit({ type: "turn_end", message, toolResults: [] });
    expect(subscription.hasSuccessfulModelResponse()).toBe(false);
    expect(recovery.overflowCompactionAttempts).toBe(2);
    expect(recovery.toolResultTruncationAttempted).toBe(true);
  });

  it.each(["error", "stop"] as const)(
    "uses response completion after an async fragment ending with %s",
    async (stopReason) => {
      let nowMs = Date.now();
      const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const recovery = createEmbeddedRunContextRecoveryState();
      recovery.overflowCompactionAttempts = 2;
      const harness = createSubscribedSessionHarness({
        runId: "async-progress",
        onContextAccountingEvent: (event) => recovery.observeContextAccounting(event),
      });
      const controller = createEmbeddedRunFailoverRetryController({
        runInput: {
          runParams: {
            sessionId: "async-progress",
            sessionFile: "unused",
            runId: "async-progress",
            workspaceDir: "/tmp/async-progress",
            prompt: "Continue",
            timeoutMs: 300_000,
          },
          globalLane: "test",
          agentDir: "/tmp/async-progress",
          fallbackConfigured: false,
        },
        preparedRuntime: {
          provider: "test-provider",
          modelId: "usage-model",
          profileFailureStore: { version: 1, profiles: {} },
          snapshot: () => ({
            lastProfileId: undefined,
            pluginHarnessOwnsTransport: false,
            agentHarness: { id: "embedded" },
          }),
          getApiKeyInfo: () => null,
          advanceAttemptAuthProfile: async () => false,
        },
        getSessionId: () => "async-progress",
      });
      const messages: string[] = [];
      try {
        await expect(controller.maybeRetryTransient({ reason: "timeout" })).resolves.toBe(true);
        nowMs += 130_000;
        await runUsageCalls(
          harness,
          [{ asyncTool: true, stopReason, usage: makeUsage() }],
          (event) => {
            if (event.type === "message_end" && event.message.role === "assistant") {
              messages.push(event.message.stopReason);
              expect(harness.subscription.hasSuccessfulModelResponse()).toBe(false);
              expect(recovery.overflowCompactionAttempts).toBe(2);
            }
          },
        );
        expect(messages).toEqual(["toolUse", stopReason]);
        expect(recovery.overflowCompactionAttempts).toBe(stopReason === "stop" ? 0 : 2);
        controller.observeAttempt({
          hasSuccessfulModelResponse: harness.subscription.hasSuccessfulModelResponse(),
        });
        await expect(controller.maybeRetryTransient({ reason: "timeout" })).resolves.toBe(
          stopReason === "stop",
        );
        expect(controller.transientRetryCount).toBe(stopReason === "stop" ? 2 : 1);
      } finally {
        now.mockRestore();
        harness.subscription.unsubscribe();
      }
    },
  );

  it("accounts queued message_end delivery across a retry", async () => {
    const blockReplyBreak = "message_end";
    const deliveryStarted = createDeferred();
    const releaseDelivery = createDeferred();
    const secondCompleted = createDeferred();
    const admittedUsage: StreamUsage[] = [];
    const onAgentEvent = vi.fn();
    const onModelUsage = vi.fn();
    const onBlockReplyFlush = vi.fn();
    const onBlockReply = vi.fn().mockImplementationOnce(() => {
      deliveryStarted.resolve();
      return releaseDelivery.promise;
    });
    const harness = createSubscribedSessionHarness({
      runId: "queued-usage-" + blockReplyBreak,
      lifecycleGeneration: agentEvents.getAgentEventLifecycleGeneration(),
      sessionPersistence: "detached",
      blockReplyBreak,
      onBlockReply,
      onBlockReplyFlush,
      onAgentEvent,
      onModelUsage,
    });
    const { emit, subscription } = harness;
    const running = runUsageCalls(
      harness,
      [
        {
          text: "First reply.",
          responseId: "first-provider-response",
          streamedUsage: makeUsage({ input: 100, output: 12, cost: 0.125, billed: true }),
          usage: makeUsage(),
        },
        {
          text: "Second reply.",
          turnId: "second-runtime-turn",
          streamedUsage: makeUsage({ input: 200, output: 8, cost: 0.5, billed: true }),
          usage: makeUsage(),
        },
      ],
      (event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") {
          return;
        }
        admittedUsage.push(structuredClone(event.message.usage));
        if (admittedUsage.length === 1) {
          emit(retryingCompactionEnd());
        }
        if (admittedUsage.length === 2) {
          secondCompleted.resolve();
        }
      },
    );
    try {
      await Promise.race([deliveryStarted.promise, running]);
      await Promise.race([secondCompleted.promise, running]);
      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(onBlockReplyFlush).not.toHaveBeenCalled();
      expect(admittedUsage).toMatchObject([
        { input: 100, output: 12, totalTokens: 112, cost: { total: 0.125 } },
        { input: 200, output: 8, totalTokens: 208, cost: { total: 0.5 } },
      ]);
      expect(onModelUsage.mock.calls).toMatchObject([
        [
          { input: 100, output: 12, cacheRead: 0, cacheWrite: 0 },
          { responseId: "first-provider-response" },
        ],
        [{ input: 200, output: 8, cacheRead: 0, cacheWrite: 0 }, { turnId: "second-runtime-turn" }],
      ]);
      expect(subscription.getUsageTotals()).toMatchObject({
        input: 300,
        output: 20,
        total: 320,
        cost: { total: 0.625 },
      });
      expect(subscription.getLastAssistantUsage()).toMatchObject({
        input: 200,
        output: 8,
        total: 208,
        cost: { total: 0.5, totalOrigin: "provider-billed" },
      });
      const usageEvents = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "usage");
      expect(usageEvents).toEqual([
        { stream: "usage", data: { outputTokens: 12 } },
        { stream: "usage", data: { outputTokens: 20 } },
      ]);
    } finally {
      releaseDelivery.resolve();
      await running.finally(() => subscription.unsubscribe());
    }
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReplyFlush.mock.calls.map(([event]) => event.reason)).toEqual([
      "message_end",
      "message_end",
      "terminal",
    ]);
  });

  it.each([
    {
      name: "billed zero over a later estimate",
      call: {
        streamedUsage: makeUsage({ input: 7, output: 5, cost: 0, billed: true }),
        usage: makeUsage({ input: 11, output: 3, cost: 0.5 }),
      },
      expected: {
        input: 11,
        output: 3,
        total: 14,
        cost: { total: 0, totalOrigin: "provider-billed" },
      },
      contextTokens: 11,
    },
    {
      name: "final billing-only zero with streamed tokens",
      call: {
        streamedUsage: makeUsage({ input: 7, output: 5, cost: 0.1 }),
        usage: makeUsage({ cost: 0, billed: true }),
      },
      expected: {
        input: 7,
        output: 5,
        total: 12,
        cost: { total: 0, totalOrigin: "provider-billed" },
      },
      contextTokens: 7,
    },
    {
      name: "streamed usage before a zero error result",
      call: {
        streamedUsage: makeUsage({
          input: 7,
          output: 5,
          cacheWrite: 4,
          cacheWrite1h: 3,
          reasoningTokens: 2,
          cost: 0.125,
          billed: true,
        }),
        usage: makeUsage(),
        stopReason: "error" as const,
      },
      expected: {
        input: 7,
        output: 5,
        cacheWrite: 4,
        cacheWrite1h: 3,
        reasoningTokens: 2,
        total: 16,
        cost: { total: 0.125, totalOrigin: "provider-billed" },
      },
      contextTokens: 11,
    },
    {
      name: "explicitly unknown context",
      call: { usage: makeUsage({ contextUsage: { state: "unavailable" } }) },
      expected: {
        input: 0,
        output: 0,
        total: 0,
        contextUsage: { state: "unavailable" },
        cost: { total: 0 },
      },
      contextTokens: undefined,
    },
  ])(
    "settles $name through the core event producer",
    async ({ name, call, expected, contextTokens }) => {
      const onAgentEvent = vi.fn();
      const onContextAccountingEvent = vi.fn();
      const harness = createSubscribedSessionHarness({
        runId: "usage-" + name,
        lifecycleGeneration: agentEvents.getAgentEventLifecycleGeneration(),
        onAgentEvent,
        onContextAccountingEvent,
      });
      const { subscription } = harness;
      let terminal: AssistantMessage | undefined;
      const [completed] = await runUsageCalls(harness, [call], (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          terminal = event.message;
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
          expect(subscription.getUsageTotals()).toBeUndefined();
          expect(onAgentEvent.mock.calls.some(([emitted]) => emitted.stream === "usage")).toBe(
            false,
          );
        }
      });
      const { total, cost, ...tokens } = expected;
      expect(completed?.usage).toMatchObject({ ...tokens, totalTokens: total, cost });
      if (contextTokens !== undefined) {
        expect(subscription.getUsageTotals()).toMatchObject({
          ...tokens,
          total,
          cost: { total: cost.total },
        });
      }
      expect(subscription.getLastAssistantUsage()).toMatchObject(expected);
      expect(subscription.getCurrentAttemptAssistant()).toEqual(completed);
      expect(subscription.hasSuccessfulModelResponse()).toBe(completed?.stopReason === "stop");
      expect(onContextAccountingEvent.mock.calls).toEqual([
        [{ kind: "model", contextTokens, successful: false }],
        ...(completed?.stopReason === "stop"
          ? [[{ kind: "model", contextTokens, successful: true }]]
          : []),
      ]);
      expect(
        onAgentEvent.mock.calls.map(([event]) => event).filter((event) => event.stream === "usage"),
      ).toEqual(
        expected.output ? [{ stream: "usage", data: { outputTokens: expected.output } }] : [],
      );
      expectDefined(terminal, "Expected assistant completion").usage.input = 999;
      const snapshot = expectDefined(
        subscription.getCurrentAttemptAssistant(),
        "Expected owned snapshot",
      );
      expect(snapshot.usage.input).toBe(expected.input);
      snapshot.usage.input = 500;
      expect(subscription.getCurrentAttemptAssistant()?.usage.input).toBe(expected.input);
    },
  );

  it("retains billed cost-only usage after a prior model call", async () => {
    const costTotal = 0.125;
    const priorCost = 0.25;
    const onAgentEvent = vi.fn();
    const harness = createSubscribedSessionHarness({
      runId: "run-cost-only",
      lifecycleGeneration: agentEvents.getAgentEventLifecycleGeneration(),
      onAgentEvent,
      sessionExtras: { sessionManager: SessionManager.inMemory() },
    });
    const { session, subscription } = harness;
    const usage = makeUsage({ cost: costTotal, billed: true });
    const completed = await runUsageCalls(harness, [
      { usage: makeUsage({ input: 100, output: 20, cost: priorCost }) },
      { usage },
    ]);
    expect(subscription.getUsageTotals()?.cost).toEqual({
      total: priorCost + costTotal,
    });
    const lastCallUsage = subscription.getLastAssistantUsage();
    expect(lastCallUsage).toMatchObject({ input: 100, output: 20, total: 120 });
    expect(completed.at(-1)?.usage.cost).toMatchObject({
      total: costTotal,
      totalOrigin: "provider-billed",
    });
    recordSessionModelUsage(session.sessionManager, usage);
    recordSessionModelUsage(session.sessionManager, makeUsage({ input: 5, output: 2, cost: 0.05 }));
    expect(subscription.getUsageTotals()).toMatchObject({
      input: 105,
      output: 22,
      cost: { total: priorCost + costTotal * 2 + 0.05 },
    });
    expect(subscription.getLastAssistantUsage()).toEqual(lastCallUsage);
    expect(
      onAgentEvent.mock.calls.map(([event]) => event).filter((event) => event.stream === "usage"),
    ).toEqual([
      { stream: "usage", data: { outputTokens: 20 } },
      { stream: "usage", data: { outputTokens: 22 } },
    ]);

    subscription.unsubscribe();
    recordSessionModelUsage(session.sessionManager, makeUsage({ input: 9, output: 9, cost: 9 }));
    expect(subscription.getUsageTotals()?.cost).toEqual({
      total: priorCost + costTotal * 2 + 0.05,
    });
  });

  it.each([
    {
      name: "keeps a successful retry call when later post-call processing fails",
      retryUsage: makeUsage({ input: 240, output: 30 }),
      expected: { input: 240, output: 30, total: 270 },
    },
    {
      name: "restores the previous call when a retry fails before recording usage",
      retryUsage: undefined,
      expected: { input: 100, output: 20, total: 120 },
    },
  ])("$name", async ({ retryUsage, expected }) => {
    const harness = createSubscribedSessionHarness({ runId: "run-retry-usage" });
    const { emit, subscription } = harness;
    let completed = 0;
    await runUsageCalls(
      harness,
      [
        { text: "Before retry.", usage: makeUsage({ input: 100, output: 20 }) },
        ...(retryUsage ? [{ usage: retryUsage }] : []),
        { usage: makeUsage(), stopReason: "error" },
      ],
      (event) => {
        if (
          event.type !== "message_end" ||
          event.message.role !== "assistant" ||
          completed++ !== 0
        ) {
          return;
        }
        expect(subscription.assistantTexts).toEqual(["Before retry."]);
        expect(subscription.getLastAssistantTextMessageIndex()).toEqual(expect.any(Number));
        emit(retryingCompactionEnd());
        expect(subscription.hasSuccessfulModelResponse()).toBe(false);
        expect(subscription.assistantTexts).toEqual([]);
        expect(subscription.getLastAssistantTextMessageIndex()).toBeUndefined();
        expect(subscription.getCurrentAttemptAssistant()).toBeUndefined();
      },
    );
    expect(subscription.getLastAssistantUsage()).toMatchObject(expected);
    expect(subscription.hasSuccessfulModelResponse()).toBe(true);
    expect(subscription.getUsageTotals()).toMatchObject(
      retryUsage ? { input: 340, output: 50, total: 390 } : { input: 100, output: 20, total: 120 },
    );
  });
});
