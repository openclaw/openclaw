// Line tests cover quoted reply delivery plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { chunkMarkdownText as chunkMarkdownTextForLine } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { baseDeliveryParams, createDeps } from "./auto-reply-delivery.test-helpers.js";
import { createRuntime, sentMessages } from "./channel.sendPayload.test-support.js";
import { lineMessageAdapter, lineOutboundAdapter } from "./outbound.js";
import { recordLineQuoteToken } from "./quote-tokens.js";
import { setLineRuntime } from "./runtime.js";

const logVerboseMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: logVerboseMock,
  danger: (t: string) => t,
}));

// A media send travels in the same request as its caption, so building the image
// message resolves its host; keep that resolution off the network.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: async () => ({
    hostname: "example.com",
    addresses: ["93.184.216.34"],
  }),
}));

// baseDeliveryParams answers on account "acc" in chat "line:user:1".
const REPLY_ACCOUNT = "acc";
const REPLY_CHAT = "1";

function rememberInboundMessage(messageId: string, quoteToken: string) {
  recordLineQuoteToken({
    accountId: REPLY_ACCOUNT,
    chatId: REPLY_CHAT,
    messageId,
    quoteToken,
  });
}

describe("the reply-token delivery path", () => {
  it("quotes the message the reply answers", async () => {
    rememberInboundMessage("inbound-1", "token-1");
    const { deps, replyMessageLine } = createDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "answering you", replyToId: "inbound-1" },
      lineData: {},
      deps,
    });

    expect(expectDefined(replyMessageLine.mock.calls[0]?.[1], "reply messages")).toEqual([
      { type: "text", text: "answering you", quoteToken: "token-1" },
    ]);
  });

  it("quotes once, on the first message LINE accepts a quote on", async () => {
    rememberInboundMessage("inbound-multi", "token-multi");
    const { deps, replyMessageLine } = createDeps({
      chunkMarkdownText: (text) => text.split("|"),
    });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "first|second|third", replyToId: "inbound-multi" },
      lineData: { flexMessage: { altText: "card", contents: { type: "bubble" } } },
      deps,
    });

    const messages = expectDefined(replyMessageLine.mock.calls[0]?.[1], "reply messages");
    expect(messages.map((message) => "quoteToken" in message)).toEqual([true, false, false, false]);
    expect(messages[0]).toMatchObject({ type: "text", text: "first", quoteToken: "token-multi" });
  });

  it("keeps the quote when a failed reply token falls back to a push", async () => {
    rememberInboundMessage("inbound-fallback", "token-fallback");
    const { deps, replyMessageLine, pushMessagesLine } = createDeps();
    replyMessageLine.mockRejectedValueOnce(
      Object.assign(new Error("Invalid reply token"), { status: 400 }),
    );

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "late answer", replyToId: "inbound-fallback" },
      lineData: {},
      deps,
    });

    expect(expectDefined(pushMessagesLine.mock.calls[0]?.[1], "push messages")).toEqual([
      { type: "text", text: "late answer", quoteToken: "token-fallback" },
    ]);
  });

  it("sends unquoted when the reply carries nothing that can hold a quote", async () => {
    rememberInboundMessage("inbound-flex", "token-flex");
    const { deps, replyMessageLine } = createDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { replyToId: "inbound-flex" },
      lineData: { flexMessage: { altText: "card", contents: { type: "bubble" } } },
      deps,
    });

    const messages = expectDefined(replyMessageLine.mock.calls[0]?.[1], "reply messages");
    expect(messages.every((message) => !("quoteToken" in message))).toBe(true);
  });

  it("reports a reply that answered a message but could carry no quote", async () => {
    rememberInboundMessage("inbound-cardonly", "token-cardonly");
    const { deps } = createDeps();
    logVerboseMock.mockClear();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { replyToId: "inbound-cardonly" },
      lineData: { flexMessage: { altText: "card", contents: { type: "bubble" } } },
      deps,
    });

    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining("nothing in this reply to line:user:1 can carry a quote"),
    );
  });

  it("sends unquoted when the answered message is not one this chat produced", async () => {
    recordLineQuoteToken({
      accountId: REPLY_ACCOUNT,
      chatId: "Celsewhere",
      messageId: "inbound-elsewhere",
      quoteToken: "token-elsewhere",
    });
    const { deps, replyMessageLine } = createDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "answering you", replyToId: "inbound-elsewhere" },
      lineData: {},
      deps,
    });

    expect(expectDefined(replyMessageLine.mock.calls[0]?.[1], "reply messages")).toEqual([
      { type: "text", text: "answering you" },
    ]);
  });

  it("sends unquoted when the reply answers nothing", async () => {
    const { deps, replyMessageLine } = createDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "unprompted" },
      lineData: {},
      deps,
    });

    expect(expectDefined(replyMessageLine.mock.calls[0]?.[1], "reply messages")).toEqual([
      { type: "text", text: "unprompted" },
    ]);
  });
});

describe("the push delivery path", () => {
  const cfg = { channels: { line: {} } } as OpenClawConfig;

  it("quotes the first chunk of a reply that answers a message", async () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Cpush",
      messageId: "inbound-push",
      quoteToken: "token-push",
    });
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    mocks.chunkMarkdownText.mockImplementation((text: string) => text.split("|"));

    await lineOutboundAdapter.sendPayload!({
      to: "line:group:Cpush",
      text: "first|second",
      payload: { text: "first|second" },
      replyToId: "inbound-push",
      accountId: "default",
      cfg,
    });

    expect(sentMessages(mocks).map((message) => [message.text, message.quoteToken])).toEqual([
      ["first", "token-push"],
      ["second", undefined],
    ]);
  });

  it("quotes the text that carries the quick replies when that is the only text", async () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Cquick",
      messageId: "inbound-quick",
      quoteToken: "token-quick",
    });
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);

    await lineOutboundAdapter.sendPayload!({
      to: "line:group:Cquick",
      text: "pick one",
      payload: { text: "pick one", channelData: { line: { quickReplies: ["Yes", "No"] } } },
      replyToId: "inbound-quick",
      accountId: "default",
      cfg,
    });

    expect(sentMessages(mocks)).toEqual([
      {
        type: "text",
        text: "pick one",
        quickReply: { items: ["Yes", "No"] },
        quoteToken: "token-quick",
      },
    ]);
  });

  it("quotes a plain-text send routed through the message adapter", async () => {
    // Core prefers plugin.message.send.text for a payload with no structured
    // content, so this is the path a gateway-driven plain reply actually takes.
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Cadapter",
      messageId: "inbound-adapter",
      quoteToken: "token-adapter",
    });
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);

    await lineMessageAdapter.send!.text!({
      cfg,
      to: "line:group:Cadapter",
      text: "answering you",
      replyToId: "inbound-adapter",
      accountId: "default",
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:group:Cadapter",
      [{ type: "text", text: "answering you", quoteToken: "token-adapter" }],
      { verbose: false, accountId: "default", cfg },
    );
  });

  it("quotes a media send routed through the message adapter", async () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Cmedia",
      messageId: "inbound-media",
      quoteToken: "token-media",
    });
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);

    await lineMessageAdapter.send!.media!({
      cfg,
      to: "line:group:Cmedia",
      text: "here you go",
      mediaUrl: "https://example.com/image.jpg",
      replyToId: "inbound-media",
      accountId: "default",
    });

    // The caption is the only part LINE lets a quote ride on; the image itself cannot.
    expect(sentMessages(mocks).map((message) => [message.type, message.quoteToken])).toEqual([
      ["text", "token-media"],
      ["image", undefined],
    ]);
  });

  it("quotes the first text of a reply whose leading part cannot carry a quote", async () => {
    // Markdown that opens with a code block becomes a Flex card followed by text,
    // so the quote has to find the first message LINE accepts one on rather than
    // ride on whatever came first.
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Cordered",
      messageId: "inbound-ordered",
      quoteToken: "token-ordered",
    });
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    mocks.resolveTextChunkLimit.mockReturnValue(5000);
    mocks.chunkMarkdownText.mockImplementation((text: string) =>
      chunkMarkdownTextForLine(text, 5000),
    );
    const markdown = "```js\nfirst()\n```\n\nAfter the card";

    await lineOutboundAdapter.sendPayload!({
      to: "line:group:Cordered",
      text: markdown,
      payload: { text: markdown },
      replyToId: "inbound-ordered",
      accountId: "default",
      cfg,
    });

    expect(sentMessages(mocks).map((message) => [message.type, message.quoteToken])).toEqual([
      ["flex", undefined],
      ["text", "token-ordered"],
    ]);
  });

  it("quotes the first message able to carry it even when an earlier request cannot", async () => {
    // Parts travel five to a request, so the first message LINE accepts a quote on
    // can sit in a later request than the reply's opening one.
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Clate",
      messageId: "inbound-late",
      quoteToken: "token-late",
    });
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    mocks.resolveTextChunkLimit.mockReturnValue(5000);
    mocks.chunkMarkdownText.mockImplementation((text: string) =>
      chunkMarkdownTextForLine(text, 5000),
    );
    const cards = Array.from({ length: 5 }, (_, index) => `\`\`\`js\ncard${index}()\n\`\`\``);
    const markdown = `${cards.join("\n\n")}\n\nAfter the cards`;

    await lineOutboundAdapter.sendPayload!({
      to: "line:group:Clate",
      text: markdown,
      payload: { text: markdown },
      replyToId: "inbound-late",
      accountId: "default",
      cfg,
    });

    const requests = mocks.pushMessagesLine.mock.calls.map((call) => call[1]);
    expect(requests.map((request) => request.map((message) => message.type))).toEqual([
      ["flex", "flex", "flex", "flex", "flex"],
      ["text"],
    ]);
    expect(requests[1]).toEqual([
      expect.objectContaining({ text: "After the cards", quoteToken: "token-late" }),
    ]);
  });

  it("reports a push that answered a message but could carry no quote", async () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Ccard",
      messageId: "inbound-card",
      quoteToken: "token-card",
    });
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    logVerboseMock.mockClear();

    await lineOutboundAdapter.sendPayload!({
      to: "line:group:Ccard",
      text: "",
      payload: {
        channelData: { line: { flexMessage: { altText: "card", contents: { type: "bubble" } } } },
      },
      replyToId: "inbound-card",
      accountId: "default",
      cfg,
    });

    expect(sentMessages(mocks).every((message) => !("quoteToken" in message))).toBe(true);
    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining("nothing in this reply to line:group:Ccard can carry a quote"),
    );
  });

  it("sends unquoted when the push answers nothing", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);

    await lineOutboundAdapter.sendPayload!({
      to: "line:group:Cplain",
      text: "just saying",
      payload: { text: "just saying" },
      accountId: "default",
      cfg,
    });

    expect(sentMessages(mocks)).toEqual([{ type: "text", text: "just saying" }]);
  });
});
