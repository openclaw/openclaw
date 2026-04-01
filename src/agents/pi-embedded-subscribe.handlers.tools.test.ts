import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { MessagingToolSend } from "./pi-embedded-messaging.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./pi-embedded-subscribe.handlers.types.js";

type ToolExecutionStartEvent = Extract<AgentEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;

function createTestContext(): {
  ctx: ToolHandlerContext;
  warn: ReturnType<typeof vi.fn>;
  onBlockReplyFlush: ReturnType<typeof vi.fn>;
} {
  const onBlockReplyFlush = vi.fn();
  const warn = vi.fn();
  const ctx: ToolHandlerContext = {
    params: {
      runId: "run-test",
      onBlockReplyFlush,
      onAgentEvent: undefined,
      onToolResult: undefined,
    },
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: undefined,
    log: {
      debug: vi.fn(),
      warn,
    },
    state: {
      toolMetaById: new Map<string, ToolCallSummary>(),
      toolMetas: [],
      toolSummaryById: new Set<string>(),
      consecutiveToolErrors: null,
      pendingMessagingTargets: new Map<string, MessagingToolSend>(),
      pendingMessagingTexts: new Map<string, string>(),
      pendingMessagingMediaUrls: new Map<string, string[]>(),
      pendingToolMediaUrls: [],
      pendingToolAudioAsVoice: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      successfulCronAdds: 0,
      deterministicApprovalPromptSent: false,
    },
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };

  return { ctx, warn, onBlockReplyFlush };
}

/**
 * Generic helper: fires a start+end pair for any tool so individual describe
 * blocks don't need to reimplement the same 10-line pattern.
 */
async function runTool(
  ctx: ToolHandlerContext,
  toolName: string,
  args: Record<string, unknown>,
  isError: boolean,
  id: string,
  errorMsg = "Error: operation failed",
) {
  await handleToolExecutionStart(ctx, {
    type: "tool_execution_start",
    toolName,
    toolCallId: id,
    args,
  });
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName,
    toolCallId: id,
    isError,
    result: isError ? { type: "text", text: errorMsg } : { ok: true },
  });
}

describe("handleToolExecutionStart read path checks", () => {
  it("does not warn when read tool uses file_path alias", async () => {
    const { ctx, warn, onBlockReplyFlush } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-1",
      args: { file_path: "/tmp/example.txt" },
    };

    await handleToolExecutionStart(ctx, evt);

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when read tool has neither path nor file_path", async () => {
    const { ctx, warn } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-2",
      args: {},
    };

    await handleToolExecutionStart(ctx, evt);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("read tool called without path");
  });

  it("awaits onBlockReplyFlush before continuing tool start processing", async () => {
    const { ctx, onBlockReplyFlush } = createTestContext();
    let releaseFlush: (() => void) | undefined;
    onBlockReplyFlush.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
    );

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-await-flush",
      args: { command: "echo hi" },
    };

    const pending = handleToolExecutionStart(ctx, evt);
    // Let the async function reach the awaited flush Promise.
    await Promise.resolve();

    // If flush isn't awaited, tool metadata would already be recorded here.
    expect(ctx.state.toolMetaById.has("tool-await-flush")).toBe(false);
    expect(releaseFlush).toBeTypeOf("function");

    releaseFlush?.();
    await pending;

    expect(ctx.state.toolMetaById.has("tool-await-flush")).toBe(true);
  });
});

describe("handleToolExecutionEnd cron.add commitment tracking", () => {
  it("increments successfulCronAdds when cron add succeeds", async () => {
    const { ctx } = createTestContext();
    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "cron",
        toolCallId: "tool-cron-1",
        args: { action: "add", job: { name: "reminder" } },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "cron",
        toolCallId: "tool-cron-1",
        isError: false,
        result: { details: { status: "ok" } },
      } as never,
    );

    expect(ctx.state.successfulCronAdds).toBe(1);
  });

  it("does not increment successfulCronAdds when cron add fails", async () => {
    const { ctx } = createTestContext();
    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "cron",
        toolCallId: "tool-cron-2",
        args: { action: "add", job: { name: "reminder" } },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "cron",
        toolCallId: "tool-cron-2",
        isError: true,
        result: { details: { status: "error" } },
      } as never,
    );

    expect(ctx.state.successfulCronAdds).toBe(0);
  });
});

describe("handleToolExecutionEnd mutating failure recovery", () => {
  it("clears edit failure when the retry succeeds through common file path aliases", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "tool-edit-1",
        args: {
          file_path: "/tmp/demo.txt",
          old_string: "beta stale",
          new_string: "beta fixed",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "tool-edit-1",
        isError: true,
        result: { error: "Could not find the exact text in /tmp/demo.txt" },
      } as never,
    );

    expect(ctx.state.lastToolError?.toolName).toBe("edit");

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "tool-edit-2",
        args: {
          file: "/tmp/demo.txt",
          oldText: "beta",
          newText: "beta fixed",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "tool-edit-2",
        isError: false,
        result: { ok: true },
      } as never,
    );

    expect(ctx.state.lastToolError).toBeUndefined();
  });
});

describe("handleToolExecutionEnd exec approval prompts", () => {
  it("emits a deterministic approval payload and marks assistant output suppressed", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-approval",
        isError: false,
        result: {
          details: {
            status: "approval-pending",
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            expiresAtMs: 1_800_000_000_000,
            host: "gateway",
            command: "npm view diver name version description",
            cwd: "/tmp/work",
            warningText: "Warning: heredoc execution requires explicit approval in allowlist mode.",
          },
        },
      } as never,
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("```txt\n/approve 12345678 allow-once\n```"),
        channelData: {
          execApproval: {
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      }),
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("emits a deterministic unavailable payload when the initiating surface cannot approve", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-unavailable",
        isError: false,
        result: {
          details: {
            status: "approval-unavailable",
            reason: "initiating-platform-disabled",
            channelLabel: "Discord",
          },
        },
      } as never,
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("chat exec approvals are not enabled on Discord"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("/approve"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("Pending command:"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("Host:"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("CWD:"),
      }),
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("emits the shared approver-DM notice when another approval client received the request", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-unavailable-dm-redirect",
        isError: false,
        result: {
          details: {
            status: "approval-unavailable",
            reason: "initiating-platform-disabled",
            channelLabel: "Telegram",
            sentApproverDms: true,
          },
        },
      } as never,
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Approval required. I sent approval DMs to the approvers for this account.",
      }),
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("does not suppress assistant output when deterministic prompt delivery rejects", async () => {
    const { ctx } = createTestContext();
    ctx.params.onToolResult = vi.fn(async () => {
      throw new Error("delivery failed");
    });

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-approval-reject",
        isError: false,
        result: {
          details: {
            status: "approval-pending",
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            expiresAtMs: 1_800_000_000_000,
            host: "gateway",
            command: "npm view diver name version description",
            cwd: "/tmp/work",
          },
        },
      } as never,
    );

    expect(ctx.state.deterministicApprovalPromptSent).toBe(false);
  });
});

describe("messaging tool media URL tracking", () => {
  it("tracks media arg from messaging tool as pending", async () => {
    const { ctx } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m1",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, evt);

    expect(ctx.state.pendingMessagingMediaUrls.get("tool-m1")).toEqual(["file:///img.jpg"]);
  });

  it("commits pending media URL on tool success", async () => {
    const { ctx } = createTestContext();

    // Simulate start
    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m2",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, startEvt);

    // Simulate successful end
    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m2",
      isError: false,
      result: { ok: true },
    };

    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toContain("file:///img.jpg");
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-m2")).toBe(false);
  });

  it("commits mediaUrls from tool result payload", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m2b",
      args: { action: "send", to: "channel:123", content: "hi" },
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m2b",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"],
            }),
          },
        ],
      },
    };
    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toEqual([
      "file:///img-a.jpg",
      "file:///img-b.jpg",
    ]);
  });

  it("trims messagingToolSentMediaUrls to 200 on commit (FIFO)", async () => {
    const { ctx } = createTestContext();

    // Replace mock with a real trim that replicates production cap logic.
    const MAX = 200;
    ctx.trimMessagingToolSent = () => {
      if (ctx.state.messagingToolSentTexts.length > MAX) {
        const overflow = ctx.state.messagingToolSentTexts.length - MAX;
        ctx.state.messagingToolSentTexts.splice(0, overflow);
        ctx.state.messagingToolSentTextsNormalized.splice(0, overflow);
      }
      if (ctx.state.messagingToolSentTargets.length > MAX) {
        const overflow = ctx.state.messagingToolSentTargets.length - MAX;
        ctx.state.messagingToolSentTargets.splice(0, overflow);
      }
      if (ctx.state.messagingToolSentMediaUrls.length > MAX) {
        const overflow = ctx.state.messagingToolSentMediaUrls.length - MAX;
        ctx.state.messagingToolSentMediaUrls.splice(0, overflow);
      }
    };

    // Pre-fill with 200 URLs (url-0 .. url-199)
    for (let i = 0; i < 200; i++) {
      ctx.state.messagingToolSentMediaUrls.push(`file:///img-${i}.jpg`);
    }
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);

    // Commit one more via start → end
    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-cap",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img-new.jpg" },
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-cap",
      isError: false,
      result: { ok: true },
    };
    await handleToolExecutionEnd(ctx, endEvt);

    // Should be capped at 200, oldest removed, newest appended.
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);
    expect(ctx.state.messagingToolSentMediaUrls[0]).toBe("file:///img-1.jpg");
    expect(ctx.state.messagingToolSentMediaUrls[199]).toBe("file:///img-new.jpg");
    expect(ctx.state.messagingToolSentMediaUrls).not.toContain("file:///img-0.jpg");
  });

  it("discards pending media URL on tool error", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m3",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m3",
      isError: true,
      result: "Error: failed",
    };

    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(0);
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-m3")).toBe(false);
  });
});

describe("circuit breaker arg signature for messaging tools", () => {
  it("does not trip circuit when successive failures target different recipients", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Three failures, each to a different recipient — should NOT trip the breaker
    await runTool(
      ctx,
      "message",
      { action: "send", to: "channel:111", content: "hello" },
      true,
      "m1",
    );
    await runTool(
      ctx,
      "message",
      { action: "send", to: "channel:222", content: "hello" },
      true,
      "m2",
    );
    await runTool(
      ctx,
      "message",
      { action: "send", to: "channel:333", content: "hello" },
      true,
      "m3",
    );

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when successive failures target the same recipient", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(
      ctx,
      "message",
      { action: "send", to: "channel:999", content: "hello" },
      true,
      "m1",
    );
    await runTool(
      ctx,
      "message",
      { action: "send", to: "channel:999", content: "hello" },
      true,
      "m2",
    );
    await runTool(
      ctx,
      "message",
      { action: "send", to: "channel:999", content: "hello" },
      true,
      "m3",
    );

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for file_path alias", () => {
  it("does not trip circuit when read failures target different file_path values", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "read", { file_path: "/tmp/a.txt" }, true, "r1");
    await runTool(ctx, "read", { file_path: "/tmp/b.txt" }, true, "r2");
    await runTool(ctx, "read", { file_path: "/tmp/c.txt" }, true, "r3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when read failures repeatedly target the same file_path", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "read", { file_path: "/tmp/same.txt" }, true, "r1");
    await runTool(ctx, "read", { file_path: "/tmp/same.txt" }, true, "r2");
    await runTool(ctx, "read", { file_path: "/tmp/same.txt" }, true, "r3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for sessionId and jobId selectors", () => {
  it("does not trip circuit when cron failures target different jobIds", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "cron", { action: "remove", jobId: "job-1" }, true, "c1");
    await runTool(ctx, "cron", { action: "remove", jobId: "job-2" }, true, "c2");
    await runTool(ctx, "cron", { action: "remove", jobId: "job-3" }, true, "c3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when cron failures repeatedly target the same jobId", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "cron", { action: "remove", jobId: "job-x" }, true, "c1");
    await runTool(ctx, "cron", { action: "remove", jobId: "job-x" }, true, "c2");
    await runTool(ctx, "cron", { action: "remove", jobId: "job-x" }, true, "c3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for browser targetId selector", () => {
  it("does not trip circuit when focus failures target different tab ids", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "browser", { action: "focus", targetId: "tab-1" }, true, "f1");
    await runTool(ctx, "browser", { action: "focus", targetId: "tab-2" }, true, "f2");
    await runTool(ctx, "browser", { action: "focus", targetId: "tab-3" }, true, "f3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when focus failures repeatedly target the same tab id", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "browser", { action: "focus", targetId: "tab-x" }, true, "f1");
    await runTool(ctx, "browser", { action: "focus", targetId: "tab-x" }, true, "f2");
    await runTool(ctx, "browser", { action: "focus", targetId: "tab-x" }, true, "f3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for nodes tool selectors", () => {
  it("does not trip circuit when failures target different nodes", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "nodes", { action: "status", node: "node-a" }, true, "n1");
    await runTool(ctx, "nodes", { action: "status", node: "node-b" }, true, "n2");
    await runTool(ctx, "nodes", { action: "status", node: "node-c" }, true, "n3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when failures repeatedly target the same node", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "nodes", { action: "status", node: "node-x" }, true, "n1");
    await runTool(ctx, "nodes", { action: "status", node: "node-x" }, true, "n2");
    await runTool(ctx, "nodes", { action: "status", node: "node-x" }, true, "n3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for file alias", () => {
  it("does not trip circuit when edit failures target different file values", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(
      ctx,
      "edit",
      { file: "/tmp/a.txt", old_string: "foo", new_string: "bar" },
      true,
      "e1",
    );
    await runTool(
      ctx,
      "edit",
      { file: "/tmp/b.txt", old_string: "foo", new_string: "bar" },
      true,
      "e2",
    );
    await runTool(
      ctx,
      "edit",
      { file: "/tmp/c.txt", old_string: "foo", new_string: "bar" },
      true,
      "e3",
    );

    expect(onError).not.toHaveBeenCalled();
  });
});

describe("circuit breaker arg signature for action-based tools with url/path args", () => {
  it("does not trip circuit when browser URLs share a long common prefix but differ at the end", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    const base = "https://example.com/" + "x".repeat(190);
    const urlA = base + "A";
    const urlB = base + "B";
    const urlC = base + "C";
    expect(urlA.slice(0, 200)).toBe(urlB.slice(0, 200)); // confirm shared prefix

    // target="current" is a constant window selector; url is the differentiator
    await runTool(
      ctx,
      "browser",
      { action: "open", target: "current", url: urlA },
      true,
      "b-long-1",
    );
    await runTool(
      ctx,
      "browser",
      { action: "open", target: "current", url: urlB },
      true,
      "b-long-2",
    );
    await runTool(
      ctx,
      "browser",
      { action: "open", target: "current", url: urlC },
      true,
      "b-long-3",
    );

    expect(onError).not.toHaveBeenCalled();
  });

  it("does not trip circuit when action-based calls have different URLs", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(
      ctx,
      "browser",
      { action: "open", target: "current", url: "https://example.com/a" },
      true,
      "b1",
    );
    await runTool(
      ctx,
      "browser",
      { action: "open", target: "current", url: "https://example.com/b" },
      true,
      "b2",
    );
    await runTool(
      ctx,
      "browser",
      { action: "open", target: "current", url: "https://example.com/c" },
      true,
      "b3",
    );

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when action-based calls repeatedly use the same URL", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(
      ctx,
      "browser",
      { action: "open", target: "current", url: "https://example.com/same" },
      true,
      "b1",
    );
    await runTool(
      ctx,
      "browser",
      { action: "open", target: "current", url: "https://example.com/same" },
      true,
      "b2",
    );
    await runTool(
      ctx,
      "browser",
      { action: "open", target: "current", url: "https://example.com/same" },
      true,
      "b3",
    );

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for sessions_send label routing", () => {
  it("does not trip circuit when failures target different session labels", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "sessions_send", { label: "agent-a", message: "hello" }, true, "s1");
    await runTool(ctx, "sessions_send", { label: "agent-b", message: "hello" }, true, "s2");
    await runTool(ctx, "sessions_send", { label: "agent-c", message: "hello" }, true, "s3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when failures repeatedly target the same session label", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "sessions_send", { label: "agent-x", message: "hello" }, true, "s1");
    await runTool(ctx, "sessions_send", { label: "agent-x", message: "hello" }, true, "s2");
    await runTool(ctx, "sessions_send", { label: "agent-x", message: "hello" }, true, "s3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker probe-reset prevention", () => {
  async function runExec(ctx: ToolHandlerContext, command: string, isError: boolean, id: string) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: id,
      args: { command },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: id,
      isError,
      result: isError
        ? { type: "text", text: "Error: permission denied" }
        : { type: "text", text: "ok" },
    });
  }

  it("does not reset circuit after probe command when already tripped", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Trip the circuit with 3 failures of the same command
    await runExec(ctx, "ls /restricted", true, "t1");
    await runExec(ctx, "ls /restricted", true, "t2");
    await runExec(ctx, "ls /restricted", true, "t3");
    expect(onError).toHaveBeenCalledTimes(1);

    // Model probes with a trivial echo command — should NOT reset circuit
    await runExec(ctx, "echo test", false, "t4");
    expect(ctx.state.consecutiveToolErrors).not.toBeNull();
    expect(ctx.state.consecutiveToolErrors?.tripped).toBe(true);

    // Original failing command recurs — should re-fire steer
    await runExec(ctx, "ls /restricted", true, "t5");
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("does not re-fire steer on plain consecutive failures after threshold (no probe)", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Trip at count 3
    await runExec(ctx, "ls /restricted", true, "t1");
    await runExec(ctx, "ls /restricted", true, "t2");
    await runExec(ctx, "ls /restricted", true, "t3");
    expect(onError).toHaveBeenCalledTimes(1);

    // Further failures with no probe in between — must NOT re-fire
    await runExec(ctx, "ls /restricted", true, "t4");
    await runExec(ctx, "ls /restricted", true, "t5");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not trip circuit when long commands share a common prefix but differ at the end", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Build two commands that share the first 100 chars but differ afterward.
    const prefix = 'node -e \'require("fs").writeFileSync("/tmp/out.txt", ' + "x".repeat(50);
    const cmdA = prefix + "A'.repeat(1))'\n";
    const cmdB = prefix + "B'.repeat(1))'\n";
    expect(cmdA.slice(0, 100)).toBe(cmdB.slice(0, 100)); // confirm shared prefix
    expect(cmdA).not.toBe(cmdB);

    // Three failures alternating between the two long commands — should NOT trip breaker
    await runExec(ctx, cmdA, true, "t1");
    await runExec(ctx, cmdB, true, "t2");
    await runExec(ctx, cmdA, true, "t3");
    expect(onError).not.toHaveBeenCalled();
  });

  it("resets circuit when exact same pipe-containing command succeeds after trip", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Trip with a command that contains "|"
    await runExec(ctx, "cat /etc/hosts | grep foo", true, "t1");
    await runExec(ctx, "cat /etc/hosts | grep foo", true, "t2");
    await runExec(ctx, "cat /etc/hosts | grep foo", true, "t3");
    expect(onError).toHaveBeenCalledTimes(1);

    // Exact same command now succeeds — problem resolved, circuit should reset
    await runExec(ctx, "cat /etc/hosts | grep foo", false, "t4");
    expect(ctx.state.consecutiveToolErrors).toBeNull();
  });

  it("resets circuit when a different tool succeeds after trip", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runExec(ctx, "ls /restricted", true, "t1");
    await runExec(ctx, "ls /restricted", true, "t2");
    await runExec(ctx, "ls /restricted", true, "t3");
    expect(onError).toHaveBeenCalledTimes(1);

    // A different tool succeeds — agent found a real alternative
    await runTool(ctx, "write", { path: "/tmp/out.txt", content: "hello" }, false, "t4");
    expect(ctx.state.consecutiveToolErrors).toBeNull();
  });

  it("treats exec cmd alias identically to command field", async () => {
    // buildCircuitBreakerArgSig reads record.command ?? record.cmd for exec;
    // both aliases must produce the same signature so identical repeated failures trip the breaker.
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "exec", { command: "ls /restricted" }, true, "t1");
    await runTool(ctx, "exec", { cmd: "ls /restricted" }, true, "t2");
    await runTool(ctx, "exec", { command: "ls /restricted" }, true, "t3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for fallback url key (e.g. web_fetch)", () => {
  it("does not trip circuit when web_fetch URLs share a long common prefix but differ at the end", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Build URLs that share the first 100 chars but differ afterward
    const base = "https://example.com/search?q=" + "x".repeat(72);
    const urlA = base + "A";
    const urlB = base + "B";
    const urlC = base + "C";
    expect(urlA.slice(0, 100)).toBe(urlB.slice(0, 100)); // confirm shared prefix at 100

    await runTool(ctx, "web_fetch", { url: urlA }, true, "wf1");
    await runTool(ctx, "web_fetch", { url: urlB }, true, "wf2");
    await runTool(ctx, "web_fetch", { url: urlC }, true, "wf3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when web_fetch repeatedly fetches the same URL", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "web_fetch", { url: "https://example.com/api/data" }, true, "wf1");
    await runTool(ctx, "web_fetch", { url: "https://example.com/api/data" }, true, "wf2");
    await runTool(ctx, "web_fetch", { url: "https://example.com/api/data" }, true, "wf3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for action-based content fields (canvas eval / image-generate)", () => {
  it("does not trip circuit when canvas eval failures use different scripts", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "canvas", { action: "eval", javaScript: "document.title" }, true, "c1");
    await runTool(
      ctx,
      "canvas",
      { action: "eval", javaScript: "window.location.href" },
      true,
      "c2",
    );
    await runTool(
      ctx,
      "canvas",
      { action: "eval", javaScript: "document.body.innerText" },
      true,
      "c3",
    );

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when canvas eval repeatedly runs the same script", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    const js = "document.querySelector('#btn').click()";
    await runTool(ctx, "canvas", { action: "eval", javaScript: js }, true, "c1");
    await runTool(ctx, "canvas", { action: "eval", javaScript: js }, true, "c2");
    await runTool(ctx, "canvas", { action: "eval", javaScript: js }, true, "c3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for browser act nested request fields", () => {
  async function runBrowserAct(
    ctx: ToolHandlerContext,
    request: Record<string, unknown>,
    isError: boolean,
    id: string,
  ) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "browser",
      toolCallId: id,
      args: { action: "act", request },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "browser",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: act failed" } : { ok: true },
    });
  }

  it("does not trip circuit when act failures target different elements", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runBrowserAct(ctx, { kind: "click", targetId: "btn-submit" }, true, "a1");
    await runBrowserAct(ctx, { kind: "click", targetId: "btn-cancel" }, true, "a2");
    await runBrowserAct(ctx, { kind: "click", targetId: "btn-back" }, true, "a3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when act failures repeatedly target the same element", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runBrowserAct(ctx, { kind: "click", targetId: "btn-submit" }, true, "a1");
    await runBrowserAct(ctx, { kind: "click", targetId: "btn-submit" }, true, "a2");
    await runBrowserAct(ctx, { kind: "click", targetId: "btn-submit" }, true, "a3");

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not trip circuit when act failures use different kinds", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runBrowserAct(ctx, { kind: "click", targetId: "btn-1" }, true, "a1");
    await runBrowserAct(ctx, { kind: "type", targetId: "btn-1", text: "hello" }, true, "a2");
    await runBrowserAct(ctx, { kind: "hover", targetId: "btn-1" }, true, "a3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("does not trip circuit when act calls share a constant top-level target but differ in request", async () => {
    // browser passes target="host" (constant window selector) alongside a request payload;
    // the request fields are the real differentiators and must win over the constant target.
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    async function runActWithTarget(
      request: Record<string, unknown>,
      isError: boolean,
      id: string,
    ) {
      await handleToolExecutionStart(ctx, {
        type: "tool_execution_start",
        toolName: "browser",
        toolCallId: id,
        args: { action: "act", target: "host", request },
      });
      await handleToolExecutionEnd(ctx, {
        type: "tool_execution_end",
        toolName: "browser",
        toolCallId: id,
        isError,
        result: isError ? { type: "text", text: "Error: act failed" } : { ok: true },
      });
    }

    await runActWithTarget({ kind: "click", targetId: "btn-a" }, true, "t1");
    await runActWithTarget({ kind: "click", targetId: "btn-b" }, true, "t2");
    await runActWithTarget({ kind: "click", targetId: "btn-c" }, true, "t3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("does not trip circuit when type calls share targetId but have different text", async () => {
    // Same targetId but different text — the full request payload must be used, not just
    // the first matching field.
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runBrowserAct(ctx, { kind: "type", targetId: "input-search", text: "hello" }, true, "a1");
    await runBrowserAct(ctx, { kind: "type", targetId: "input-search", text: "world" }, true, "a2");
    await runBrowserAct(ctx, { kind: "type", targetId: "input-search", text: "foo" }, true, "a3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when type calls repeatedly use the same targetId and text", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runBrowserAct(ctx, { kind: "type", targetId: "input-search", text: "hello" }, true, "a1");
    await runBrowserAct(ctx, { kind: "type", targetId: "input-search", text: "hello" }, true, "a2");
    await runBrowserAct(ctx, { kind: "type", targetId: "input-search", text: "hello" }, true, "a3");

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not trip circuit when act failures use the same request but different top-level target", async () => {
    // top-level target selects the browser backend (host vs sandbox); calls that differ only
    // in target must produce distinct signatures so they don't falsely trip the breaker.
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    const request = { kind: "click", targetId: "btn-submit" };

    async function runActTarget(target: string, isError: boolean, id: string) {
      await handleToolExecutionStart(ctx, {
        type: "tool_execution_start",
        toolName: "browser",
        toolCallId: id,
        args: { action: "act", target, request },
      });
      await handleToolExecutionEnd(ctx, {
        type: "tool_execution_end",
        toolName: "browser",
        toolCallId: id,
        isError,
        result: isError ? { type: "text", text: "Error: act failed" } : { ok: true },
      });
    }

    await runActTarget("host", true, "t1");
    await runActTarget("sandbox", true, "t2");
    await runActTarget("host", true, "t3");

    expect(onError).not.toHaveBeenCalled();
  });
});

describe("circuit breaker arg signature for cron wake text field", () => {
  it("does not trip circuit when wake failures use different text values", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "cron", { action: "wake", text: "good morning" }, true, "w1");
    await runTool(ctx, "cron", { action: "wake", text: "check email" }, true, "w2");
    await runTool(ctx, "cron", { action: "wake", text: "run daily report" }, true, "w3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when wake failures repeatedly use the same text", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "cron", { action: "wake", text: "good morning" }, true, "w1");
    await runTool(ctx, "cron", { action: "wake", text: "good morning" }, true, "w2");
    await runTool(ctx, "cron", { action: "wake", text: "good morning" }, true, "w3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker generic JSON fallback for non-string action args", () => {
  it("does not trip circuit when broadcast failures use different target arrays", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "message", { action: "broadcast", targets: ["alice", "bob"] }, true, "b1");
    await runTool(ctx, "message", { action: "broadcast", targets: ["carol", "dave"] }, true, "b2");
    await runTool(ctx, "message", { action: "broadcast", targets: ["eve", "frank"] }, true, "b3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when broadcast failures repeatedly use the same target array", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "message", { action: "broadcast", targets: ["alice", "bob"] }, true, "b1");
    await runTool(ctx, "message", { action: "broadcast", targets: ["alice", "bob"] }, true, "b2");
    await runTool(ctx, "message", { action: "broadcast", targets: ["alice", "bob"] }, true, "b3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature key-order stability", () => {
  it("treats the same action args in different key order as identical", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Same logical call, keys in different insertion order
    await runTool(ctx, "gateway", { action: "config.set", key: "foo", value: "bar" }, true, "g1");
    await runTool(ctx, "gateway", { value: "bar", action: "config.set", key: "foo" }, true, "g2");
    await runTool(ctx, "gateway", { key: "foo", value: "bar", action: "config.set" }, true, "g3");

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("treats same non-action args in different key order as identical", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runTool(ctx, "write", { path: "/tmp/a.txt", content: "hello" }, true, "w1");
    await runTool(ctx, "write", { content: "hello", path: "/tmp/a.txt" }, true, "w2");
    await runTool(ctx, "write", { path: "/tmp/a.txt", content: "hello" }, true, "w3");

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("treats same nested args in different key order as identical", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // cron add with job object keys in different order
    const job1 = { cron: "0 9 * * *", name: "morning", action: "add" };
    const job2 = { name: "morning", action: "add", cron: "0 9 * * *" };
    const job3 = { action: "add", cron: "0 9 * * *", name: "morning" };

    await runTool(ctx, "cron", { action: "add", job: job1 }, true, "c1");
    await runTool(ctx, "cron", { action: "add", job: job2 }, true, "c2");
    await runTool(ctx, "cron", { action: "add", job: job3 }, true, "c3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
