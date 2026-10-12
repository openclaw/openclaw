// Line tests cover quote token plugin behavior.
import type { messagingApi, webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  applyLineQuoteToken,
  readLineQuoteToken,
  recordLineQuoteToken,
  resolveLineQuoteToken,
  withoutLineQuoteTokens,
} from "./quote-tokens.js";

const logVerboseMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({ logVerbose: logVerboseMock }));

const cfg = {} as OpenClawConfig;

describe("readLineQuoteToken", () => {
  it("reads the token from every message kind LINE lets a person quote", () => {
    const quotable: webhook.MessageEvent["message"][] = [
      { type: "text", id: "1", text: "hi", quoteToken: "text-token" },
      {
        type: "image",
        id: "2",
        quoteToken: "image-token",
        contentProvider: { type: "line" },
      },
      { type: "video", id: "3", quoteToken: "video-token", contentProvider: { type: "line" } },
      {
        type: "sticker",
        id: "4",
        quoteToken: "sticker-token",
        packageId: "p",
        stickerId: "s",
        stickerResourceType: "STATIC",
      },
    ];

    expect(quotable.map(readLineQuoteToken)).toEqual([
      "text-token",
      "image-token",
      "video-token",
      "sticker-token",
    ]);
  });

  it("has no token for the message kinds LINE does not attach one to", () => {
    const audio: webhook.MessageEvent["message"] = {
      type: "audio",
      id: "5",
      duration: 1,
      contentProvider: { type: "line" },
    };
    const location: webhook.MessageEvent["message"] = {
      type: "location",
      id: "6",
      latitude: 1,
      longitude: 2,
    };

    expect(readLineQuoteToken(audio)).toBeUndefined();
    expect(readLineQuoteToken(location)).toBeUndefined();
  });
});

describe("the quote token store", () => {
  it("keeps accounts apart, because a token belongs to the channel that issued it", () => {
    recordLineQuoteToken({
      accountId: "work",
      chatId: "Cshared",
      messageId: "m-both",
      quoteToken: "work-token",
    });
    recordLineQuoteToken({
      accountId: "personal",
      chatId: "Cshared",
      messageId: "m-both",
      quoteToken: "personal-token",
    });

    expect(
      resolveLineQuoteToken({ cfg, accountId: "work", chatId: "Cshared", messageId: "m-both" }),
    ).toBe("work-token");
    expect(
      resolveLineQuoteToken({ cfg, accountId: "personal", chatId: "Cshared", messageId: "m-both" }),
    ).toBe("personal-token");
  });

  it("reads the account the send itself resolves to when none is named", () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Cdefault",
      messageId: "m-default",
      quoteToken: "default-token",
    });

    expect(
      resolveLineQuoteToken({
        cfg,
        accountId: undefined,
        chatId: "Cdefault",
        messageId: "m-default",
      }),
    ).toBe("default-token");
  });

  it("records nothing for a message kind that carries no token", () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Cnone",
      messageId: "m-none",
      quoteToken: undefined,
    });

    expect(
      resolveLineQuoteToken({ cfg, accountId: "default", chatId: "Cnone", messageId: "m-none" }),
    ).toBeUndefined();
  });

  it("keeps a quiet account's tokens while a busy account fills its own bound", () => {
    recordLineQuoteToken({
      accountId: "quiet",
      chatId: "Cquiet",
      messageId: "quiet-1",
      quoteToken: "quiet-token",
    });
    for (let index = 0; index < 2000; index += 1) {
      recordLineQuoteToken({
        accountId: "busy",
        chatId: "Cbusy",
        messageId: `busy-${index}`,
        quoteToken: `busy-token-${index}`,
      });
    }

    expect(
      resolveLineQuoteToken({ cfg, accountId: "quiet", chatId: "Cquiet", messageId: "quiet-1" }),
    ).toBe("quiet-token");
    expect(
      resolveLineQuoteToken({ cfg, accountId: "busy", chatId: "Cbusy", messageId: "busy-0" }),
    ).toBeUndefined();
    expect(
      resolveLineQuoteToken({ cfg, accountId: "busy", chatId: "Cbusy", messageId: "busy-1999" }),
    ).toBe("busy-token-1999");
  });

  it("re-quoting a message replaces its token and moves it out of eviction range", () => {
    recordLineQuoteToken({
      accountId: "refresh",
      chatId: "Crefresh",
      messageId: "kept",
      quoteToken: "old-token",
    });
    for (let index = 0; index < 499; index += 1) {
      recordLineQuoteToken({
        accountId: "refresh",
        chatId: "Crefresh",
        messageId: `filler-${index}`,
        quoteToken: `filler-token-${index}`,
      });
    }
    recordLineQuoteToken({
      accountId: "refresh",
      chatId: "Crefresh",
      messageId: "kept",
      quoteToken: "new-token",
    });
    for (let index = 0; index < 400; index += 1) {
      recordLineQuoteToken({
        accountId: "refresh",
        chatId: "Crefresh",
        messageId: `later-${index}`,
        quoteToken: `later-token-${index}`,
      });
    }

    expect(
      resolveLineQuoteToken({ cfg, accountId: "refresh", chatId: "Crefresh", messageId: "kept" }),
    ).toBe("new-token");
  });
});

describe("withoutLineQuoteTokens", () => {
  const text: messagingApi.Message = { type: "text", text: "hello" };

  it("drops the quote and keeps the rest of the request intact", () => {
    const flex: messagingApi.Message = {
      type: "flex",
      altText: "card",
      contents: { type: "bubble" },
    };
    const quoted = applyLineQuoteToken([flex, text], "token");

    expect(withoutLineQuoteTokens(quoted)).toEqual([flex, text]);
  });
});
