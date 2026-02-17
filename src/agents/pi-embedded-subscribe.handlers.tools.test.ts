import { describe, expect, it, vi } from "vitest";
import { handleToolExecutionStart } from "./pi-embedded-subscribe.handlers.tools.js";

function createTestContext() {
  const onBlockReplyFlush = vi.fn();
  const warn = vi.fn();
  const ctx = {
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
      toolMetaById: new Map<string, string | undefined>(),
      toolSummaryById: new Set<string>(),
      pendingMessagingTargets: new Map<string, unknown>(),
      pendingMessagingTexts: new Map<string, string>(),
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentTargets: [],
    },
    shouldEmitToolResult: () => false,
    emitToolSummary: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  } as const;

  return { ctx, warn, onBlockReplyFlush };
}

describe("handleToolExecutionStart read path checks", () => {
  it("does not warn when read tool uses file_path alias", async () => {
    const { ctx, warn, onBlockReplyFlush } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "tool-1",
        args: { file_path: "/tmp/example.txt" },
      } as never,
    );

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when read tool has neither path nor file_path", async () => {
    const { ctx, warn } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "tool-2",
        args: {},
      } as never,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("read tool called without path");
  });
});
