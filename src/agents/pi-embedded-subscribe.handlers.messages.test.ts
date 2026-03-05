import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { resolveSilentReplyFallbackText } from "./pi-embedded-subscribe.handlers.messages.js";
import { handleMessageStart } from "./pi-embedded-subscribe.handlers.messages.js";

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

describe("Cross-turn separator for block streaming (issue #35308)", () => {
  it("sets pendingCrossTurnSeparator when block streaming is active and deltaBuffer has content", () => {
    // Create a minimal context with the required state
    const state = {
      assistantTexts: [],
      toolMetas: [],
      toolMetaById: new Map(),
      toolSummaryById: new Set(),
      blockReplyBreak: "text_end" as const,
      reasoningMode: "off" as const,
      includeReasoning: false,
      shouldEmitPartialReplies: true,
      streamReasoning: false,
      deltaBuffer: "existing text content",
      blockBuffer: "",
      blockState: { thinking: false, final: false, inlineCode: {} },
      partialBlockState: { thinking: false, final: false, inlineCode: {} },
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      emittedAssistantUpdate: false,
      lastStreamedReasoning: undefined,
      lastBlockReplyText: undefined,
      reasoningStreamOpen: false,
      assistantMessageIndex: 0,
      lastAssistantTextMessageIndex: -1,
      lastAssistantTextNormalized: undefined,
      lastAssistantTextTrimmed: undefined,
      assistantTextBaseline: 0,
      suppressBlockChunks: false,
      lastReasoningSent: undefined,
      compactionInFlight: false,
      pendingCompactionRetry: 0,
      compactionRetryPromise: null,
      unsubscribed: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentTargets: [],
      messagingToolSentMediaUrls: [],
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
      successfulCronAdds: 0,
      pendingMessagingMediaUrls: new Map(),
      pendingCrossTurnSeparator: false,
    };

    const ctx = {
      params: {
        runId: "test-run",
        sessionId: { id: "test-session" },
        onAssistantMessageStart: undefined,
      },
      state,
      log: { debug: () => {}, warn: () => {} },
      blockChunking: { minChars: 100, maxChars: 1000, breakPreference: "paragraph" as const },
      blockChunker: {
        hasBuffered: () => false,
        append: () => {},
        reset: () => {},
        drain: () => {},
      },
      hookRunner: undefined,
      noteLastAssistant: () => {},
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      emitToolSummary: () => {},
      emitToolOutput: () => {},
      stripBlockTags: (text: string) => text,
      emitBlockChunk: () => {},
      flushBlockReplyBuffer: () => {},
      emitReasoningStream: () => {},
      consumeReplyDirectives: () => ({ text: "", mediaUrls: undefined }),
      consumePartialReplyDirectives: () => ({ text: "", mediaUrls: undefined }),
      resetAssistantMessageState: (nextBaseline: number) => {
        // Simulate the logic from resetAssistantMessageState
        const shouldInsertCrossTurnSeparator =
          ctx.blockChunking && ctx.state.deltaBuffer.length > 0;
        ctx.state.deltaBuffer = "";
        ctx.state.blockBuffer = "";
        ctx.blockChunker?.reset();
        ctx.state.assistantMessageIndex += 1;
        ctx.state.lastAssistantTextMessageIndex = -1;
        ctx.state.assistantTextBaseline = nextBaseline;
        ctx.state.pendingCrossTurnSeparator = shouldInsertCrossTurnSeparator;
      },
      resetForCompactionRetry: () => {},
    };

    const evt: AgentEvent = {
      type: "message_start",
      message: { role: "assistant" },
    } as AgentEvent & { message: { role: string } };

    // Call handleMessageStart which triggers resetAssistantMessageState
    handleMessageStart(ctx, evt);

    // Verify that pendingCrossTurnSeparator is set to true
    expect(state.pendingCrossTurnSeparator).toBe(true);
    // Verify that deltaBuffer is cleared
    expect(state.deltaBuffer).toBe("");
  });

  it("does not set pendingCrossTurnSeparator when block streaming is not active", () => {
    const state = {
      assistantTexts: [],
      toolMetas: [],
      toolMetaById: new Map(),
      toolSummaryById: new Set(),
      blockReplyBreak: "text_end" as const,
      reasoningMode: "off" as const,
      includeReasoning: false,
      shouldEmitPartialReplies: true,
      streamReasoning: false,
      deltaBuffer: "existing text content",
      blockBuffer: "",
      blockState: { thinking: false, final: false, inlineCode: {} },
      partialBlockState: { thinking: false, final: false, inlineCode: {} },
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      emittedAssistantUpdate: false,
      lastStreamedReasoning: undefined,
      lastBlockReplyText: undefined,
      reasoningStreamOpen: false,
      assistantMessageIndex: 0,
      lastAssistantTextMessageIndex: -1,
      lastAssistantTextNormalized: undefined,
      lastAssistantTextTrimmed: undefined,
      assistantTextBaseline: 0,
      suppressBlockChunks: false,
      lastReasoningSent: undefined,
      compactionInFlight: false,
      pendingCompactionRetry: 0,
      compactionRetryPromise: null,
      unsubscribed: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentTargets: [],
      messagingToolSentMediaUrls: [],
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
      successfulCronAdds: 0,
      pendingMessagingMediaUrls: new Map(),
      pendingCrossTurnSeparator: false,
    };

    const ctx = {
      params: {
        runId: "test-run",
        sessionId: { id: "test-session" },
        onAssistantMessageStart: undefined,
      },
      state,
      log: { debug: () => {}, warn: () => {} },
      blockChunking: undefined, // No block streaming
      blockChunker: null,
      hookRunner: undefined,
      noteLastAssistant: () => {},
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      emitToolSummary: () => {},
      emitToolOutput: () => {},
      stripBlockTags: (text: string) => text,
      emitBlockChunk: () => {},
      flushBlockReplyBuffer: () => {},
      emitReasoningStream: () => {},
      consumeReplyDirectives: () => ({ text: "", mediaUrls: undefined }),
      consumePartialReplyDirectives: () => ({ text: "", mediaUrls: undefined }),
      resetAssistantMessageState: (nextBaseline: number) => {
        const shouldInsertCrossTurnSeparator =
          ctx.blockChunking && ctx.state.deltaBuffer.length > 0;
        ctx.state.deltaBuffer = "";
        ctx.state.blockBuffer = "";
        ctx.state.assistantMessageIndex += 1;
        ctx.state.lastAssistantTextMessageIndex = -1;
        ctx.state.assistantTextBaseline = nextBaseline;
        ctx.state.pendingCrossTurnSeparator = shouldInsertCrossTurnSeparator;
      },
      resetForCompactionRetry: () => {},
    };

    const evt: AgentEvent = {
      type: "message_start",
      message: { role: "assistant" },
    } as AgentEvent & { message: { role: string } };

    handleMessageStart(ctx, evt);

    // Verify that pendingCrossTurnSeparator is NOT set when block streaming is not active
    expect(state.pendingCrossTurnSeparator).toBeUndefined();
  });

  it("does not set pendingCrossTurnSeparator when deltaBuffer is empty", () => {
    const state = {
      assistantTexts: [],
      toolMetas: [],
      toolMetaById: new Map(),
      toolSummaryById: new Set(),
      blockReplyBreak: "text_end" as const,
      reasoningMode: "off" as const,
      includeReasoning: false,
      shouldEmitPartialReplies: true,
      streamReasoning: false,
      deltaBuffer: "", // Empty deltaBuffer
      blockBuffer: "",
      blockState: { thinking: false, final: false, inlineCode: {} },
      partialBlockState: { thinking: false, final: false, inlineCode: {} },
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      emittedAssistantUpdate: false,
      lastStreamedReasoning: undefined,
      lastBlockReplyText: undefined,
      reasoningStreamOpen: false,
      assistantMessageIndex: 0,
      lastAssistantTextMessageIndex: -1,
      lastAssistantTextNormalized: undefined,
      lastAssistantTextTrimmed: undefined,
      assistantTextBaseline: 0,
      suppressBlockChunks: false,
      lastReasoningSent: undefined,
      compactionInFlight: false,
      pendingCompactionRetry: 0,
      compactionRetryPromise: null,
      unsubscribed: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentTargets: [],
      messagingToolSentMediaUrls: [],
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
      successfulCronAdds: 0,
      pendingMessagingMediaUrls: new Map(),
      pendingCrossTurnSeparator: false,
    };

    const ctx = {
      params: {
        runId: "test-run",
        sessionId: { id: "test-session" },
        onAssistantMessageStart: undefined,
      },
      state,
      log: { debug: () => {}, warn: () => {} },
      blockChunking: { minChars: 100, maxChars: 1000, breakPreference: "paragraph" as const },
      blockChunker: {
        hasBuffered: () => false,
        append: () => {},
        reset: () => {},
        drain: () => {},
      },
      hookRunner: undefined,
      noteLastAssistant: () => {},
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      emitToolSummary: () => {},
      emitToolOutput: () => {},
      stripBlockTags: (text: string) => text,
      emitBlockChunk: () => {},
      flushBlockReplyBuffer: () => {},
      emitReasoningStream: () => {},
      consumeReplyDirectives: () => ({ text: "", mediaUrls: undefined }),
      consumePartialReplyDirectives: () => ({ text: "", mediaUrls: undefined }),
      resetAssistantMessageState: (nextBaseline: number) => {
        const shouldInsertCrossTurnSeparator =
          ctx.blockChunking && ctx.state.deltaBuffer.length > 0;
        ctx.state.deltaBuffer = "";
        ctx.state.blockBuffer = "";
        ctx.blockChunker?.reset();
        ctx.state.assistantMessageIndex += 1;
        ctx.state.lastAssistantTextMessageIndex = -1;
        ctx.state.assistantTextBaseline = nextBaseline;
        ctx.state.pendingCrossTurnSeparator = shouldInsertCrossTurnSeparator;
      },
      resetForCompactionRetry: () => {},
    };

    const evt: AgentEvent = {
      type: "message_start",
      message: { role: "assistant" },
    } as AgentEvent & { message: { role: string } };

    handleMessageStart(ctx, evt);

    // Verify that pendingCrossTurnSeparator is NOT set when deltaBuffer is empty
    expect(state.pendingCrossTurnSeparator).toBe(false);
  });
});
