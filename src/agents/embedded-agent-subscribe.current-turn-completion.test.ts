import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  createCurrentTurnDeliveryTool,
  type CurrentTurnDelivery,
} from "./current-turn-delivery.js";
import {
  createCurrentTurnReplyCompletionOwner,
  readCurrentTurnReplyCompletion,
} from "./current-turn-reply-completion.js";
import {
  createStubSessionHarness,
  emitAssistantTextDeltaAndEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";

type Outcome = Awaited<ReturnType<CurrentTurnDelivery["send"]>>;

function createHarness() {
  const owner = createCurrentTurnReplyCompletionOwner();
  const { session, emit } = createStubSessionHarness();
  Object.assign(session, { sessionManager: {} });
  const callbacks = {
    onBlockReply: vi.fn(),
    onPartialReply: vi.fn(),
    onReasoningStream: vi.fn(),
    onReasoningEnd: vi.fn(),
    onAssistantMessageStart: vi.fn(),
    onToolResult: vi.fn(),
    onAgentEvent: vi.fn(),
    onAgentToolResult: vi.fn(),
  };
  const subscription = subscribeEmbeddedAgentSession(
    {
      session,
      runId: "current-turn-completion",
      blockReplyBreak: "message_end",
      reasoningMode: "stream",
      verboseLevel: "on",
      observeToolTerminal: createToolTerminalObserver("current-turn-completion"),
      ...callbacks,
    },
    owner,
  );
  return { owner, emit, callbacks, subscription };
}

describe("host current-turn completion in the subscriber", () => {
  it.each([
    { status: "sent", confirmed: true },
    { status: "partial_failed", confirmed: false },
  ] as const)(
    "suppresses later channel output but retains $status lifecycle evidence",
    async ({ status, confirmed }) => {
      const { owner, emit, callbacks, subscription } = createHarness();
      const outcome: Outcome = confirmed
        ? { status }
        : { status, sentBeforeError: true, error: "adapter acknowledgement lost" };
      const tool = createCurrentTurnDeliveryTool({ send: async () => outcome }, owner);
      const onTerminal = vi.fn();
      try {
        await subscription.runToolLifecycle({
          toolName: tool.name,
          toolCallId: "source-send",
          args: { text: "source reply" },
          hideFromChannelProgress: true,
          execute: async (started) => {
            started();
            const result = await tool.execute("source-send", { text: "source reply" });
            callbacks.onAgentEvent.mockClear();
            return result;
          },
          onTerminal,
        });
        const originalError = subscription.getLastToolError();
        expect(originalError?.error).toBe(confirmed ? undefined : "adapter acknowledgement lost");
        expect(subscription.getSourceReplyDelivered()).toBe(confirmed ? true : undefined);
        expect(onTerminal).toHaveBeenCalledWith(
          expect.objectContaining({
            isError: !confirmed,
            result: expect.objectContaining({ details: outcome, terminate: true }),
          }),
        );
        expect(callbacks.onAgentToolResult).toHaveBeenCalledOnce();
        expect(callbacks.onAgentEvent).not.toHaveBeenCalled();
        for (const callback of Object.values(callbacks)) {
          callback.mockClear();
        }
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }] },
          assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
        });
        emit({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "thinking_end" },
        });
        emitAssistantTextDeltaAndEnd({ emit, text: "ordinary final stays in transcript" });
        await subscription.waitForPendingEvents();
        for (const key of [
          "onBlockReply",
          "onPartialReply",
          "onReasoningStream",
          "onReasoningEnd",
          "onAssistantMessageStart",
          "onToolResult",
        ] as const) {
          expect(callbacks[key], key).not.toHaveBeenCalled();
        }
        expect(
          callbacks.onAgentEvent.mock.calls.some(([event]) =>
            ["assistant", "item"].includes(event.stream),
          ),
        ).toBe(false);
        expect(subscription.assistantTexts).toContain("ordinary final stays in transcript");
        expect(subscription.getLastToolError()).toEqual(originalError);
      } finally {
        subscription.unsubscribe();
      }
      const next = createHarness();
      try {
        expect(readCurrentTurnReplyCompletion(next.owner)).toBeUndefined();
        expect(next.subscription.getSourceReplyDelivered()).toBeUndefined();
        expect(next.subscription.getLastToolError()).toBeUndefined();
        emitAssistantTextDeltaAndEnd({ emit: next.emit, text: "next turn is independent" });
        await next.subscription.waitForPendingEvents();
        expect(next.callbacks.onBlockReply).toHaveBeenCalledOnce();
      } finally {
        next.subscription.unsubscribe();
      }
    },
  );

  it.each(["impostor", "pre-I/O failure"] as const)(
    "does not grant suppression to %s",
    async (mode) => {
      const { owner, emit, callbacks, subscription } = createHarness();
      const source = createCurrentTurnDeliveryTool(
        { send: async () => ({ status: "failed", error: "policy denied before dispatch" }) },
        owner,
      );
      try {
        await subscription.runToolLifecycle({
          toolName: source.name,
          toolCallId: "not-delivered",
          args: { text: "reply" },
          hideFromChannelProgress: true,
          execute: () =>
            mode === "impostor"
              ? Promise.resolve({
                  content: [],
                  details: {
                    status: "sent",
                    sourceReplyDelivered: true,
                    completionOwner: owner,
                    messageDelivery: { sourceReplyDelivered: true, status: "settled" },
                  },
                })
              : source.execute("not-delivered", { text: "reply" }),
        });
        expect(subscription.getSourceReplyDelivered()).toBeUndefined();
        emitAssistantTextDeltaAndEnd({ emit, text: "ordinary reply is still required" });
        await subscription.waitForPendingEvents();
        expect(callbacks.onBlockReply).toHaveBeenCalledOnce();
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it.each(["metadata rewritten", "projection rejected", "late abort"] as const)(
    "retains the producer fact after %s",
    async (mode) => {
      const { owner, emit, callbacks, subscription } = createHarness();
      const source = createCurrentTurnDeliveryTool(
        {
          send: async () => ({
            status: "partial_failed",
            sentBeforeError: true,
            error: "adapter acknowledgement lost",
          }),
        },
        owner,
      );
      const onTerminal = vi.fn();
      try {
        const execution = subscription.runToolLifecycle({
          toolName: source.name,
          toolCallId: "source-send",
          args: { text: "reply" },
          hideFromChannelProgress: true,
          execute: async (started) => {
            started();
            const result = await source.execute("source-send", { text: "reply" });
            if (mode !== "metadata rewritten") {
              throw new Error(mode);
            }
            if (!isRecord(result.details)) {
              throw new Error("Expected mutable delivery result details");
            }
            Object.assign(result.details, { status: "failed", sentBeforeError: false });
            return result;
          },
          onTerminal,
        });
        if (mode === "metadata rewritten") {
          await execution;
        } else {
          await expect(execution).rejects.toThrow(mode);
        }
        expect(readCurrentTurnReplyCompletion(owner)).toBe("ambiguous");
        expect(subscription.getSourceReplyDelivered()).toBeUndefined();
        expect(subscription.getLastToolError()?.error).toBe(
          mode === "metadata rewritten" ? "adapter acknowledgement lost" : mode,
        );
        expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ isError: true }));
        callbacks.onToolResult.mockClear();
        emitAssistantTextDeltaAndEnd({ emit, text: "do not send another reply" });
        await subscription.waitForPendingEvents();
        expect(callbacks.onBlockReply).not.toHaveBeenCalled();
        expect(callbacks.onToolResult).not.toHaveBeenCalled();
      } finally {
        subscription.unsubscribe();
      }
    },
  );
});
