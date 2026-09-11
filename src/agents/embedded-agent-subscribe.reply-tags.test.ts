// Reply-tag tests cover streaming directive parsing for reply_to markers across
// block replies and partial reply chunks.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

describe("subscribeEmbeddedAgentSession reply tags", () => {
  type ReplyPayload = {
    text?: string;
    replyToId?: string;
    replyToCurrent?: boolean;
    replyToTag?: boolean;
    audioAsVoice?: boolean;
  };

  function replyPayloadAt(mock: ReturnType<typeof vi.fn>, index: number): ReplyPayload {
    const call = mock.mock.calls[index];
    if (!call) {
      throw new Error(`expected reply payload at index ${index}`);
    }
    return call[0] as ReplyPayload;
  }

  function replyTexts(mock: ReturnType<typeof vi.fn>): string[] {
    return mock.mock.calls.map(([payload]) => (payload as ReplyPayload).text ?? "");
  }

  function lastReplyPayload(mock: ReturnType<typeof vi.fn>): ReplyPayload {
    return replyPayloadAt(mock, mock.mock.calls.length - 1);
  }

  function createBlockReplyHarness() {
    // Small chunk sizes force directive-only and text chunks through the block
    // reply path where reply metadata must be preserved.
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        minChars: 1,
        maxChars: 50,
        breakPreference: "newline",
      },
    });

    return { emit, onBlockReply, subscription };
  }

  it.each([
    {
      name: "split inline code",
      chunks: ["Use `", "[[reply_to:example-id]]` literally.\n\n"],
      text: "Use `[[reply_to:example-id]]` literally.",
      replyToId: undefined,
    },
    {
      name: "inline code split by block chunking",
      chunks: ["Use `" + "x".repeat(60), "[[reply_to:example-id]]` literally.\n\n"],
      literal: "[[reply_to:example-id]]",
      replyToId: undefined,
    },
    {
      name: "complete inline code",
      chunks: ["Use `[[reply_to:example-id]]` literally.\n\n"],
      text: "Use `[[reply_to:example-id]]` literally.",
      replyToId: undefined,
    },
    {
      name: "a reply directive outside code",
      chunks: ["[[reply_to:example-id]]", "Visible reply.\n\n"],
      text: "Visible reply.",
      replyToId: "example-id",
    },
    {
      name: "a voice directive followed by ordinary blocks",
      chunks: [
        "[[audio_as_voice]]Hello.\n\n",
        "An ordinary paragraph is long enough to drain the earlier voice block.\n\n",
      ],
      text: "Hello.",
      audioAsVoice: true,
      replyToId: undefined,
    },
  ])("delivers $name before text_end with matching reply metadata", async (scenario) => {
    const { emit, onBlockReply, subscription } = createBlockReplyHarness();
    const message = { role: "assistant", phase: "final_answer", content: [] };

    emit({ type: "message_start", message });
    for (const delta of [
      ...scenario.chunks,
      "A second paragraph gives the first completed block enough text to drain.",
    ]) {
      emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
    }
    await subscription.waitForPendingEvents();

    const payload = replyPayloadAt(onBlockReply, 0);
    if (scenario.text) {
      expect(payload.text).toBe(scenario.text);
    }
    if (scenario.literal) {
      expect(replyTexts(onBlockReply).join("")).toContain(scenario.literal);
    }
    expect(payload.replyToId).toBe(scenario.replyToId);
    expect(Boolean(payload.replyToTag)).toBe(Boolean(scenario.replyToId));
    expect(payload.replyToCurrent).toBeFalsy();
    expect(Boolean(payload.audioAsVoice)).toBe(Boolean(scenario.audioAsVoice));
    for (const [later] of onBlockReply.mock.calls.slice(1)) {
      expect(later.audioAsVoice).toBeFalsy();
      if (!scenario.replyToId) {
        expect(later.replyToId).toBeUndefined();
        expect(later.replyToTag).toBeFalsy();
        expect(later.replyToCurrent).toBeFalsy();
      }
    }
  });

  it("carries reply_to_current across tag-only block chunks", () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to_current]]\nHello" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = textAssistant("[[reply_to_current]]\nHello") as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = replyPayloadAt(onBlockReply, 0);
    expect(payload.text).toBe("Hello");
    expect(payload.replyToCurrent).toBe(true);
    expect(payload.replyToTag).toBe(true);
  });

  it.each([
    {
      name: "literal brackets",
      text: "Hello [[",
      expectedTexts: ["Hello", " [["],
      repeatFinal: true,
    },
    {
      name: "valid media",
      text: "Hello\nMEDIA:https://example.com/a.png",
      expectedTexts: ["Hello", ""],
      mediaUrls: ["https://example.com/a.png"],
    },
    {
      name: "rejected media path",
      text: "Hello\nMEDIA:../secret.png",
      expectedTexts: ["Hello"],
    },
    {
      name: "withdrawn media",
      text: "Hello\nMEDIA:https://example.com/a.png",
      finalText: "Hello",
      expectedTexts: ["Hello"],
    },
    {
      name: "literal media inside an unclosed fence",
      text: "```text\nMEDIA:https://example.com/a.png",
      expectedTexts: ["```text\n", "MEDIA:https://example.com/a.png"],
    },
  ])("flushes trailing directive tails on stream end: $name", (scenario) => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: scenario.text });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: scenario.finalText ?? scenario.text }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(scenario.expectedTexts.length);
    expect(replyTexts(onBlockReply)).toEqual(scenario.expectedTexts);
    expect(onBlockReply.mock.calls.flatMap(([payload]) => payload.mediaUrls ?? [])).toEqual(
      scenario.mediaUrls ?? [],
    );

    if (scenario.repeatFinal) {
      expect(replyTexts(onBlockReply).join("")).toBe("Hello [[");
      emit({ type: "message_end", message: assistantMessage });
      expect(replyTexts(onBlockReply)).toEqual(["Hello", " [["]);
    }
  });

  it.each([
    { name: "a split reply tag", chunks: ["[[reply_to:1897", "]] Hello", " world"] },
    {
      name: "held whitespace before hidden reasoning",
      chunks: [" \nHello \t", "<think>private</think> [[reply_to_current]] world  "],
    },
    {
      name: "held whitespace before a split reasoning tag",
      chunks: [" \nHello \t<think", ">private</think> [[reply_to_current]] world  "],
    },
  ])("streams partial replies past $name", ({ chunks }) => {
    // Split tags are buffered until complete so partial replies never expose raw
    // directive syntax.
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of chunks) {
      emitAssistantTextDelta({ emit, delta });
    }

    expect(replyTexts(onPartialReply)).toEqual(["Hello", "Hello world"]);
    emitAssistantTextEnd({ emit });
    expect(lastReplyPayload(onPartialReply).text).toBe("Hello world");
    for (const call of onPartialReply.mock.calls) {
      expect(call[0]?.text?.includes("[[reply_to")).toBe(false);
    }
  });

  it("strips a malformed reply prefix when the stream ends", () => {
    const { session, emit } = createStubSessionHarness();
    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to_" });
    emitAssistantTextDelta({ emit, delta: "current] Visible reply" });
    emitAssistantTextEnd({ emit });

    const payload = lastReplyPayload(onPartialReply);
    expect(payload.text).toBe("Visible reply");
    expect(payload.replyToCurrent).toBeUndefined();
    expect(payload.replyToTag).toBeUndefined();
    for (const call of onPartialReply.mock.calls) {
      expect(call[0]?.text?.includes("[[reply_to")).toBe(false);
    }
  });

  it.each([
    {
      name: "a split malformed prefix",
      chunks: ["[[reply_to_", "current] Visible reply"],
      source: "[[reply_to_current] Visible reply",
      text: "Visible reply",
      replyToId: undefined,
    },
    {
      name: "a genuine tag without streamed deltas",
      chunks: [],
      source: "[[reply_to:target]] Visible reply",
      text: "Visible reply",
      replyToId: "target",
    },
    {
      name: "a literal tag without streamed deltas",
      chunks: [],
      source: "Use `[[reply_to:target]]` literally.",
      text: "Use `[[reply_to:target]]` literally.",
      replyToId: undefined,
    },
  ])("prepares the final block reply for $name", async (scenario) => {
    const { emit, onBlockReply, subscription } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of scenario.chunks) {
      emitAssistantTextDelta({ emit, delta });
    }
    if (scenario.chunks.length > 0) {
      emitAssistantTextEnd({ emit });
    }

    const assistantMessage = textAssistant(scenario.source) as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = replyPayloadAt(onBlockReply, 0);
    expect(payload.text).toBe(scenario.text);
    expect(payload.replyToId).toBe(scenario.replyToId);
    expect(payload.replyToCurrent).toBeFalsy();
    expect(Boolean(payload.replyToTag)).toBe(Boolean(scenario.replyToId));
  });
});
