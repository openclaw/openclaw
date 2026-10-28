import { expectDefined } from "@openclaw/normalization-core";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi } from "vitest";
import type { ReplyPayload } from "../api.js";
import { createDeps } from "./auto-reply-delivery.test-helpers.js";
import { createRuntime } from "./channel.sendPayload.test-support.js";
import { deliver } from "./delivery.test-support.js";
import { lineMessageAdapter, lineOutboundAdapter } from "./outbound.js";
import { recordLineQuoteToken } from "./quote-tokens.js";
import { setLineRuntime } from "./runtime.js";

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose: vi.fn(),
  danger: (t: string) => t,
}));

function remember(messageId: string, chatId = "1", accountId = "acc") {
  recordLineQuoteToken({ accountId, chatId, messageId, quoteToken: `token-${messageId}` });
}
function pushReply(chat: string) {
  remember(chat, `C${chat}`, "default");
  const { runtime, mocks } = createRuntime();
  setLineRuntime(runtime);
  const context = {
    cfg: { channels: { line: {} } },
    to: `line:group:C${chat}`,
    replyToId: chat,
    accountId: "default",
  };
  return {
    mocks,
    context,
    send: (payload: ReplyPayload) =>
      lineOutboundAdapter.sendPayload!({ ...context, text: payload.text ?? "", payload }),
  };
}
const lineData = { flexMessage: { altText: "card", contents: { type: "bubble" as const } } };

it("quotes only the first quotable message in a reply-token batch", async () => {
  remember("multi");
  const { replyMessageLine } = createDeps({ chunkMarkdownText: (text) => text.split("|") });
  await deliver({ text: "first|second|third", replyToId: "multi" }, lineData);
  const messages = expectDefined(replyMessageLine.mock.calls[0]?.[1], "reply messages");
  expect(messages.map((message) => "quoteToken" in message)).toEqual([true, false, false, false]);
  expect(messages[0]).toMatchObject({ type: "text", text: "first", quoteToken: "token-multi" });
});

it.each(["no carrier", "another chat"] as const)(
  "sends an unquoted reply for %s",
  async (reason) => {
    const noCarrier = reason === "no carrier";
    remember(reason, noCarrier ? "1" : "Celsewhere");
    const { replyMessageLine } = createDeps();
    await deliver(
      { replyToId: reason, ...(noCarrier ? {} : { text: "answering you" }) },
      noCarrier ? lineData : {},
    );
    const messages = expectDefined(replyMessageLine.mock.calls[0]?.[1], "reply messages");
    expect(messages.every((message) => !("quoteToken" in message))).toBe(true);
    if (!noCarrier) {
      expect(messages).toEqual([{ type: "text", text: "answering you" }]);
    }
  },
);

it("quotes only the first chunk through the text message adapter", async () => {
  const { context, mocks } = pushReply("push");
  mocks.chunkMarkdownText.mockImplementation((text: string) => text.split("|"));
  await lineMessageAdapter.send!.text!({ ...context, text: "first|second" });
  expect(mocks.pushMessageLine.mock.calls.map((args) => [args[1], args[2].quoteToken])).toEqual([
    ["first", "token-push"],
    ["second", undefined],
  ]);
});

it("quotes the text that carries quick replies", async () => {
  const { send, mocks } = pushReply("quick");
  await send({ text: "pick one", channelData: { line: { quickReplies: ["Yes", "No"] } } });
  expect(mocks.pushTextMessageWithQuickReplies).toHaveBeenCalledWith(
    "line:group:Cquick",
    "pick one",
    ["Yes", "No"],
    expect.objectContaining({ quoteToken: "token-quick" }),
  );
});

it("quotes a media caption but never its image", async () => {
  const { context, mocks } = pushReply("media");
  const mediaUrl = "https://example.com/image.jpg";
  await lineMessageAdapter.send!.media!({ ...context, text: "here you go", mediaUrl });
  expect(
    mocks.pushMessageLine.mock.calls.map(([, text, options]) => [
      text,
      options.mediaUrl,
      options.quoteToken,
    ]),
  ).toEqual([
    ["here you go", undefined, "token-media"],
    ["", mediaUrl, undefined],
  ]);
  expect(expectDefined(mocks.pushMessageLine.mock.calls[1], "media push")[2]).not.toHaveProperty(
    "quoteToken",
  );
});

it("quotes text after a leading non-quotable card", async () => {
  const { send, mocks } = pushReply("ordered");
  mocks.resolveTextChunkLimit.mockReturnValue(5000);
  mocks.chunkMarkdownText.mockImplementation((text: string) => chunkMarkdownText(text, 5000));
  await send({ text: "```js\nfirst()\n```\n\nAfter the card" });
  expect(mocks.pushFlexMessage).toHaveBeenCalledOnce();
  expect(mocks.pushMessageLine).toHaveBeenCalledWith(
    "line:group:Cordered",
    "After the card",
    expect.objectContaining({ quoteToken: "token-ordered" }),
  );
});
