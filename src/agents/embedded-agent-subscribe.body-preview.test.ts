import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";

describe("ephemeral body preview delivery", () => {
  const message = {
    role: "assistant",
    api: "openai-completions",
    provider: "mock",
    model: "reasoning-model",
    openclawDelivery: { textPhaseRequiresTerminal: true },
    content: [{ type: "thinking", thinking: "PRIVATE" }],
  };
  function event(text: string, revision: number, previewId = "preview-1", reset = false) {
    return {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_preview", text, revision, previewId, reset },
    };
  }
  it("delivers growing previews without making them a final or block reply", async () => {
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    const h = createSubscribedSessionHarness({
      runId: "preview-test",
      messageChannel: "feishu",
      bodyPreview: true,
      onPartialReply,
      onBlockReply,
      blockReplyBreak: "message_end",
    });
    h.emit({ type: "message_start", message });
    h.emit(event("First.", 1));
    h.emit(event("First. Second.", 2));
    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledTimes(2));
    expect(onPartialReply.mock.calls.map((c) => c[0].text)).toEqual(["First.", "First. Second."]);
    expect(onBlockReply).not.toHaveBeenCalled();
    h.emit({
      type: "message_end",
      message: {
        ...message,
        stopReason: "stop",
        content: [{ type: "text", text: "Canonical final." }],
      },
    });
    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledTimes(1));
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Canonical final." }),
      expect.objectContaining({ assistantMessageIndex: 1 }),
    );
    h.subscription.unsubscribe();
    expect(message.content).toEqual([{ type: "thinking", thinking: "PRIVATE" }]);
  });
  it("replaces and clears previews, drops old revisions and retired message IDs", async () => {
    const onPartialReply = vi.fn();
    const h = createSubscribedSessionHarness({
      runId: "preview-reset",
      messageChannel: "feishu",
      bodyPreview: true,
      onPartialReply,
    });
    h.emit(event("Long interim.", 1));
    h.emit(event("", 2, "preview-1", true));
    h.emit(event("New.", 1, "preview-2"));
    h.emit(event("STALE", 3, "preview-1"));
    h.emit(event("STALE", 1, "preview-2"));
    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledTimes(3));
    expect(onPartialReply.mock.calls.map((c) => c[0].text)).toEqual(["Long interim.", "", "New."]);
    h.subscription.unsubscribe();
    h.emit(event("LATE", 2, "preview-2"));
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(onPartialReply).toHaveBeenCalledTimes(3);
  });
  it.each([
    { bodyPreview: false },
    { bodyPreview: undefined },
    { suppressLiveStreamOutput: true },
    { silentExpected: true },
    { sourceReplyDeliveryMode: "message_tool_only" as const },
    { onBeforeTerminalDelivery: async () => undefined },
    { isTerminalAborted: () => true },
  ])("respects suppression %j", async (override) => {
    const onPartialReply = vi.fn();
    const h = createSubscribedSessionHarness({
      runId: "preview-suppress",
      messageChannel: "feishu",
      bodyPreview: true,
      onPartialReply,
      ...override,
    });
    h.emit(event("Hidden.", 1));
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(onPartialReply).not.toHaveBeenCalled();
    h.subscription.unsubscribe();
  });
  it("holds incomplete delivery directives out of previews", async () => {
    const onPartialReply = vi.fn();
    const h = createSubscribedSessionHarness({
      runId: "preview-directive",
      messageChannel: "feishu",
      bodyPreview: true,
      onPartialReply,
    });
    h.emit(event("Answer [[reply_to_", 1));
    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledTimes(1));
    expect(onPartialReply).toHaveBeenCalledWith(expect.objectContaining({ text: "Answer" }));
    h.subscription.unsubscribe();
  });
});
