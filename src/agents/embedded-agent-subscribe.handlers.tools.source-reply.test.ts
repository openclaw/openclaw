// Tool-authored source replies at tool completion: only a direct call to a tool
// whose author declared `canDeliverSourceReply` can hand the host a reply.
import { describe, expect, it } from "vitest";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import {
  createTestContext,
  endTool,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";

function createContext(sourceReplyCapableToolNames: ReadonlySet<string>) {
  const { ctx } = createTestContext();
  ctx.params.sourceReplyCapableToolNames = sourceReplyCapableToolNames;
  return ctx;
}

const replyDetails = {
  ok: true,
  final_answer: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
  sourceReply: {
    text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
    mediaUrls: ["/tmp/albaran.pdf"],
  },
};

async function completeTool(
  ctx: ReturnType<typeof createContext>,
  params: {
    toolName: string;
    details: Record<string, unknown>;
    isError?: boolean;
    parentToolCallId?: string;
    assistantTurnId?: string;
  },
) {
  await handleToolExecutionStart(ctx, {
    type: "tool_execution_start",
    toolName: params.toolName,
    toolCallId: "tc-1",
    args: {},
    ...(params.parentToolCallId
      ? { lifecycleProvenance: "nested" as const, parentToolCallId: params.parentToolCallId }
      : {}),
  });
  await endTool(ctx, {
    toolName: params.toolName,
    toolCallId: "tc-1",
    isError: params.isError ?? false,
    assistantTurnId: params.assistantTurnId,
    result: {
      content: [{ type: "text", text: JSON.stringify(params.details) }],
      details: params.details,
    },
  });
}

describe("tool-authored source replies at tool completion", () => {
  it("scopes reused call ids to assistant turns and keeps replays stable across runs", async () => {
    const ctx = createContext(new Set(["order_status"]));

    for (const [index, turn] of [1, 2, 1].entries()) {
      // The replay runs under a recovery run id, as restart recovery does.
      ctx.params.runId = index === 2 ? "run-recovery" : "run-test";
      await completeTool(ctx, {
        toolName: "order_status",
        assistantTurnId: `turn-${turn}`,
        details: { sourceReply: { text: `Order ${turn} created.` } },
      });
    }

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "Order 1 created.",
        idempotencyKey: "turn-1:tool-source-reply:tc-1",
        sourceReplyFinal: true,
        toolAuthored: true,
      },
      {
        text: "Order 2 created.",
        idempotencyKey: "turn-2:tool-source-reply:tc-1",
        sourceReplyFinal: true,
        toolAuthored: true,
      },
      {
        text: "Order 1 created.",
        idempotencyKey: "turn-1:tool-source-reply:tc-1",
        sourceReplyFinal: true,
        toolAuthored: true,
      },
    ]);
  });

  it("queues a final reply from a direct call to a capable mixed-case tool", async () => {
    const ctx = createContext(new Set(["order_status"]));

    await completeTool(ctx, { toolName: "Order_Status", details: replyDetails });

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
        mediaUrls: ["/tmp/albaran.pdf"],
        idempotencyKey: "run-test:tool-source-reply:tc-1",
        sourceReplyFinal: true,
        toolAuthored: true,
      },
    ]);
    // Delivery is the host's job here, so message-tool delivery state is untouched.
    expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(false);
    expect(ctx.state.sourceReplyDeliveryState).not.toBe("delivered");
  });

  it.each([
    {
      label: "the tool lacks the capability",
      capable: new Set(["other_tool"]),
    },
    { label: "the result is an error", capable: new Set(["order_status"]), isError: true },
    {
      label: "the call is nested inside a Code Mode program",
      capable: new Set(["order_status"]),
      parentToolCallId: "exec-1",
    },
    {
      label: "the reply is not final",
      capable: new Set(["order_status"]),
      details: { sourceReply: { text: "Comprobando stock…", final: false } },
    },
  ])("queues nothing when $label", async ({ capable, details, isError, parentToolCallId }) => {
    const ctx = createContext(capable);

    await completeTool(ctx, {
      toolName: "order_status",
      details: details ?? replyDetails,
      isError,
      parentToolCallId,
    });

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
  });
});
