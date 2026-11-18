import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { EmbeddedContextAccountingEvent } from "./embedded-agent-runner/run/internal-params.js";
import {
  createStubSessionHarness,
  createSubscribedSessionHarness,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeZeroUsageSnapshot } from "./usage.js";

function harness(params: Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId"> = {}) {
  const observed: EmbeddedContextAccountingEvent[] = [];
  const result = createSubscribedSessionHarness({
    runId: "compaction",
    onContextAccountingEvent: (event) => observed.push(event),
    ...params,
  });
  onTestFinished(() => result.subscription.unsubscribe());
  return {
    ...result,
    observed,
    attempt: () => [
      result.subscription.getCurrentAttemptAssistant(),
      result.subscription.assistantTexts,
      result.subscription.getLastAssistantUsage(),
    ],
    startTool: (toolName: string, args: Record<string, unknown>, toolCallId = toolName) =>
      result.emit({ type: "tool_execution_start", toolName, toolCallId, args }),
    endTool: (toolName: string, text: string) =>
      result.emit({
        type: "tool_execution_end",
        toolName,
        toolCallId: toolName,
        isError: false,
        result: { content: [{ type: "text", text }] },
      }),
  };
}
function completed(willRetry = true, tokensBefore = 100, tokensAfter = 50) {
  return {
    type: "compaction_end",
    reason: willRetry ? "overflow" : "threshold",
    outcome: { status: "completed", tokensBefore, tokensAfter, willRetry },
  } as const;
}
const skipped = {
  type: "compaction_end",
  reason: "threshold",
  outcome: { status: "skipped", reason: "Nothing to compact (session too small)" },
} as const;
const usage = (input: number, output = 0, cacheRead = 0) => ({
  ...makeZeroUsageSnapshot(),
  input,
  output,
  cacheRead,
  totalTokens: input + output + cacheRead,
});
function assistant(input: number, overrides: Partial<AssistantMessage> = {}) {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text: "model reply" }],
    usage: usage(input),
    ...overrides,
  });
}
type Emit = ReturnType<typeof harness>["emit"];
function message(emit: Emit, value: AssistantMessage) {
  emit({ type: "message_start", message: value });
  emit({ type: "message_end", message: value });
}

it.each([false, true])(
  "records unavailable context without old usage backfill (failed retry=%s)",
  (failedRetry) => {
    const { emit, observed } = harness({ sessionPersistence: "detached" });
    if (failedRetry) {
      message(emit, assistant(90_000));
    }
    emit(completed(failedRetry, 90_000, 12_000));
    message(
      emit,
      failedRetry
        ? assistant(0, { stopReason: "error" })
        : assistant(90_000, {
            usage: { ...usage(90_000), contextUsage: { state: "unavailable" } },
          }),
    );
    expect(observed).toEqual(
      (failedRetry ? [90_000, undefined] : [undefined]).map((contextTokens) => ({
        kind: "model",
        contextTokens,
        successful: false,
      })),
    );
  },
);

it("captures repaired model usage before queued delivery and throwing cleanup", async () => {
  const deliveryStarted = createDeferred();
  const releaseDelivery = createDeferred();
  const cleanupError = new Error("subscription cleanup failed");
  const observed: EmbeddedContextAccountingEvent[] = [];
  const { session, emit } = createStubSessionHarness();
  const subscribe = session.subscribe.bind(session);
  session.subscribe = (listener) => {
    const unsubscribe = subscribe(listener);
    return () => {
      unsubscribe();
      throw cleanupError;
    };
  };
  let aborted = false;
  const subscription = subscribeEmbeddedAgentSession({
    session,
    runId: "held-accounting",
    sessionPersistence: "detached",
    isTerminalAborted: () => aborted,
    blockReplyBreak: "message_end",
    onBlockReply: () => {},
    onBlockReplyFlush: () => {
      deliveryStarted.resolve();
      return releaseDelivery.promise;
    },
    onContextAccountingEvent: (event) => observed.push(event),
  });
  const expected: EmbeddedContextAccountingEvent[] = [
    { kind: "model", contextTokens: 90_000, successful: false },
    { kind: "model", contextTokens: 20_000, successful: false },
  ];
  try {
    message(emit, assistant(90_000));
    await deliveryStarted.promise;
    emit(completed(false, 90_000, 12_000));
    const after = assistant(0);
    emit({ type: "message_start", message: after });
    const partial = { ...after, usage: usage(18_000, 0, 2_000) };
    emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "model reply",
        partial,
      },
    });
    emit({ type: "message_end", message: after });
    for (const model of ["delivery-mirror", "gateway-injected"]) {
      message(emit, { ...assistant(99_000), provider: "openclaw", model });
      const withoutUsage = { role: "assistant", provider: "openclaw", model };
      emit({ type: "message_end", message: withoutUsage });
      expect(withoutUsage).not.toHaveProperty("usage");
    }
    expect(observed).toEqual(expected);
    expect(after.usage.input).toBe(18_000);
    aborted = true;
  } finally {
    try {
      expect(() => subscription.unsubscribe()).toThrow(cleanupError);
    } finally {
      releaseDelivery.resolve();
      await subscription.waitForPendingEvents();
    }
  }
  expect(observed).toEqual(expected);
});

it.each([false, true])("waits for compaction and every retry (retry=%s)", async (retry) => {
  const { emit, subscription, attempt } = harness();
  emit({ type: "compaction_start" });
  expect(subscription.isCompacting()).toBe(true);
  expect(subscription.getCompactionCount()).toBe(0);
  if (retry) {
    const reply = assistant(100, { usage: usage(100, 20, 300) });
    emit({ type: "message_end", message: reply });
    expect(attempt()).toEqual([
      reply,
      ["model reply"],
      expect.objectContaining({ input: 100, output: 20, cacheRead: 300, total: 420 }),
    ]);
    emit(completed(true, 20_000, 12_345));
    expect(attempt()).toEqual([undefined, [], undefined]);
    expect(subscription.getCompactionCount()).toBe(1);
    expect(subscription.getLastCompactionTokensAfter()).toBe(12_345);
    emit(completed());
    expect(subscription.getCompactionCount()).toBe(2);
  }
  const resolved = vi.fn();
  const pending = subscription.waitForCompactionRetry().then(resolved);
  await Promise.resolve();
  expect(resolved).not.toHaveBeenCalled();
  if (retry) {
    emit({ type: "agent_end" });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
  }
  emit(retry ? { type: "agent_end" } : skipped);
  await pending;
  expect(resolved).toHaveBeenCalledOnce();
  expect(subscription.isCompacting()).toBe(false);
});

it("rejects compaction waits with AbortError when unsubscribed", async () => {
  const abortCompaction = vi.fn();
  const { emit, subscription } = harness({
    sessionExtras: { isCompacting: true, abortCompaction },
  });
  emit({ type: "compaction_start" });
  const pending = subscription.waitForCompactionRetry();
  subscription.unsubscribe();
  for (const wait of [pending, subscription.waitForCompactionRetry()]) {
    const aborted: unknown = await wait.catch((error: unknown) => error);
    expect(aborted).toBeInstanceOf(Error);
    expect(aborted).toHaveProperty("name", "AbortError");
  }
  expect(abortCompaction).toHaveBeenCalledTimes(1);
});
it.each(["off", "on", "full"] as const)("emits %s tool summaries", async (verboseLevel) => {
  const onToolResult = vi.fn<NonNullable<SubscribeEmbeddedAgentSessionParams["onToolResult"]>>();
  const { subscription, startTool, endTool } = harness({
    verboseLevel,
    onToolResult,
    ...(verboseLevel === "off" ? { shouldEmitToolResult: () => true } : {}),
  });
  const steps =
    verboseLevel === "full"
      ? ([
          ["exec", { command: "claude", pty: true }, ["pty", "claude"]],
          ["exec", "hello\nworld", ["hello", "```txt"]],
          ["read", "file data", ["file data"]],
        ] as const)
      : verboseLevel === "off"
        ? ([["read", { path: "/tmp/c.txt" }, []]] as const)
        : ([["exec", { command: "echo private-sentinel" }, ["Exec"]]] as const);
  for (const [index, [toolName, input, expected]] of steps.entries()) {
    if (typeof input === "string") {
      endTool(toolName, input);
    } else {
      startTool(toolName, input);
    }
    await subscription.waitForPendingEvents();
    expect(onToolResult).toHaveBeenCalledTimes(index + 1);
    for (const fragment of expected) {
      expect(onToolResult.mock.calls[index]?.[0].text).toContain(fragment);
    }
  }
  if (verboseLevel === "on") {
    expect(onToolResult.mock.calls[0]?.[0].text).not.toContain("private-sentinel");
  }
});
