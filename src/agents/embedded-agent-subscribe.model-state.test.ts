import { expectDefined } from "@openclaw/normalization-core";
import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolCall,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as agentEvents from "../infra/agent-events.js";
import { runAgentLoop, type AgentEvent } from "../plugin-sdk/agent-core.js";
import { createEmbeddedRunContextRecoveryState } from "./embedded-agent-runner/run/context-recovery-state.js";
import { createEmbeddedRunFailoverRetryController } from "./embedded-agent-runner/run/failover-retry-controller.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { SessionManager } from "./sessions/session-manager.js";
import { recordSessionModelUsage } from "./sessions/session-model-usage.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { makeZeroUsageSnapshot } from "./usage.js";

const retryingCompactionEnd = () =>
  ({
    type: "compaction_end",
    reason: "overflow",
    outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: true },
  }) as const;

type StreamUsage = AssistantMessage["usage"] & { reasoningTokens?: number };
type UsageCall = {
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
  it.each([
    { label: "completed answer", overrides: { stopReason: "stop" }, expected: true },
    { label: "completed tool call", overrides: { stopReason: "toolUse" }, expected: true },
    { label: "provider error", overrides: { stopReason: "error" }, expected: false },
    { label: "aborted response", overrides: { stopReason: "aborted" }, expected: false },
    { label: "truncated response", overrides: { stopReason: "length" }, expected: false },
    {
      label: "provider refusal",
      overrides: {
        stopReason: "stop",
        diagnostics: [{ type: "provider_refusal", timestamp: 1 }],
      },
      expected: false,
    },
    ...["delivery-mirror", "gateway-injected"].map((model) => ({
      label: model,
      overrides: { stopReason: "stop" as const, provider: "openclaw", model },
      expected: false,
    })),
  ] satisfies Array<{
    label: string;
    overrides: Partial<AssistantMessage>;
    expected: boolean;
  }>)("counts only real completed model progress: $label", ({ overrides, expected }) => {
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
      ...overrides,
    });
    try {
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
      expect(subscription.hasSuccessfulModelResponse()).toBe(expected);
      expect(recovery.overflowCompactionAttempts).toBe(expected ? 0 : 2);
      expect(recovery.toolResultTruncationAttempted).toBe(!expected);
    } finally {
      subscription.unsubscribe();
    }
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
        runParams: {
          sessionId: "async-progress",
          sessionFile: "unused",
          runId: "async-progress",
          workspaceDir: "/tmp/async-progress",
          prompt: "Continue",
          timeoutMs: 300_000,
        },
        provider: "test-provider",
        modelId: "usage-model",
        globalLane: "test",
        agentDir: "/tmp/async-progress",
        fallbackConfigured: false,
        profileFailureStore: { version: 1, profiles: {} },
        getLastProfileId: () => undefined,
        getSessionId: () => "async-progress",
        harnessOwnsTransport: () => false,
        getRuntimeAuthOwnerId: () => "embedded",
        getApiKeyInfo: () => null,
        advanceAuthProfile: async () => false,
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

  it.each([
    { blockReplyBreak: "text_end", retry: false },
    { blockReplyBreak: "text_end", retry: true },
    { blockReplyBreak: "message_end", retry: false },
    { blockReplyBreak: "message_end", retry: true },
  ] as const)(
    "accounts queued $blockReplyBreak delivery across retry=$retry",
    async ({ blockReplyBreak, retry }) => {
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
        runId: "queued-usage-" + blockReplyBreak + "-" + retry,
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
            streamedUsage: makeUsage({ input: 100, output: 12, cost: 0.125, billed: true }),
            usage: makeUsage(),
          },
          {
            text: "Second reply.",
            streamedUsage: makeUsage({ input: 200, output: 8, cost: 0.5, billed: true }),
            usage: makeUsage(),
          },
        ],
        (event) => {
          if (event.type !== "message_end" || event.message.role !== "assistant") {
            return;
          }
          admittedUsage.push(structuredClone(event.message.usage));
          if (admittedUsage.length === 1 && retry) {
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
          [{ input: 100, output: 12, cacheRead: 0, cacheWrite: 0 }],
          [{ input: 200, output: 8, cacheRead: 0, cacheWrite: 0 }],
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
      expect(onBlockReplyFlush.mock.calls.map(([event]) => event.reason)).toEqual(
        blockReplyBreak === "message_end"
          ? ["message_end", "message_end", "terminal"]
          : ["terminal"],
      );
    },
  );

  it.each([
    {
      name: "different final counts and price",
      call: {
        streamedUsage: makeUsage({ input: 7, output: 5, cost: 0.125 }),
        usage: makeUsage({ input: 11, output: 3, cost: 0.25 }),
      },
      expected: { input: 11, output: 3, total: 14, cost: { total: 0.25 } },
      contextTokens: 11,
    },
    ...[0, 0.125].map((cost) => ({
      name: "billed " + cost + " over a later estimate",
      call: {
        streamedUsage: makeUsage({ input: 7, output: 5, cost, billed: true }),
        usage: makeUsage({ input: 11, output: 3, cost: 0.5 }),
      },
      expected: {
        input: 11,
        output: 3,
        total: 14,
        cost: { total: cost, totalOrigin: "provider-billed" },
      },
      contextTokens: 11,
    })),
    ...[0, 0.125].map((cost) => ({
      name: "final billing-only " + cost + " with streamed tokens",
      call: {
        streamedUsage: makeUsage({ input: 7, output: 5, cost: 0.1 }),
        usage: makeUsage({ cost, billed: true }),
      },
      expected: {
        input: 7,
        output: 5,
        total: 12,
        cost: { total: cost, totalOrigin: "provider-billed" },
      },
      contextTokens: 7,
    })),
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
      try {
        const [completed] = await runUsageCalls(harness, [call], (event) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
            expect(subscription.getUsageTotals()).toBeUndefined();
            expect(onAgentEvent.mock.calls.some(([emitted]) => emitted.stream === "usage")).toBe(
              false,
            );
          }
        });
        const { total, cost, ...tokens } = expected;
        expect(completed?.usage).toMatchObject({ ...tokens, totalTokens: total, cost });
        expect(subscription.getUsageTotals()).toMatchObject({
          ...tokens,
          total,
          cost: { total: cost.total },
        });
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
          onAgentEvent.mock.calls
            .map(([event]) => event)
            .filter((event) => event.stream === "usage"),
        ).toEqual([{ stream: "usage", data: { outputTokens: expected.output } }]);
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    { costTotal: 0, priorCall: false },
    { costTotal: 0.125, priorCall: false },
    { costTotal: 0, priorCall: true },
    { costTotal: 0.125, priorCall: true },
  ])(
    "retains billed cost-only $costTotal with prior call $priorCall",
    async ({ costTotal, priorCall }) => {
      const onAgentEvent = vi.fn();
      const harness = createSubscribedSessionHarness({
        runId: "run-cost-only-" + costTotal + "-" + priorCall,
        lifecycleGeneration: agentEvents.getAgentEventLifecycleGeneration(),
        onAgentEvent,
        sessionExtras: { sessionManager: SessionManager.inMemory() },
      });
      const { session, subscription } = harness;
      const priorCost = priorCall ? 0.25 : 0;
      const usage = makeUsage({ cost: costTotal, billed: true });
      try {
        const completed = await runUsageCalls(harness, [
          ...(priorCall ? [{ usage: makeUsage({ input: 100, output: 20, cost: priorCost }) }] : []),
          { usage },
        ]);
        expect(subscription.getUsageTotals()?.cost).toEqual({
          total: priorCost + costTotal,
          ...(priorCall ? {} : { totalOrigin: "provider-billed" }),
        });
        const lastCallUsage = subscription.getLastAssistantUsage();
        if (priorCall) {
          expect(lastCallUsage).toMatchObject({ input: 100, output: 20, total: 120 });
        } else {
          expect(lastCallUsage).toBeUndefined();
        }
        expect(completed.at(-1)?.usage.cost).toMatchObject({
          total: costTotal,
          totalOrigin: "provider-billed",
        });
        recordSessionModelUsage(session.sessionManager, usage);
        recordSessionModelUsage(
          session.sessionManager,
          makeUsage({ input: 5, output: 2, cost: 0.05 }),
        );
        expect(subscription.getUsageTotals()).toMatchObject({
          input: (priorCall ? 100 : 0) + 5,
          output: (priorCall ? 20 : 0) + 2,
          cost: { total: priorCost + costTotal * 2 + 0.05 },
        });
        expect(subscription.getLastAssistantUsage()).toEqual(lastCallUsage);
        expect(
          onAgentEvent.mock.calls
            .map(([event]) => event)
            .filter((event) => event.stream === "usage"),
        ).toEqual([
          ...(priorCall ? [{ stream: "usage", data: { outputTokens: 20 } }] : []),
          { stream: "usage", data: { outputTokens: (priorCall ? 20 : 0) + 2 } },
        ]);
      } finally {
        subscription.unsubscribe();
      }
      recordSessionModelUsage(session.sessionManager, makeUsage({ input: 9, output: 9, cost: 9 }));
      expect(subscription.getUsageTotals()?.cost).toEqual({
        total: priorCost + costTotal * 2 + 0.05,
      });
    },
  );

  it("sums per-call prices without selecting a tier from the tool-loop token total", async () => {
    const harness = createSubscribedSessionHarness({ runId: "run-loop-cost" });
    const { subscription } = harness;
    try {
      await runUsageCalls(
        harness,
        [0.125, 0.5].map((cost) => ({
          usage: makeUsage({ input: 150_000, output: 100, totalTokens: 0, cost }),
        })),
      );
      expect(subscription.getUsageTotals()).toMatchObject({
        input: 300_000,
        output: 200,
        total: 300_200,
        cost: { total: 0.625 },
      });
      expect(subscription.getLastAssistantUsage()?.cost).toEqual({ total: 0.5 });
    } finally {
      subscription.unsubscribe();
    }
  });

  it("retains the last nonzero call when a later aborted message reports zero usage", async () => {
    const harness = createSubscribedSessionHarness({ runId: "run-aborted-usage" });
    const { subscription } = harness;
    try {
      const completed = await runUsageCalls(harness, [
        { usage: makeUsage({ input: 38_333, output: 66, cacheRead: 120_320 }) },
        { usage: makeUsage(), stopReason: "aborted" },
      ]);
      expect(subscription.getLastAssistantUsage()).toMatchObject({
        input: 38_333,
        output: 66,
        cacheRead: 120_320,
        total: 158_719,
      });
      expect(completed.at(-1)?.usage).toMatchObject({ input: 0, output: 0, totalTokens: 0 });
    } finally {
      subscription.unsubscribe();
    }
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
    try {
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
        retryUsage
          ? { input: 340, output: 50, total: 390 }
          : { input: 100, output: 20, total: 120 },
      );
    } finally {
      subscription.unsubscribe();
    }
  });

  it.each([false, true])(
    "distinguishes transport zero from explicitly unknown context=%j",
    async (unknownContext) => {
      const onAgentEvent = vi.fn();
      const onContextAccountingEvent = vi.fn();
      const harness = createSubscribedSessionHarness({
        runId: "run-zero-usage-" + unknownContext,
        lifecycleGeneration: agentEvents.getAgentEventLifecycleGeneration(),
        onAgentEvent,
        onContextAccountingEvent,
      });
      const { subscription } = harness;
      let terminal: AssistantMessage | undefined;
      try {
        await runUsageCalls(
          harness,
          [
            {
              usage: makeUsage(unknownContext ? { contextUsage: { state: "unavailable" } } : {}),
            },
          ],
          (event) => {
            if (event.type === "message_end" && event.message.role === "assistant") {
              terminal = event.message;
            }
          },
        );
        expect(onContextAccountingEvent.mock.calls).toEqual([
          [{ kind: "model", contextTokens: undefined, successful: false }],
          [{ kind: "model", contextTokens: undefined, successful: true }],
        ]);
        const usageEvents = onAgentEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.stream === "usage");
        if (unknownContext) {
          expect(subscription.getLastAssistantUsage()?.contextUsage).toEqual({
            state: "unavailable",
          });
        } else {
          expect(subscription.getUsageTotals()).toBeUndefined();
          expect(subscription.getLastAssistantUsage()).toBeUndefined();
        }
        expect(usageEvents).toEqual([]);
        expectDefined(terminal, "Expected assistant completion").usage.input = 999;
        const snapshot = expectDefined(
          subscription.getCurrentAttemptAssistant(),
          "Expected the owned assistant snapshot",
        );
        expect(snapshot.usage.input).toBe(0);
        snapshot.usage.input = 500;
        expect(subscription.getCurrentAttemptAssistant()?.usage.input).toBe(0);
      } finally {
        subscription.unsubscribe();
      }
    },
  );
});
