// Real AgentSession extensions finalize tool messages after tool_execution_end.
// The subscription must deliver exactly those bytes and make the same completion decision.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import {
  createTestContext,
  endTool,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./sessions/agent-session-loop-resource-loader.test-support.js";
import type { MessageEndEvent } from "./sessions/extensions/types.js";

registerAgentSessionLoopTestLifecycle();

const originalDetails = { sourceReply: { text: "Unreviewed reply." } };

describe("finalized tool-authored source replies", () => {
  it.each([
    {
      label: "rewrites",
      initial: originalDetails,
      final: { sourceReply: { text: "Safe reply." } },
      expected: ["Safe reply."],
    },
    { label: "withdraws", initial: originalDetails, final: { redacted: true }, expected: [] },
    {
      label: "adds",
      initial: { ok: true },
      final: { sourceReply: { text: "Added reply." } },
      expected: ["Added reply."],
    },
  ])(
    "$label the reply through a real message_end extension",
    async ({ initial, final, expected }) => {
      streamMocks.streamSimple
        .mockImplementationOnce((model) =>
          createAssistantResultStream(
            createAssistant(
              model,
              [{ type: "toolCall", id: "reply-1", name: "order_status", arguments: {} }],
              "toolUse",
            ),
          ),
        )
        .mockImplementation((model) =>
          createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "Model continued." }]),
          ),
        );
      const { session } = await createTestSession({
        customTools: [
          {
            name: "order_status",
            label: "Order status",
            description: "Read order status",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "Status read." }],
              details: initial,
            }),
          },
        ],
        resourceLoader: createResourceLoader(
          new Map([
            [
              "message_end",
              [
                async (event: unknown) => {
                  const { message } = event as MessageEndEvent;
                  return message.role === "toolResult"
                    ? { message: { ...message, details: final } }
                    : undefined;
                },
              ],
            ],
          ]),
        ),
      });
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: "run-finalized",
        sourceReplyCapableToolNames: new Set(["order_status"]),
      });
      try {
        await session.prompt("Check the order.");
        expect(streamMocks.streamSimple).toHaveBeenCalledTimes(expected.length ? 1 : 2);
        expect(
          subscription.getMessagingToolSourceReplyPayloads().map((reply) => reply.text),
        ).toEqual(expected);
        expect(subscription.getSourceReplyDelivered()).toBeUndefined();
        expect(session.messages.findLast((message) => message.role === "toolResult")).toMatchObject(
          { details: final },
        );
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it("does not deliver a capable tool's nested Code Mode result", async () => {
    const { ctx } = createTestContext();
    ctx.params.sourceReplyCapableToolNames = new Set(["order_status"]);
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "order_status",
      toolCallId: "nested-1",
      args: {},
      lifecycleProvenance: "nested",
      parentToolCallId: "exec-1",
    });
    await endTool(ctx, {
      toolName: "order_status",
      toolCallId: "nested-1",
      isError: false,
      result: { content: [{ type: "text", text: "Status read." }], details: originalDetails },
    });
    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
  });
});
