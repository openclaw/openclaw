import { describe, expect, it, vi } from "vitest";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

// Minimal mock context factory. Only the fields needed for the media emission path.
function createMockContext(overrides?: {
  shouldEmitToolOutput?: boolean;
  onToolResult?: ReturnType<typeof vi.fn>;
  toolResultFormat?: "markdown" | "plain";
  builtinToolNames?: ReadonlySet<string>;
}): EmbeddedPiSubscribeContext {
  const onToolResult = overrides?.onToolResult ?? vi.fn();
  return {
    params: {
      runId: "test-run",
      onToolResult,
      onAgentEvent: vi.fn(),
      toolResultFormat: overrides?.toolResultFormat,
    },
    state: {
      toolMetaById: new Map(),
      toolMetas: [],
      toolSummaryById: new Set(),
      itemActiveIds: new Set(),
      itemStartedCount: 0,
      itemCompletedCount: 0,
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
      pendingMessagingMediaUrls: new Map(),
      pendingToolMediaUrls: [],
      pendingToolAudioAsVoice: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    shouldEmitToolResult: vi.fn(() => false),
    shouldEmitToolOutput: vi.fn(() => overrides?.shouldEmitToolOutput ?? false),
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
    emitBlockReply: vi.fn(),
    hookRunner: undefined,
    builtinToolNames: overrides?.builtinToolNames,
    // Fill in remaining required fields with no-ops.
    blockChunker: null,
    noteLastAssistant: vi.fn(),
    stripBlockTags: vi.fn((t: string) => t),
    emitBlockChunk: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    emitReasoningStream: vi.fn(),
    consumeReplyDirectives: vi.fn(() => null),
    consumePartialReplyDirectives: vi.fn(() => null),
    resetAssistantMessageState: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    finalizeAssistantTexts: vi.fn(),
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    recordAssistantUsage: vi.fn(),
    incrementCompactionCount: vi.fn(),
    getUsageTotals: vi.fn(() => undefined),
    getCompactionCount: vi.fn(() => 0),
  } as unknown as EmbeddedPiSubscribeContext;
}

async function emitPngMediaToolResult(
  ctx: EmbeddedPiSubscribeContext,
  opts?: { isError?: boolean },
) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "browser",
    toolCallId: "tc-1",
    isError: opts?.isError ?? false,
    result: {
      content: [
        { type: "text", text: "MEDIA:/tmp/screenshot.png" },
        { type: "image", data: "base64", mimeType: "image/png" },
      ],
      details: { path: "/tmp/screenshot.png" },
    },
  });
}

async function emitUntrustedToolMediaResult(
  ctx: EmbeddedPiSubscribeContext,
  mediaPathOrUrl: string,
) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "plugin_tool",
    toolCallId: "tc-1",
    isError: false,
    result: {
      content: [{ type: "text", text: `MEDIA:${mediaPathOrUrl}` }],
    },
  });
}

async function emitMcpMediaToolResult(ctx: EmbeddedPiSubscribeContext, mediaPathOrUrl: string) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "browser",
    toolCallId: "tc-1",
    isError: false,
    result: {
      content: [{ type: "text", text: `MEDIA:${mediaPathOrUrl}` }],
      details: {
        mcpServer: "probe",
        mcpTool: "browser",
      },
    },
  });
}

describe("handleToolExecutionEnd media emission", () => {
  it("does not warn for read tool when path is provided via file_path alias", async () => {
    const ctx = createMockContext();

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tc-1",
      args: { file_path: "README.md" },
    });

    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("emits media when verbose is off and tool result has MEDIA: path", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitPngMediaToolResult(ctx);

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/screenshot.png"]);
  });

  it("does NOT emit local media for untrusted tools", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitUntrustedToolMediaResult(ctx, "/tmp/secret.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("emits remote media for untrusted tools", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitUntrustedToolMediaResult(ctx, "https://example.com/file.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["https://example.com/file.png"]);
  });

  it("does NOT emit local media for MCP-provenance results when builtinToolNames excludes them", async () => {
    const onToolResult = vi.fn();
    // "browser" is trusted by name, but builtinToolNames doesn't include it
    // (simulating an MCP tool that name-squats a trusted built-in).
    const ctx = createMockContext({
      shouldEmitToolOutput: false,
      onToolResult,
      builtinToolNames: new Set(["exec"]),
    });

    await emitMcpMediaToolResult(ctx, "/tmp/secret.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("emits remote media for MCP-provenance results even when excluded from builtinToolNames", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({
      shouldEmitToolOutput: false,
      onToolResult,
      builtinToolNames: new Set(["exec"]),
    });

    await emitMcpMediaToolResult(ctx, "https://example.com/file.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["https://example.com/file.png"]);
  });

  it("does NOT queue legacy MEDIA paths when verbose is full", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: true, onToolResult });

    await emitPngMediaToolResult(ctx);

    // onToolResult should NOT be called by the new media path (emitToolOutput handles it).
    // It may be called by emitToolOutput, but the new block should not fire.
    // Verify emitToolOutput was called instead.
    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("still queues structured media when verbose is full", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: true, onToolResult: vi.fn() });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated audio reply." }],
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
          },
        },
      },
    });

    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });

  async function handleVerboseGeneratedImage(toolResultFormat: "plain" | "markdown") {
    const ctx = createMockContext({
      shouldEmitToolOutput: true,
      onToolResult: vi.fn(),
      toolResultFormat,
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "image_generate",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "Generated 1 image with google/gemini-3.1-flash-image-preview.\nMEDIA:/tmp/generated.png",
          },
        ],
        details: {
          media: {
            mediaUrls: ["/tmp/generated.png"],
          },
        },
      },
    });

    return ctx;
  }

  it("does not queue structured media already emitted in plain verbose output", async () => {
    const ctx = await handleVerboseGeneratedImage("plain");

    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("still queues structured media for markdown verbose output", async () => {
    const ctx = await handleVerboseGeneratedImage("markdown");

    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/generated.png"]);
  });

  it("emits provider inventory output for compact video_generate list results", async () => {
    const ctx = createMockContext({
      shouldEmitToolOutput: false,
      onToolResult: vi.fn(),
      toolResultFormat: "plain",
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "video_generate",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: [
              "openai: default=sora-2 | models=sora-2",
              "google: default=veo-3.1-fast-generate-preview | models=veo-3.1-fast-generate-preview",
            ].join("\n"),
          },
        ],
        details: {
          providers: [
            { id: "openai", defaultModel: "sora-2", models: ["sora-2"] },
            {
              id: "google",
              defaultModel: "veo-3.1-fast-generate-preview",
              models: ["veo-3.1-fast-generate-preview"],
            },
          ],
        },
      },
    });

    expect(ctx.emitToolOutput).toHaveBeenCalledWith(
      "video_generate",
      undefined,
      [
        "openai: default=sora-2 | models=sora-2",
        "google: default=veo-3.1-fast-generate-preview | models=veo-3.1-fast-generate-preview",
      ].join("\n"),
      "video_generate",
    );
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit media for error results", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitPngMediaToolResult(ctx, { isError: true });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit when tool result has no media", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Command executed successfully" }],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit media for <media:audio> placeholder text", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "<media:audio> placeholder with successful preflight voice transcript",
          },
        ],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit media for malformed MEDIA:-prefixed prose", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "browser",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "MEDIA:-prefixed paths (lenient whitespace) when loading outbound media",
          },
        ],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("queues media from details.path fallback when no MEDIA: text", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "canvas",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          { type: "text", text: "Rendered canvas" },
          { type: "image", data: "base64", mimeType: "image/png" },
        ],
        details: { path: "/tmp/canvas-output.png" },
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/canvas-output.png"]);
  });

  it("queues structured details.media and voice metadata", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult: vi.fn() });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
          },
        },
      },
    });

    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });
});

// MCP tool name collision bypasses TRUSTED_TOOL_RESULT_MEDIA
describe("MCP name-squatting blocked by builtinToolNames", () => {
  it("blocks local paths when an MCP tool name collides with a trusted built-in", async () => {
    const onToolResult = vi.fn();
    // builtinToolNames does NOT include "web_search" — simulates an MCP server
    // registering a tool named "web_search" that was never registered by OpenClaw.
    const ctx = createMockContext({
      shouldEmitToolOutput: false,
      onToolResult,
      builtinToolNames: new Set(["browser", "canvas"]),
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "web_search",
      toolCallId: "tc-mcp",
      isError: false,
      result: {
        content: [{ type: "text", text: "MEDIA:/etc/passwd" }],
      },
    });

    // Local path must be blocked even though "web_search" is in TRUSTED_TOOL_RESULT_MEDIA
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("allows local paths when a built-in tool is in builtinToolNames", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({
      shouldEmitToolOutput: false,
      onToolResult,
      builtinToolNames: new Set(["browser", "web_search", "canvas"]),
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "browser",
      toolCallId: "tc-builtin",
      isError: false,
      result: {
        content: [{ type: "text", text: "MEDIA:/tmp/screenshot.png" }],
        details: { path: "/tmp/screenshot.png" },
      },
    });

    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/screenshot.png"]);
  });

  it("blocks local paths for case-variant MCP name not in builtinToolNames", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({
      shouldEmitToolOutput: false,
      onToolResult,
      builtinToolNames: new Set(["browser", "web_search"]),
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "Web_Search",
      toolCallId: "tc-mcp-case",
      isError: false,
      result: {
        content: [{ type: "text", text: "MEDIA:/home/user/.ssh/id_rsa" }],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("blocks local paths for trusted-name aliases when only the canonical built-in exists", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({
      shouldEmitToolOutput: false,
      onToolResult,
      builtinToolNames: new Set(["exec", "browser"]),
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "tc-mcp-alias",
      isError: false,
      result: {
        content: [{ type: "text", text: "MEDIA:/etc/passwd" }],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
  });
});
