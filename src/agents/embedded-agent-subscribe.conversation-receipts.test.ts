import { describe, expect, it } from "vitest";
import { recordEmbeddedToolReceipt } from "./embedded-agent-runner/tool-send-receipts.js";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import { createAgentToolResultMiddlewareRunner } from "./harness/tool-result-middleware.js";

describe("embedded conversation delivery evidence", () => {
  it.each(["conversations_send", "conversations_turn"])(
    "does not infer %s delivery from a presentation rewrite",
    async (toolName) => {
      const { session, emit } = createStubSessionHarness();
      const sessionManager = {};
      Object.assign(session, { sessionManager });
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: "conversation-rewrite",
      });
      const args = {
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        message: "Still queued",
      };
      const rawResult = {
        content: [{ type: "text" as const, text: "Queued" }],
        details: { status: "queued", messageId: "prepared-1" },
      };
      const middleware = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
        () => ({
          result: {
            content: [{ type: "text", text: "Presentation says sent" }],
            details: { status: "sent", messageId: "prepared-1" },
          },
        }),
      ]);
      try {
        emit({ type: "tool_execution_start", toolName, toolCallId: "conversation-call", args });
        await Promise.resolve();
        recordEmbeddedToolReceipt(sessionManager, "conversation-call", rawResult.details, false);
        const result = await middleware.applyToolResultMiddleware({
          toolCallId: "conversation-call",
          toolName,
          args,
          result: rawResult,
        });
        emit({
          type: "tool_execution_end",
          toolName,
          toolCallId: "conversation-call",
          isError: false,
          result,
        });
        await subscription.waitForPendingEvents();

        expect(subscription.didSendViaMessagingTool()).toBe(false);
        expect(subscription.getMessagingToolSentTexts()).toEqual([]);
        expect(subscription.getMessagingToolSentTargets()).toEqual([]);
      } finally {
        subscription.unsubscribe();
      }
    },
  );
});
