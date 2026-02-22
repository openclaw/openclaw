import { describe, expect, it, vi } from "vitest";
import {
  handleMessageEnd,
  resolveSilentReplyFallbackText,
} from "./pi-embedded-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

function buildMinimalCtx(
  overrides: {
    assistantTexts?: string[];
    assistantTextBaseline?: number;
    onBlockReply?: (...args: unknown[]) => void;
  } = {},
): EmbeddedPiSubscribeContext {
  const assistantTexts = overrides.assistantTexts ?? [];
  const state = {
    assistantTexts,
    assistantTextBaseline: overrides.assistantTextBaseline ?? 0,
    includeReasoning: false,
    streamReasoning: false,
    blockReplyBreak: "message_end" as const,
    deltaBuffer: "",
    blockBuffer: "",
    blockState: { thinking: false, final: false, inlineCode: { open: false, depth: 0 } },
    partialBlockState: { thinking: false, final: false, inlineCode: { open: false, depth: 0 } },
    emittedAssistantUpdate: false,
    assistantMessageIndex: 0,
    lastAssistantTextMessageIndex: -1,
    suppressBlockChunks: false,
    compactionInFlight: false,
    pendingCompactionRetry: 0,
    compactionRetryPromise: null,
    unsubscribed: false,
    messagingToolSentTexts: [] as string[],
    messagingToolSentTextsNormalized: [] as string[],
    messagingToolSentTargets: [],
    messagingToolSentMediaUrls: [] as string[],
    pendingMessagingTexts: new Map<string, string>(),
    pendingMessagingTargets: new Map(),
    successfulCronAdds: 0,
    pendingMessagingMediaUrls: new Map<string, string[]>(),
    reasoningMode: "off" as const,
    shouldEmitPartialReplies: false,
    reasoningStreamOpen: false,
    toolMetas: [],
    toolMetaById: new Map(),
    toolSummaryById: new Map(),
  } as unknown as EmbeddedPiSubscribeContext["state"];

  return {
    state,
    params: {
      runId: "test-run",
      onBlockReply: overrides.onBlockReply,
      session: { id: "test-session" },
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    blockChunker: null,
    noteLastAssistant: vi.fn(),
    recordAssistantUsage: vi.fn(),
    stripBlockTags: (_text: string) => _text,
    emitBlockChunk: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    consumeReplyDirectives: () => null,
    consumePartialReplyDirectives: () => null,
    resetAssistantMessageState: vi.fn(),
    finalizeAssistantTexts: vi.fn(
      (_args: { text: string; addedDuringMessage: boolean; chunkerHasBuffered: boolean }) => {
        // Simplified: just update baseline
        state.assistantTextBaseline = assistantTexts.length;
      },
    ),
    trimMessagingToolSent: vi.fn(),
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    incrementCompactionCount: vi.fn(),
    getUsageTotals: () => undefined,
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("handleMessageEnd – narration suppression", () => {
  it("removes narration text from assistantTexts when message has tool calls", () => {
    const ctx = buildMinimalCtx({
      assistantTexts: ["Let me search for that information."],
      assistantTextBaseline: 0,
    });

    handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search for that information." },
          { type: "toolCall", id: "tc1", name: "web_search", arguments: { query: "test" } },
        ],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    } as unknown as Parameters<typeof handleMessageEnd>[1]);

    // The narration text should have been spliced out
    expect(ctx.state.assistantTexts).toHaveLength(0);
    // finalizeAssistantTexts should be called with empty text
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "", addedDuringMessage: false }),
    );
  });

  it("preserves assistant text when message has no tool calls", () => {
    const ctx = buildMinimalCtx({
      assistantTexts: ["Here is your answer."],
      assistantTextBaseline: 0,
    });

    handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is your answer." }],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    } as unknown as Parameters<typeof handleMessageEnd>[1]);

    // Text should be preserved
    expect(ctx.state.assistantTexts).toHaveLength(1);
    expect(ctx.state.assistantTexts[0]).toBe("Here is your answer.");
  });

  it("only removes text added during current message, not prior text", () => {
    const ctx = buildMinimalCtx({
      assistantTexts: ["Previous answer.", "Let me check that."],
      assistantTextBaseline: 1, // "Previous answer." was before this message
    });

    handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check that." },
          { type: "toolCall", id: "tc2", name: "exec", arguments: { command: "ls" } },
        ],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    } as unknown as Parameters<typeof handleMessageEnd>[1]);

    // Only "Let me check that." should be removed, "Previous answer." stays
    expect(ctx.state.assistantTexts).toEqual(["Previous answer."]);
  });
  it("does not emit narration via onBlockReply when message has tool calls", () => {
    const onBlockReply = vi.fn();
    const ctx = buildMinimalCtx({
      assistantTexts: ["Let me look that up."],
      assistantTextBaseline: 0,
      onBlockReply,
    });
    // Set blockReplyBreak to message_end (standard path for Telegram/Discord)
    ctx.state.blockReplyBreak = "message_end";

    handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look that up." },
          { type: "toolCall", id: "tc3", name: "web_search", arguments: { query: "test" } },
        ],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    } as unknown as Parameters<typeof handleMessageEnd>[1]);

    // onBlockReply must NOT be called with narration text
    expect(onBlockReply).not.toHaveBeenCalled();
  });
});

describe("resolveSilentReplyFallbackText", () => {
  it("replaces NO_REPLY with latest messaging tool text when available", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: ["first", "final delivered text"],
      }),
    ).toBe("final delivered text");
  });

  it("keeps original text when response is not NO_REPLY", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "normal assistant reply",
        messagingToolSentTexts: ["final delivered text"],
      }),
    ).toBe("normal assistant reply");
  });

  it("keeps NO_REPLY when there is no messaging tool text to mirror", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [],
      }),
    ).toBe("NO_REPLY");
  });
});
