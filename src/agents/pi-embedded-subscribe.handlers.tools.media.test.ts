import { describe, expect, it, vi } from "vitest";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

// Minimal mock context factory. Only the fields needed for the media artifact path.
function createMockContext(overrides?: {
  shouldEmitToolOutput?: boolean;
  onToolResult?: ReturnType<typeof vi.fn>;
}): EmbeddedPiSubscribeContext {
  const onToolResult = overrides?.onToolResult ?? vi.fn();
  return {
    params: {
      runId: "test-run",
      onToolResult,
      onAgentEvent: vi.fn(),
    },
    state: {
      toolMetaById: new Map(),
      toolMetas: [],
      toolSummaryById: new Set(),
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
      pendingMessagingMediaUrls: new Map(),
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      deterministicApprovalPromptSent: false,
      pendingMediaArtifacts: [],
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    shouldEmitToolResult: vi.fn(() => false),
    shouldEmitToolOutput: vi.fn(() => overrides?.shouldEmitToolOutput ?? false),
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
    hookRunner: undefined,
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

async function emitToolWithMediaArtifact(ctx: EmbeddedPiSubscribeContext) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "image_generate",
    toolCallId: "tc-artifact",
    isError: false,
    result: {
      content: [{ type: "text", text: "Generated 1 image." }],
      details: {
        media: {
          mediaUrls: ["/tmp/generated.png"],
        },
      },
    },
  });
}

async function emitToolMediaResult(ctx: EmbeddedPiSubscribeContext, mediaPathOrUrl: string) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "browser",
    toolCallId: "tc-1",
    isError: false,
    result: {
      content: [{ type: "text", text: `MEDIA:${mediaPathOrUrl}` }],
    },
  });
}

describe("handleToolExecutionEnd media artifacts", () => {
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

  it("does not stash artifacts for MEDIA: text in tool output (no implicit parsing)", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false });

    await emitPngMediaToolResult(ctx);

    expect(ctx.state.pendingMediaArtifacts).toHaveLength(0);
  });

  it("stashes media artifact from details.media when verbose is off", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false });

    await emitToolWithMediaArtifact(ctx);

    expect(ctx.state.pendingMediaArtifacts).toEqual([
      {
        toolName: "image_generate",
        artifact: { mediaUrls: ["/tmp/generated.png"] },
      },
    ]);
  });

  it("stashes media artifact from details.media when verbose is full", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: true });

    await emitToolWithMediaArtifact(ctx);

    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingMediaArtifacts).toEqual([
      {
        toolName: "image_generate",
        artifact: { mediaUrls: ["/tmp/generated.png"] },
      },
    ]);
  });

  it("does not deliver media artifacts via onToolResult", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitToolWithMediaArtifact(ctx);

    // onToolResult should not be called with media — artifacts are stashed, not delivered
    const mediaCalls = onToolResult.mock.calls.filter(
      (call: unknown[]) =>
        call[0] &&
        typeof call[0] === "object" &&
        ("mediaUrls" in (call[0] as Record<string, unknown>) ||
          "mediaUrl" in (call[0] as Record<string, unknown>)),
    );
    expect(mediaCalls).toHaveLength(0);
  });

  it("does not stash artifacts for MEDIA: text from untrusted tools", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false });

    await emitToolMediaResult(ctx, "/tmp/secret.png");

    expect(ctx.state.pendingMediaArtifacts).toHaveLength(0);
  });

  it("drops local media artifact URLs from untrusted tools", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "third_party_plugin",
      toolCallId: "tc-untrusted",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated 1 file." }],
        details: {
          media: {
            mediaUrls: ["/tmp/secret.png"],
          },
        },
      },
    });

    // Local paths are filtered out for untrusted tools
    expect(ctx.state.pendingMediaArtifacts).toHaveLength(0);
  });

  it("allows remote URLs from untrusted tools", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "third_party_plugin",
      toolCallId: "tc-untrusted-remote",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated 1 image." }],
        details: {
          media: {
            mediaUrls: ["https://example.com/image.png"],
          },
        },
      },
    });

    expect(ctx.state.pendingMediaArtifacts).toEqual([
      {
        toolName: "third_party_plugin",
        artifact: { mediaUrls: ["https://example.com/image.png"] },
      },
    ]);
  });

  it("does NOT stash artifacts for error results", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false });

    await emitPngMediaToolResult(ctx, { isError: true });

    expect(ctx.state.pendingMediaArtifacts).toHaveLength(0);
  });

  it("does NOT stash artifacts when tool result has no media", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Command executed successfully" }],
      },
    });

    expect(ctx.state.pendingMediaArtifacts).toHaveLength(0);
  });

  it("does not stash artifacts for details.path fallback (no implicit extraction)", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false });

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

    expect(ctx.state.pendingMediaArtifacts).toHaveLength(0);
  });

  it("stashes audio artifact with audioAsVoice", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-tts",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated speech audio." }],
        details: {
          media: {
            mediaUrl: "/tmp/voice.opus",
            audioAsVoice: true,
          },
        },
      },
    });

    expect(ctx.state.pendingMediaArtifacts).toEqual([
      {
        toolName: "tts",
        artifact: { mediaUrl: "/tmp/voice.opus", audioAsVoice: true },
      },
    ]);
  });
});
