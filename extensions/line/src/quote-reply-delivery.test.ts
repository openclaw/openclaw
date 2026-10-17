import { expectDefined } from "@openclaw/normalization-core";
import { chunkMarkdownText as chunkMarkdownTextForLine } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, ReplyPayload } from "../api.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { baseDeliveryParams, createDeps } from "./auto-reply-delivery.test-helpers.js";
import { createRuntime } from "./channel.sendPayload.test-support.js";
import { lineMessageAdapter, lineOutboundAdapter } from "./outbound.js";
import { recordLineQuoteToken } from "./quote-tokens.js";
import { setLineRuntime } from "./runtime.js";

const logVerboseMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: logVerboseMock,
  danger: (t: string) => t,
}));

function rememberInboundMessage(
  messageId: string,
  quoteToken: string,
  chatId = "1",
  accountId = "acc",
) {
  recordLineQuoteToken({ accountId, chatId, messageId, quoteToken });
}

function pushReply(chat: string) {
  rememberInboundMessage(`inbound-${chat}`, `token-${chat}`, `C${chat}`, "default");
  const { runtime, mocks } = createRuntime();
  setLineRuntime(runtime);
  const context = {
    cfg: { channels: { line: {} } } as OpenClawConfig,
    to: `line:group:C${chat}`,
    replyToId: `inbound-${chat}`,
    accountId: "default",
  };
  return {
    mocks,
    context,
    send: (payload: ReplyPayload) =>
      lineOutboundAdapter.sendPayload!({ ...context, text: payload.text ?? "", payload }),
  };
}

describe("the reply-token delivery path", () => {
  it("quotes once, on the first message LINE accepts a quote on", async () => {
    rememberInboundMessage("inbound-multi", "token-multi");
    const { replyMessageLine } = createDeps({
      chunkMarkdownText: (text) => text.split("|"),
    });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "first|second|third", replyToId: "inbound-multi" },
      lineData: { flexMessage: { altText: "card", contents: { type: "bubble" } } },
    });

    const messages = expectDefined(replyMessageLine.mock.calls[0]?.[1], "reply messages");
    expect(messages.map((message) => "quoteToken" in message)).toEqual([true, false, false, false]);
    expect(messages[0]).toMatchObject({ type: "text", text: "first", quoteToken: "token-multi" });
  });

  it("sends unquoted when the reply carries nothing that can hold a quote", async () => {
    rememberInboundMessage("inbound-flex", "token-flex");
    const { replyMessageLine } = createDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { replyToId: "inbound-flex" },
      lineData: { flexMessage: { altText: "card", contents: { type: "bubble" } } },
    });

    const messages = expectDefined(replyMessageLine.mock.calls[0]?.[1], "reply messages");
    expect(messages.every((message) => !("quoteToken" in message))).toBe(true);
  });

  it("sends unquoted when the answered message is not one this chat produced", async () => {
    rememberInboundMessage("inbound-elsewhere", "token-elsewhere", "Celsewhere");
    const { replyMessageLine } = createDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "answering you", replyToId: "inbound-elsewhere" },
      lineData: {},
    });

    expect(expectDefined(replyMessageLine.mock.calls[0]?.[1], "reply messages")).toEqual([
      { type: "text", text: "answering you" },
    ]);
  });
});

describe("the push delivery path", () => {
  it("quotes the first chunk of a reply that answers a message", async () => {
    const { send, mocks } = pushReply("push");
    mocks.chunkMarkdownText.mockImplementation((text: string) => text.split("|"));

    await send({ text: "first|second" });

    expect(mocks.pushMessageLine.mock.calls.map((args) => [args[1], args[2].quoteToken])).toEqual([
      ["first", "token-push"],
      ["second", undefined],
    ]);
  });

  it("quotes the text that carries the quick replies when that is the only text", async () => {
    const { send, mocks } = pushReply("quick");
    await send({ text: "pick one", channelData: { line: { quickReplies: ["Yes", "No"] } } });

    expect(mocks.pushTextMessageWithQuickReplies).toHaveBeenCalledExactlyOnceWith(
      "line:group:Cquick",
      "pick one",
      ["Yes", "No"],
      expect.objectContaining({ quoteToken: "token-quick" }),
    );
  });

  it("quotes a plain-text send routed through the message adapter", async () => {
    const { context, mocks } = pushReply("adapter");

    await lineMessageAdapter.send!.text!({ ...context, text: "answering you" });

    expect(mocks.pushMessageLine).toHaveBeenCalledExactlyOnceWith(
      "line:group:Cadapter",
      "answering you",
      expect.objectContaining({ quoteToken: "token-adapter" }),
    );
  });

  it("quotes a media send routed through the message adapter", async () => {
    const { context, mocks } = pushReply("media");

    await lineMessageAdapter.send!.media!({
      ...context,
      text: "here you go",
      mediaUrl: "https://example.com/image.jpg",
    });

    // The caption is the only part LINE lets a quote ride on; the image itself cannot.
    expect(mocks.pushMessageLine.mock.calls).toEqual([
      ["line:group:Cmedia", "here you go", expect.objectContaining({ quoteToken: "token-media" })],
      [
        "line:group:Cmedia",
        "",
        expect.objectContaining({ mediaUrl: "https://example.com/image.jpg" }),
      ],
    ]);
    expect(expectDefined(mocks.pushMessageLine.mock.calls[1], "media push")[2]).not.toHaveProperty(
      "quoteToken",
    );
  });

  it("quotes the first text of a reply whose leading part cannot carry a quote", async () => {
    const { send, mocks } = pushReply("ordered");
    mocks.resolveTextChunkLimit.mockReturnValue(5000);
    mocks.chunkMarkdownText.mockImplementation((text: string) =>
      chunkMarkdownTextForLine(text, 5000),
    );
    const markdown = "```js\nfirst()\n```\n\nAfter the card";

    await send({ text: markdown });

    expect(mocks.pushFlexMessage).toHaveBeenCalledOnce();
    expect(mocks.pushMessageLine).toHaveBeenCalledExactlyOnceWith(
      "line:group:Cordered",
      "After the card",
      expect.objectContaining({ quoteToken: "token-ordered" }),
    );
  });
});
