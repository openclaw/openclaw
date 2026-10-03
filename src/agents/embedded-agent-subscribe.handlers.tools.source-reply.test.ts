// Tool-authored source replies at tool completion: only a tool whose author
// declared `canDeliverSourceReply` can hand the host a deliverable reply, and the
// host records it as the assistant turn before delivery.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.js";
import {
  createTestContext,
  endTool,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";

const persistToolAuthoredSourceReply = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./embedded-agent-tool-authored-source-reply.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./embedded-agent-tool-authored-source-reply.js")>();
  return { ...actual, persistToolAuthoredSourceReply };
});

function createContext(sourceReplyCapableToolNames: ReadonlySet<string>) {
  const { ctx } = createTestContext();
  ctx.params.config = { agents: {} } as never;
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
  params: { toolName: string; details: Record<string, unknown>; isError?: boolean },
) {
  await handleToolExecutionStart(ctx, {
    type: "tool_execution_start",
    toolName: params.toolName,
    toolCallId: "tc-1",
    args: {},
  });
  await endTool(ctx, {
    toolName: params.toolName,
    toolCallId: "tc-1",
    isError: params.isError ?? false,
    result: {
      content: [{ type: "text", text: JSON.stringify(params.details) }],
      details: params.details,
    },
  });
}

describe("tool-authored source replies at tool completion", () => {
  beforeEach(() => {
    persistToolAuthoredSourceReply.mockClear();
  });

  it("queues a deliverable reply for a capable tool and persists the assistant turn", async () => {
    const ctx = createContext(new Set(["order_status"]));

    await completeTool(ctx, { toolName: "order_status", details: replyDetails });

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
        mediaUrls: ["/tmp/albaran.pdf"],
        toolAuthored: true,
        idempotencyKey: "run-test:tool-source-reply:tc-1",
        sourceReplyFinal: true,
      },
    ]);
    // Delivery is the host's job here, so message-tool delivery state is untouched.
    expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(false);
    expect(ctx.state.sourceReplyDeliveryState).not.toBe("delivered");
    expect(persistToolAuthoredSourceReply).toHaveBeenCalledTimes(1);
    expect(persistToolAuthoredSourceReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:unit-session",
        sessionId: "session-test-id",
        agentId: "agent-test-id",
        runId: "run-test",
        toolName: "order_status",
        toolCallId: "tc-1",
        idempotencyKey: "run-test:tool-source-reply:tc-1",
        sourceReplyFinal: true,
        payload: expect.objectContaining({ text: replyDetails.sourceReply.text }),
      }),
    );
  });

  it("ignores sourceReply details from a tool without the capability", async () => {
    const ctx = createContext(new Set(["other_tool"]));

    await completeTool(ctx, { toolName: "order_status", details: replyDetails });

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
    expect(persistToolAuthoredSourceReply).not.toHaveBeenCalled();
  });

  it("ignores error results from a capable tool", async () => {
    const ctx = createContext(new Set(["order_status"]));

    await completeTool(ctx, { toolName: "order_status", details: replyDetails, isError: true });

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
    expect(persistToolAuthoredSourceReply).not.toHaveBeenCalled();
  });

  it("marks progress replies as not final", async () => {
    const ctx = createContext(new Set(["order_status"]));

    await completeTool(ctx, {
      toolName: "order_status",
      details: { sourceReply: { text: "Comprobando stock…", final: false } },
    });

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([
      expect.objectContaining({ text: "Comprobando stock…", sourceReplyFinal: false }),
    ]);
    expect(persistToolAuthoredSourceReply).toHaveBeenCalledWith(
      expect.objectContaining({ sourceReplyFinal: false }),
    );
  });
});
