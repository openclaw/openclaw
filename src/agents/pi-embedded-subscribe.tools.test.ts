import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { handleToolExecutionStart } from "./pi-embedded-subscribe.handlers.tools.js";
import { extractMessagingToolSend } from "./pi-embedded-subscribe.tools.js";

vi.mock("../infra/agent-events.js", () => ({ emitAgentEvent: vi.fn() }));

function makeMinimalCtx(): EmbeddedPiSubscribeContext {
  return {
    params: { runId: "test-run" },
    state: {
      toolMetaById: new Map(),
      toolSummaryById: new Set(),
      toolMetas: [],
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    flushBlockReplyBuffer: vi.fn(),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("handleToolExecutionStart – read tool path guard", () => {
  it("does not warn when path is provided", async () => {
    const ctx = makeMinimalCtx();
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "c1",
      args: { path: "/tmp/file.txt" },
    });
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("does not warn when file_path alias is provided", async () => {
    const ctx = makeMinimalCtx();
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "c2",
      args: { file_path: "/tmp/file.txt" },
    });
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("warns when no path params are provided", async () => {
    const ctx = makeMinimalCtx();
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "c3",
      args: {},
    });
    expect(ctx.log.warn).toHaveBeenCalledOnce();
  });

  it("warns when path is an empty string", async () => {
    const ctx = makeMinimalCtx();
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "c4",
      args: { path: "  " },
    });
    expect(ctx.log.warn).toHaveBeenCalledOnce();
  });
});

describe("extractMessagingToolSend", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
  });

  it("uses channel as provider for message tool", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      to: "123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:123");
  });

  it("prefers provider when both provider and channel are set", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "slack",
      channel: "telegram",
      to: "channel:C1",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("slack");
    expect(result?.to).toBe("channel:c1");
  });
});
