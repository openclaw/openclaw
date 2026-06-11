import type {
  OpenClawConfig,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./bot-message-dispatch.runtime.js", () => ({
  resolveMarkdownTableMode: () => "off",
}));
vi.mock("./format.js", () => ({
  renderTelegramHtmlText: (text: string) => text,
}));

import { createTelegramEchoRenderer } from "./echo-renderer.js";

function fakeApi() {
  const sendMessage = vi.fn(async () => ({ message_id: 100 }));
  const editMessageText = vi.fn(async () => true);
  const deleteMessage = vi.fn(async () => true);
  return { sendMessage, editMessageText, deleteMessage } as unknown as Parameters<
    typeof createTelegramEchoRenderer
  >[0]["api"] & {
    sendMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
    deleteMessage: ReturnType<typeof vi.fn>;
  };
}

const cfg = {} as OpenClawConfig;

describe("createTelegramEchoRenderer", () => {
  it("streams the response onto the target chat and finalizes the draft", async () => {
    const api = fakeApi();
    const r = createTelegramEchoRenderer({
      api,
      chatId: 999,
      cfg,
      textLimit: 4096,
      throttleMs: 250,
    });

    await r.options.onPartialReply?.({ text: "Hello" });
    await r.finalize({ text: "Hello world" });

    expect(api.sendMessage).toHaveBeenCalled();
    // First send targets the echo chat.
    expect(api.sendMessage.mock.calls[0][0]).toBe(999);
    const rendered = [
      ...api.sendMessage.mock.calls.map((c) => c[1]),
      ...api.editMessageText.mock.calls.map((c) => c[2]),
    ].join("|");
    expect(rendered).toContain("Hello world");
  });

  it("accumulates delta-only payloads", async () => {
    const api = fakeApi();
    const r = createTelegramEchoRenderer({ api, chatId: 7, cfg, textLimit: 4096, throttleMs: 250 });

    await r.options.onPartialReply?.({ delta: "foo" });
    await r.options.onPartialReply?.({ delta: "bar" });
    await r.finalize();

    const rendered = [
      ...api.sendMessage.mock.calls.map((c) => c[1]),
      ...api.editMessageText.mock.calls.map((c) => c[2]),
    ].join("|");
    expect(rendered).toContain("foobar");
  });

  const renderedOf = (api: ReturnType<typeof fakeApi>) =>
    [
      ...api.sendMessage.mock.calls.map((c) => c[1]),
      ...api.editMessageText.mock.calls.map((c) => c[2]),
    ].join("|");

  it("wires the same native progress callbacks (gating lives in the shared compositor)", () => {
    const r = createTelegramEchoRenderer({
      api: fakeApi(),
      chatId: 5,
      cfg,
      textLimit: 4096,
      streamMode: "partial",
      streamingEntry: {} as TelegramAccountConfig,
    });
    // The renderer reuses buildTelegramProgressCallbacks (the native dispatch's
    // bundle), so the progress callbacks are always present; the destination's
    // streaming config is honored inside createChannelProgressDraftCompositor.
    expect(r.options.onToolStart).toBeTypeOf("function");
    expect(r.options.onItemEvent).toBeTypeOf("function");
    expect(r.options.onPlanUpdate).toBeTypeOf("function");
    expect(r.options.onReasoningStream).toBeTypeOf("function");
  });

  it("renders tool progress through the compositor, then the final answer", async () => {
    const api = fakeApi();
    const r = createTelegramEchoRenderer({
      api,
      chatId: 7,
      cfg,
      textLimit: 4096,
      throttleMs: 250,
      streamMode: "progress",
      streamingEntry: {} as TelegramAccountConfig,
    });
    await r.options.onToolStart?.({ name: "shell", args: { command: "date -u" } });
    await r.options.onPartialReply?.({ text: "It is 12:00 UTC" });
    await r.finalize({ text: "It is 12:00 UTC" });
    expect(renderedOf(api)).toContain("It is 12:00 UTC");
  });

  it("dispose() stops without sending a late final", async () => {
    const api = fakeApi();
    const r = createTelegramEchoRenderer({ api, chatId: 1, cfg, textLimit: 4096, throttleMs: 250 });

    await r.dispose();
    await r.finalize({ text: "late" }); // no-op after dispose

    const sent = api.sendMessage.mock.calls.map((c) => c[1]).join("|");
    expect(sent).not.toContain("late");
  });
});
