import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

type Reply = Parameters<NonNullable<SubscribeEmbeddedAgentSessionParams["onBlockReply"]>>[0];
const subscriptions: Array<ReturnType<typeof createSubscribedSessionHarness>["subscription"]> = [];
afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) {
    subscription.unsubscribe();
    await subscription.waitForPendingEvents();
  }
});
function replies(partial = false) {
  const onReply = vi.fn<(payload: Reply) => void>();
  const harness = createSubscribedSessionHarness({
    runId: "reply-tags",
    ...(partial ? { onPartialReply: onReply } : { onBlockReply: onReply }),
    blockReplyBreak: "text_end",
    blockReplyChunking: { minChars: 1, maxChars: 50, breakPreference: "newline" },
  });
  subscriptions.push(harness.subscription);
  const message = { role: "assistant", phase: "final_answer", content: [] };
  harness.emit({ type: "message_start", message });
  return {
    ...harness,
    onReply,
    payloads: () => onReply.mock.calls.map(([payload]) => payload),
    delta: (delta: string) => emitAssistantTextDelta({ emit: harness.emit, delta }),
    end: (text: string) =>
      harness.emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      }),
    message,
  };
}

describe("subscribeEmbeddedAgentSession reply tags", () => {
  it.each([
    {
      name: "chunked inline code",
      chunks: ["Use `" + "x".repeat(60), "[[reply_to:example-id]]` literally.\n\n"],
      voice: false,
    },
    {
      name: "voice intent",
      chunks: [
        "[[audio_as_voice]]Hello.\n\n",
        "An ordinary paragraph is long enough to drain the earlier voice block.\n\n",
      ],
      voice: true,
    },
  ])("delivers $name before text_end without leaking metadata", async ({ chunks, voice }) => {
    const h = replies();
    for (const delta of [
      ...chunks,
      "A second paragraph gives the first completed block enough text to drain.",
    ]) {
      h.emit({
        type: "message_update",
        message: h.message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
    }
    await h.subscription.waitForPendingEvents();
    const payloads = h.payloads();
    if (voice) {
      expect(payloads[0]?.text).toBe("Hello.");
    } else {
      expect(payloads.map((payload) => payload.text).join("")).toContain("[[reply_to:example-id]]");
    }
    expect(Boolean(payloads[0]?.audioAsVoice)).toBe(voice);
    for (const [index, payload] of payloads.entries()) {
      expect(payload.replyToId).toBeUndefined();
      expect(payload.replyToTag).toBeFalsy();
      expect(payload.replyToCurrent).toBeFalsy();
      if (index > 0) {
        expect(payload.audioAsVoice).toBeFalsy();
      }
    }
  });

  it("carries reply_to_current across tag-only block chunks", () => {
    const h = replies();
    h.delta("[[reply_to_current]]\nHello");
    emitAssistantTextEnd(h);
    h.end("[[reply_to_current]]\nHello");
    expect(h.payloads()).toEqual([
      expect.objectContaining({ text: "Hello", replyToCurrent: true, replyToTag: true }),
    ]);
  });

  it.each([
    {
      name: "valid media",
      text: "Hello\nMEDIA:https://example.com/a.png",
      final: "Hello\nMEDIA:https://example.com/a.png",
      texts: ["Hello", ""],
      media: ["https://example.com/a.png"],
      early: false,
    },
    {
      name: "withdrawn media",
      text: "Hello\nMEDIA:https://example.com/a.png",
      final: "Hello",
      texts: ["Hello"],
      media: [],
      early: false,
    },
    {
      name: "unclosed fence",
      text: "```text\nMEDIA:https://example.com/a.png",
      final: "```text\nMEDIA:https://example.com/a.png",
      texts: ["```text\nMEDIA:https://example.com/a.png"],
      media: [],
      early: true,
    },
  ])("flushes trailing directive tails: $name", ({ text, final, texts, media, early }) => {
    const h = replies();
    h.delta(text);
    emitAssistantTextEnd(h);
    if (early) {
      expect(h.payloads().map((payload) => payload.text)).toEqual(texts);
    }
    h.end(final);
    expect(h.payloads().map((payload) => payload.text)).toEqual(texts);
    expect(h.payloads().flatMap((payload) => payload.mediaUrls ?? [])).toEqual(media);
  });

  it("streams partial replies past split reasoning and reply tags", () => {
    const h = replies(true);
    for (const delta of [" \nHello \t<think", ">private</think> [[reply_to_current]] world  "]) {
      h.delta(delta);
    }
    expect(h.payloads().map((payload) => payload.text)).toEqual(["Hello", "Hello world"]);
    emitAssistantTextEnd(h);
    expect(h.payloads().at(-1)?.text).toBe("Hello world");
    for (const payload of h.payloads()) {
      expect(payload.text).not.toContain("[[reply_to");
    }
  });

  it("strips a malformed reply prefix when the stream ends", () => {
    const h = replies(true);
    h.delta("[[reply_to_");
    h.delta("current] Visible reply");
    emitAssistantTextEnd(h);
    const finalPayload = h.payloads().at(-1);
    expect(finalPayload?.text).toBe("Visible reply");
    expect(finalPayload?.replyToCurrent).toBeUndefined();
    expect(finalPayload?.replyToTag).toBeUndefined();
    for (const payload of h.payloads()) {
      expect(payload.text).not.toContain("[[reply_to");
    }
  });
});
