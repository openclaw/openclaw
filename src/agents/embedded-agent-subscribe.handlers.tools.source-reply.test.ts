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
const request = () =>
  ({ type: "toolCall", id: "reply-1", name: "order_status", arguments: {} }) as const;
const toolInfo = { name: "order_status", label: "Order status", description: "Read order status" };
const response = (...args: Parameters<typeof createAssistant>) =>
  createAssistantResultStream(createAssistant(...args));
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
      .mockImplementationOnce((model) => response(model, [request()], "toolUse"))
      .mockImplementation((model) => response(model, "Model continued."));
    const parameters = Type.Object({});
    const { session } = await createTestSession({
      customTools: [{ ...toolInfo, parameters, execute: async () => result(initial) }],
      resourceLoader: await createResourceLoader((api) => {
        api.on("message_end", async (event: unknown) => {
          const { message } = event as MessageEndEvent;
          return message.role === "toolResult"
            ? { message: { ...message, details: final } }
            : undefined;
        });
      }),
    });
    const sub = subscribeEmbeddedAgentSession({
      session,
      runId: "run-finalized",
      sourceReplyCapableToolNames: new Set(["order_status"]),
    });
    try {
      await session.prompt("Check the order.");
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(expected.length ? 1 : 2);
      expect(sub.getMessagingToolSourceReplyPayloads().map((reply) => reply.text)).toEqual(
        expected,
      );
      expect(sub.getSourceReplyDelivered()).toBeUndefined();
      const toolResult = session.messages.findLast((entry) => entry.role === "toolResult");
      expect(toolResult).toMatchObject({ details: final });
    } finally {
      sub.unsubscribe();
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
    result: result(originalDetails),
  });
  expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
});
