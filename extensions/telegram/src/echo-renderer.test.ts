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

  it("rides progress-mode config: wires the tool lane and renders it natively", async () => {
    const api = fakeApi();
    const r = createTelegramEchoRenderer({
      api,
      chatId: 5,
      cfg,
      textLimit: 4096,
      throttleMs: 250,
      streamMode: "progress",
      streamingEntry: {} as TelegramAccountConfig,
    });
    // Progress mode surfaces the verbose/tool lane the resolver already drives.
    expect(r.options.onToolStart).toBeTypeOf("function");
    expect(r.options.onItemEvent).toBeTypeOf("function");

    // A tool event with no answer yet renders the tool-progress draft on its own.
    await r.options.onToolStart?.({ name: "shell", args: { command: "date -u" } });
    await r.finalize();
    expect(api.sendMessage).toHaveBeenCalled();
    expect(renderedOf(api).length).toBeGreaterThan(0);
  });

  it("rides partial-mode config: no separate tool lane, answer still streams", async () => {
    const api = fakeApi();
    const r = createTelegramEchoRenderer({
      api,
      chatId: 6,
      cfg,
      textLimit: 4096,
      throttleMs: 250,
      streamMode: "partial",
      streamingEntry: {} as TelegramAccountConfig,
    });
    // Native telegram groups do not surface a tool lane in partial mode, so the
    // mirror does not wire one either — it rides what the channel would do.
    expect(r.options.onToolStart).toBeUndefined();
    expect(r.options.onItemEvent).toBeUndefined();

    await r.options.onPartialReply?.({ text: "answer" });
    await r.finalize({ text: "answer" });
    expect(renderedOf(api)).toContain("answer");
  });

  it("collapses the tool-progress draft into the answer when it arrives", async () => {
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
