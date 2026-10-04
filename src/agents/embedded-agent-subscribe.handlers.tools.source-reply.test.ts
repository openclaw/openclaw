// Tool-authored source replies at tool completion: only a tool whose author
// declared `canDeliverSourceReply` can hand the host a deliverable reply, and the
// host records it as the assistant turn before delivery.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.js";
import {
  createTestContext,
  endTool,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";

const persistInternalSourceReply = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../gateway/internal-source-reply-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/internal-source-reply-persistence.js")>()),
  persistInternalSourceReply,
}));

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
    persistInternalSourceReply.mockClear();
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
    // The reply is written to the transcript as the assistant turn before the turn settles.
    expect(persistInternalSourceReply).toHaveBeenCalledTimes(1);
    expect(persistInternalSourceReply).toHaveBeenCalledWith({
      cfg: { agents: {} },
      sessionKey: "agent:unit-session",
      expectedSessionId: "session-test-id",
      agentId: "agent-test-id",
      payload: {
        text: replyDetails.sourceReply.text,
        mediaUrls: ["/tmp/albaran.pdf"],
      },
      idempotencyKey: "run-test:tool-source-reply:tc-1",
      runId: "run-test",
      sourceReplyFinal: true,
      toolCallId: "tc-1",
    });
  });

  it("ignores sourceReply details from a tool without the capability", async () => {
    const ctx = createContext(new Set(["other_tool"]));

    await completeTool(ctx, { toolName: "order_status", details: replyDetails });

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
    expect(persistInternalSourceReply).not.toHaveBeenCalled();
  });

  it("ignores error results from a capable tool", async () => {
    const ctx = createContext(new Set(["order_status"]));

    await completeTool(ctx, { toolName: "order_status", details: replyDetails, isError: true });

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
    expect(persistInternalSourceReply).not.toHaveBeenCalled();
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
    expect(persistInternalSourceReply).toHaveBeenCalledWith(
      expect.objectContaining({ sourceReplyFinal: false }),
    );
  });
});

describe("tool-authored source reply persistence failures", () => {
  it("still queues the reply when the transcript write fails", async () => {
    persistInternalSourceReply.mockRejectedValueOnce(new Error("transcript locked"));
    const ctx = createContext(new Set(["order_status"]));

    await completeTool(ctx, { toolName: "order_status", details: replyDetails });

    expect(ctx.state.messagingToolSourceReplyPayloads).toHaveLength(1);
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("tool-authored source reply not persisted"),
    );
  });
});
