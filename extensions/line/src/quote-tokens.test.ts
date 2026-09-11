// Line tests cover quote token plugin behavior.
import type { messagingApi, webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  applyLineQuoteToken,
  canCarryLineQuoteToken,
  reportLineQuoteCarrierMissing,
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
  it("returns the token recorded for that message in that chat", () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Cgroup",
      messageId: "m-1",
      quoteToken: "token-1",
    });

    expect(
      resolveLineQuoteToken({ cfg, accountId: "default", chatId: "Cgroup", messageId: "m-1" }),
    ).toBe("token-1");
    expect(
      resolveLineQuoteToken({ cfg, accountId: "default", chatId: "Cgroup", messageId: "m-2" }),
    ).toBeUndefined();
    expect(
      resolveLineQuoteToken({ cfg, accountId: "default", chatId: "Cgroup", messageId: undefined }),
    ).toBeUndefined();
  });

  it("accepts the addressed forms of a chat id the send path is given", () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Caddressed",
      messageId: "m-addr",
      quoteToken: "token-addr",
    });

    for (const target of ["Caddressed", "line:Caddressed", "line:group:Caddressed"]) {
      expect(
        resolveLineQuoteToken({ cfg, accountId: "default", chatId: target, messageId: "m-addr" }),
      ).toBe("token-addr");
    }
  });

  it("refuses a token from another chat, which LINE rejects with the whole request", () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Corigin",
      messageId: "m-shared",
      quoteToken: "origin-token",
    });

    expect(
      resolveLineQuoteToken({
        cfg,
        accountId: "default",
        chatId: "Celsewhere",
        messageId: "m-shared",
      }),
    ).toBeUndefined();
  });

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

  it("says at verbose level why a reply target could not be quoted", () => {
    logVerboseMock.mockClear();
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Cknown",
      messageId: "m-known",
      quoteToken: "token-known",
    });

    resolveLineQuoteToken({ cfg, accountId: "default", chatId: "Cknown", messageId: "m-known" });
    expect(logVerboseMock).not.toHaveBeenCalled();

    resolveLineQuoteToken({ cfg, accountId: "default", chatId: "Cknown", messageId: "m-gone" });
    expect(logVerboseMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("account default remembers no quote token for Cknown|m-gone"),
    );
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

  it("forgets the oldest tokens once the bound is reached, keeping the newest", () => {
    for (let index = 0; index < 600; index += 1) {
      recordLineQuoteToken({
        accountId: "bulk",
        chatId: "Cbulk",
        messageId: `bulk-${index}`,
        quoteToken: `token-${index}`,
      });
    }

    expect(
      resolveLineQuoteToken({ cfg, accountId: "bulk", chatId: "Cbulk", messageId: "bulk-0" }),
    ).toBeUndefined();
    expect(
      resolveLineQuoteToken({ cfg, accountId: "bulk", chatId: "Cbulk", messageId: "bulk-599" }),
    ).toBe("token-599");
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

describe("canCarryLineQuoteToken", () => {
  it("names the outbound types LINE accepts a quote on", () => {
    // Asked of the platform: a type it allows answers "Quote token is invalid"
    // for a bad token, while any other answers "does not support quote message".
    const carriers: messagingApi.Message["type"][] = ["text", "textV2", "sticker"];
    const rest: messagingApi.Message["type"][] = [
      "flex",
      "image",
      "video",
      "audio",
      "location",
      "template",
      "imagemap",
    ];

    expect(carriers.filter((type) => canCarryLineQuoteToken({ type }))).toEqual(carriers);
    expect(rest.filter((type) => canCarryLineQuoteToken({ type }))).toEqual([]);
  });
});

describe("reportLineQuoteCarrierMissing", () => {
  it("names the chat whose reply could not carry the quote", () => {
    logVerboseMock.mockClear();
    reportLineQuoteCarrierMissing("Cgroup");

    expect(logVerboseMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("nothing in this reply to Cgroup can carry a quote"),
    );
  });
});

describe("applyLineQuoteToken", () => {
  const flex: messagingApi.Message = {
    type: "flex",
    altText: "card",
    contents: { type: "bubble" },
  };
  const text: messagingApi.Message = { type: "text", text: "hello" };
  const second: messagingApi.Message = { type: "text", text: "world" };

  it("quotes the first message LINE accepts a quote on, and only that one", () => {
    expect(applyLineQuoteToken([flex, text, second], "token")).toEqual([
      flex,
      { type: "text", text: "hello", quoteToken: "token" },
      second,
    ]);
  });

  it("quotes a textV2 message, which LINE also accepts a quote on", () => {
    const textV2: messagingApi.Message = { type: "textV2", text: "hello" };

    expect(applyLineQuoteToken([flex, textV2], "token")).toEqual([
      flex,
      { type: "textV2", text: "hello", quoteToken: "token" },
    ]);
  });

  it("leaves a request alone when no message can carry a quote", () => {
    const image: messagingApi.Message = {
      type: "image",
      originalContentUrl: "https://example.com/a.jpg",
      previewImageUrl: "https://example.com/a.jpg",
    };

    expect(applyLineQuoteToken([flex, image], "token")).toEqual([flex, image]);
  });

  it("leaves a request alone when there is no token to spend", () => {
    expect(applyLineQuoteToken([text], undefined)).toEqual([text]);
  });

  it("does not mutate the messages it was given", () => {
    const messages = [text];
    applyLineQuoteToken(messages, "token");

    expect(messages[0]).toEqual({ type: "text", text: "hello" });
  });
});

describe("withoutLineQuoteTokens", () => {
  const text: messagingApi.Message = { type: "text", text: "hello" };

  it("reports nothing to drop when the request carried no quote", () => {
    expect(withoutLineQuoteTokens([text])).toBeUndefined();
  });

  it("drops the quote and keeps the rest of the request intact", () => {
    const flex: messagingApi.Message = {
      type: "flex",
      altText: "card",
      contents: { type: "bubble" },
    };
    const quoted = applyLineQuoteToken([flex, text], "token");

    expect(withoutLineQuoteTokens(quoted)).toEqual([flex, text]);
  });

  it("leaves the request it was given quoted", () => {
    const quoted = applyLineQuoteToken([text], "token");
    withoutLineQuoteTokens(quoted);

    expect(quoted[0]).toEqual({ type: "text", text: "hello", quoteToken: "token" });
  });
});
