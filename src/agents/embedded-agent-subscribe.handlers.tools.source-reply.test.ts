import { Type } from "typebox";
import { expect, it } from "vitest";
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
const result = (details: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: "Status read." }],
  details,
});

it.each([
  ["rewrites", originalDetails, { sourceReply: { text: "Safe reply." } }, ["Safe reply."]],
  ["withdraws", originalDetails, { redacted: true }, []],
  ["adds", { ok: true }, { sourceReply: { text: "Added reply." } }, ["Added reply."]],
] as const)(
  "%s the source reply through a real message_end extension",
  async (_label, initial, final, expected) => {
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
        createAssistantResultStream(createAssistant(model, "Model continued.")),
      );
    const { session } = await createTestSession({
      customTools: [
        {
          name: "order_status",
          label: "Order status",
          description: "Read order status",
          parameters: Type.Object({}),
          execute: async () => result(initial),
        },
      ],
      resourceLoader: await createResourceLoader((api) => {
        api.on("message_end", async (event: unknown) => {
          const { message } = event as MessageEndEvent;
          return message.role === "toolResult"
            ? { message: { ...message, details: final } }
            : undefined;
        });
      }),
    });
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run-finalized",
      sourceReplyCapableToolNames: new Set(["order_status"]),
    });
    try {
      await session.prompt("Check the order.");
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(expected.length ? 1 : 2);
      expect(subscription.getMessagingToolSourceReplyPayloads().map((reply) => reply.text)).toEqual(
        expected,
      );
      expect(subscription.getSourceReplyDelivered()).toBeUndefined();
      expect(session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
        details: final,
      });
    } finally {
      subscription.unsubscribe();
    }
  },
);

it("does not deliver a capable tool's nested Code Mode result", async () => {
  const { ctx } = createTestContext();
  ctx.params.sourceReplyCapableToolNames = new Set(["order_status"]);
  const tool = { toolName: "order_status", toolCallId: "nested-1" };
  await handleToolExecutionStart(ctx, {
    type: "tool_execution_start",
    ...tool,
    args: {},
    lifecycleProvenance: "nested",
    parentToolCallId: "exec-1",
  });
  await endTool(ctx, {
    ...tool,
    isError: false,
    result: result(originalDetails),
  });
  expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
});
