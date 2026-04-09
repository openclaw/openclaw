import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  it("emits block replies on text_end and does not duplicate on message_end", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Hello block" });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    const payload = onBlockReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello block");
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("does not duplicate when message_end flushes and a late text_end arrives", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });

    emitAssistantTextDelta({ emit, delta: "Hello block" });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    // Simulate a provider that ends the message without emitting text_end.
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    // Some providers can still emit a late text_end; this must not re-emit.
    emitAssistantTextEnd({ emit, content: "Hello block" });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("emits legacy structured partials on text_end without waiting for message_end", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Legacy answer",
        partial: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Legacy answer",
              textSignature: JSON.stringify({ v: 1, id: "item_legacy" }),
            },
          ],
          stopReason: "stop",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.2",
          usage: {},
          timestamp: 0,
        },
      },
    });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        content: "Legacy answer",
        partial: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Legacy answer",
              textSignature: JSON.stringify({ v: 1, id: "item_legacy" }),
            },
          ],
          stopReason: "stop",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.2",
          usage: {},
          timestamp: 0,
        },
      },
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Legacy answer");
    expect(subscription.assistantTexts).toEqual(["Legacy answer"]);

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Legacy answer" }],
      } as AssistantMessage,
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Legacy answer"]);
  });

  it("suppresses commentary block replies until a final answer is available", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
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
    });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        content: "Working...",
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
    });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual([]);

    emit({
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
    });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        content: "Done.",
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
    });
    await Promise.resolve();

    emit({
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
      } as AssistantMessage,
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Done.");
    expect(subscription.assistantTexts).toEqual(["Done."]);
  });

  it("emits the full final answer on text_end when it extends suppressed commentary", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello",
        partial: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Hello",
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
    });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        content: "Hello",
        partial: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Hello",
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
    });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();

    emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: " world",
        partial: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Hello world",
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
    });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        content: "Hello world",
        partial: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Hello world",
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
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Hello world");
    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it("does not defer final_answer text_end when phase exists only in textSignature", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
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
          stopReason: "stop",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.2",
          usage: {},
          timestamp: 0,
        },
      },
    });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        content: "Done.",
        partial: {
          role: "assistant",
          content: [
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
      },
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Done.");
    expect(subscription.assistantTexts).toEqual(["Done."]);
  });

  it("emits the final answer at message_end when commentary was streamed first", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
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
    });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        content: "Working...",
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
    });
    await Promise.resolve();

    emit({
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
      } as AssistantMessage,
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Done.");
    expect(subscription.assistantTexts).toEqual(["Done."]);
  });
});
