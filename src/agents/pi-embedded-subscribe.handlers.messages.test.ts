import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../markdown/code-spans.js";
import {
  buildAssistantStreamData,
  consumePendingToolMediaIntoReply,
  consumePendingToolMediaReply,
  handleMessageEnd,
  handleMessageUpdate,
  hasAssistantVisibleReply,
  resolveSilentReplyFallbackText,
} from "./pi-embedded-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

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

  it("tolerates malformed text payloads without throwing", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: undefined,
        messagingToolSentTexts: ["final delivered text"],
      }),
    ).toBe("");
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [42 as unknown as string],
      }),
    ).toBe("42");
  });
});

describe("hasAssistantVisibleReply", () => {
  it("treats audio-only payloads as visible", () => {
    expect(hasAssistantVisibleReply({ audioAsVoice: true })).toBe(true);
  });

  it("detects text or media visibility", () => {
    expect(hasAssistantVisibleReply({ text: "hello" })).toBe(true);
    expect(hasAssistantVisibleReply({ mediaUrls: ["https://example.com/a.png"] })).toBe(true);
    expect(hasAssistantVisibleReply({})).toBe(false);
  });
});

describe("buildAssistantStreamData", () => {
  it("normalizes media payloads for assistant stream events", () => {
    expect(
      buildAssistantStreamData({
        text: "hello",
        delta: "he",
        replace: true,
        mediaUrl: "https://example.com/a.png",
      }),
    ).toEqual({
      text: "hello",
      delta: "he",
      replace: true,
      mediaUrls: ["https://example.com/a.png"],
    });
  });
});

describe("consumePendingToolMediaIntoReply", () => {
  it("attaches queued tool media to the next assistant reply", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      audioAsVoice: undefined,
    });
    expect(state.pendingToolMediaUrls).toEqual([]);
  });

  it("preserves reasoning replies without consuming queued media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png"],
      pendingToolAudioAsVoice: true,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "thinking",
        isReasoning: true,
      }),
    ).toEqual({
      text: "thinking",
      isReasoning: true,
    });
    expect(state.pendingToolMediaUrls).toEqual(["/tmp/a.png"]);
    expect(state.pendingToolAudioAsVoice).toBe(true);
  });
});

describe("consumePendingToolMediaReply", () => {
  it("builds a media-only reply for orphaned tool media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolAudioAsVoice: true,
    };

    expect(consumePendingToolMediaReply(state)).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(state.pendingToolMediaUrls).toEqual([]);
    expect(state.pendingToolAudioAsVoice).toBe(false);
  });
});

describe("handleMessageUpdate", () => {
  it("suppresses commentary-phase partial delivery and text_end flush", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const ctx = {
      params: {
        runId: "run-1",
        session: { id: "session-1" },
        onAgentEvent,
        onPartialReply,
      },
      state: {
        deterministicApprovalPromptSent: false,
        reasoningStreamOpen: false,
        streamReasoning: false,
        deltaBuffer: "",
        blockBuffer: "",
        partialBlockState: {
          thinking: false,
          final: false,
          inlineCode: createInlineCodeState(),
        },
        lastStreamedAssistantCleaned: undefined,
        emittedAssistantUpdate: false,
        shouldEmitPartialReplies: true,
        blockReplyBreak: "text_end",
        assistantMessageIndex: 0,
      },
      log: { debug: vi.fn() },
      noteLastAssistant: vi.fn(),
      stripBlockTags: (text: string) => text,
      consumePartialReplyDirectives: vi.fn(() => null),
      flushBlockReplyBuffer,
    } as unknown as EmbeddedPiSubscribeContext;

    handleMessageUpdate(ctx, {
      type: "message_update",
      message: { role: "assistant", phase: "commentary", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "Need send." },
    } as never);
    handleMessageUpdate(ctx, {
      type: "message_update",
      message: { role: "assistant", phase: "commentary", content: [] },
      assistantMessageEvent: { type: "text_end", content: "Need send." },
    } as never);

    await Promise.resolve();

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
  });

  it("suppresses commentary partials when phase exists only in textSignature metadata", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const commentaryBlock = {
      type: "text",
      text: "Need send.",
      textSignature: JSON.stringify({ v: 1, id: "msg_sig", phase: "commentary" }),
    };
    const ctx = {
      params: {
        runId: "run-1",
        session: { id: "session-1" },
        onAgentEvent,
        onPartialReply,
      },
      state: {
        deterministicApprovalPromptSent: false,
        reasoningStreamOpen: false,
        streamReasoning: false,
        deltaBuffer: "",
        blockBuffer: "",
        partialBlockState: {
          thinking: false,
          final: false,
          inlineCode: createInlineCodeState(),
        },
        lastStreamedAssistantCleaned: undefined,
        emittedAssistantUpdate: false,
        shouldEmitPartialReplies: true,
        blockReplyBreak: "text_end",
        assistantMessageIndex: 0,
      },
      log: { debug: vi.fn() },
      noteLastAssistant: vi.fn(),
      stripBlockTags: (text: string) => text,
      consumePartialReplyDirectives: vi.fn(() => null),
      flushBlockReplyBuffer,
    } as unknown as EmbeddedPiSubscribeContext;

    handleMessageUpdate(ctx, {
      type: "message_update",
      message: { role: "assistant", content: [commentaryBlock] },
      assistantMessageEvent: { type: "text_delta", delta: "Need send." },
    } as never);
    handleMessageUpdate(ctx, {
      type: "message_update",
      message: { role: "assistant", content: [commentaryBlock] },
      assistantMessageEvent: { type: "text_end", content: "Need send." },
    } as never);

    await Promise.resolve();

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
    expect(ctx.state.deltaBuffer).toBe("");
    expect(ctx.state.blockBuffer).toBe("");
  });

  it("suppresses commentary partials until a final_answer partial arrives", () => {
    const onAgentEvent = vi.fn();
    const ctx = {
      params: {
        runId: "run-1",
        session: { id: "session-1" },
        onAgentEvent,
      },
      state: {
        deterministicApprovalPromptSent: false,
        reasoningStreamOpen: false,
        streamReasoning: false,
        deltaBuffer: "",
        blockBuffer: "",
        partialBlockState: {
          thinking: false,
          final: false,
          inlineCode: createInlineCodeState(),
        },
        lastStreamedAssistant: undefined,
        lastStreamedAssistantCleaned: undefined,
        emittedAssistantUpdate: false,
        shouldEmitPartialReplies: false,
        blockReplyBreak: "text_end",
      },
      log: { debug: vi.fn() },
      noteLastAssistant: vi.fn(),
      stripBlockTags: (text: string) => text,
      consumePartialReplyDirectives: vi.fn(() => null),
      emitReasoningStream: vi.fn(),
      flushBlockReplyBuffer: vi.fn(),
    } as unknown as EmbeddedPiSubscribeContext;

    handleMessageUpdate(ctx, {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Working...",
        partial: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Working...",
              textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
            },
          ],
          phase: "commentary",
          stopReason: "stop",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.2",
          usage: {},
          timestamp: 0,
        },
      },
    } as never);

    handleMessageUpdate(ctx, {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Done.",
        partial: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Done.",
              textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
            },
          ],
          phase: "final_answer",
          stopReason: "stop",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.2",
          usage: {},
          timestamp: 0,
        },
      },
    } as never);

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onAgentEvent.mock.calls[0]?.[0]).toMatchObject({
      stream: "assistant",
      data: {
        text: "Done.",
        delta: "Done.",
      },
    });
  });

  it("contains synchronous text_end flush failures", async () => {
    const debug = vi.fn();
    const ctx = {
      params: {
        runId: "run-1",
        session: { id: "session-1" },
      },
      state: {
        deterministicApprovalPromptSent: false,
        reasoningStreamOpen: false,
        streamReasoning: false,
        deltaBuffer: "",
        blockBuffer: "",
        partialBlockState: {
          thinking: false,
          final: false,
          inlineCode: createInlineCodeState(),
        },
        lastStreamedAssistantCleaned: undefined,
        emittedAssistantUpdate: false,
        shouldEmitPartialReplies: false,
        blockReplyBreak: "text_end",
      },
      log: { debug },
      noteLastAssistant: vi.fn(),
      stripBlockTags: (text: string) => text,
      consumePartialReplyDirectives: vi.fn(() => null),
      flushBlockReplyBuffer: vi.fn(() => {
        throw new Error("boom");
      }),
    } as unknown as EmbeddedPiSubscribeContext;

    handleMessageUpdate(ctx, {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_end" },
    } as never);

    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith("text_end block reply flush failed: Error: boom");
    });
  });
});

describe("handleMessageEnd", () => {
  it("suppresses commentary-phase replies from user-visible output", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = {
      params: {
        runId: "run-1",
        session: { id: "session-1" },
        onAgentEvent,
        onBlockReply: vi.fn(),
      },
      state: {
        assistantTexts: [],
        assistantTextBaseline: 0,
        emittedAssistantUpdate: false,
        deterministicApprovalPromptSent: false,
        reasoningStreamOpen: false,
        includeReasoning: false,
        streamReasoning: false,
        blockReplyBreak: "message_end",
        deltaBuffer: "Need send.",
        blockBuffer: "Need send.",
        blockState: {
          thinking: false,
          final: false,
          inlineCode: createInlineCodeState(),
        },
        lastStreamedAssistant: undefined,
        lastStreamedAssistantCleaned: undefined,
      },
      noteLastAssistant: vi.fn(),
      recordAssistantUsage: vi.fn(),
      log: { debug: vi.fn(), warn: vi.fn() },
      stripBlockTags: (text: string) => text,
      finalizeAssistantTexts,
      emitBlockReply,
      consumeReplyDirectives: vi.fn(() => ({ text: "Need send." })),
      emitReasoningStream: vi.fn(),
      flushBlockReplyBuffer: vi.fn(),
      blockChunker: null,
    } as unknown as EmbeddedPiSubscribeContext;

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        phase: "commentary",
        content: [{ type: "text", text: "Need send." }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("suppresses commentary message_end when phase exists only in textSignature metadata", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = {
      params: {
        runId: "run-1",
        session: { id: "session-1" },
        onAgentEvent,
        onBlockReply: vi.fn(),
      },
      state: {
        assistantTexts: [],
        assistantTextBaseline: 0,
        emittedAssistantUpdate: false,
        deterministicApprovalPromptSent: false,
        reasoningStreamOpen: false,
        includeReasoning: false,
        streamReasoning: false,
        blockReplyBreak: "message_end",
        deltaBuffer: "Need send.",
        blockBuffer: "Need send.",
        blockState: {
          thinking: false,
          final: false,
          inlineCode: createInlineCodeState(),
        },
        lastStreamedAssistant: undefined,
        lastStreamedAssistantCleaned: undefined,
      },
      noteLastAssistant: vi.fn(),
      recordAssistantUsage: vi.fn(),
      log: { debug: vi.fn(), warn: vi.fn() },
      stripBlockTags: (text: string) => text,
      finalizeAssistantTexts,
      emitBlockReply,
      consumeReplyDirectives: vi.fn(() => ({ text: "Need send." })),
      emitReasoningStream: vi.fn(),
      flushBlockReplyBuffer: vi.fn(),
      blockChunker: null,
    } as unknown as EmbeddedPiSubscribeContext;

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Need send.",
            textSignature: JSON.stringify({ v: 1, id: "msg_sig", phase: "commentary" }),
          },
        ],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("emits a replacement final assistant event when final_answer appears only at message_end", () => {
    const onAgentEvent = vi.fn();
    const ctx = {
      params: {
        runId: "run-1",
        session: { id: "session-1" },
        onAgentEvent,
      },
      state: {
        deterministicApprovalPromptSent: false,
        messagingToolSentTexts: [],
        messagingToolSentTextsNormalized: [],
        includeReasoning: false,
        streamReasoning: false,
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Working...",
        assistantTexts: [],
        assistantTextBaseline: 0,
        blockReplyBreak: "text_end",
        lastReasoningSent: undefined,
        reasoningStreamOpen: false,
        deltaBuffer: "",
        blockBuffer: "",
        blockState: {
          thinking: false,
          final: false,
          inlineCode: createInlineCodeState(),
        },
      },
      log: { debug: vi.fn() },
      noteLastAssistant: vi.fn(),
      recordAssistantUsage: vi.fn(),
      stripBlockTags: (text: string) => text,
      finalizeAssistantTexts: vi.fn(),
      emitReasoningStream: vi.fn(),
      blockChunker: null,
    } as unknown as EmbeddedPiSubscribeContext;

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Working...",
            textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
          },
        ],
        stopReason: "stop",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.2",
        usage: {},
        timestamp: 0,
      },
    } as never);

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onAgentEvent.mock.calls[0]?.[0]).toMatchObject({
      stream: "assistant",
      data: {
        text: "Done.",
        delta: "",
        replace: true,
      },
    });
  });
});
