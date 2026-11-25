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
const record = (accountId: string, chatId: string, messageId: string, quoteToken?: string) =>
  recordLineQuoteToken({ accountId, chatId, messageId, quoteToken });
const resolve = (accountId: string | undefined, chatId: string, messageId: string) =>
  resolveLineQuoteToken({ cfg, accountId, chatId, messageId });

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
    record("work", "Cshared", "m-both", "work-token");
    record("personal", "Cshared", "m-both", "personal-token");
    expect(resolve("work", "Cshared", "m-both")).toBe("work-token");
    expect(resolve("personal", "Cshared", "m-both")).toBe("personal-token");
  });

  it("reads the account the send itself resolves to when none is named", () => {
    record("default", "Cdefault", "m-default", "default-token");
    expect(resolve(undefined, "Cdefault", "m-default")).toBe("default-token");
  });

  it("records nothing for a message kind that carries no token", () => {
    record("default", "Cnone", "m-none");
    expect(resolve("default", "Cnone", "m-none")).toBeUndefined();
  });

  it("keeps a quiet account's tokens while a busy account fills its own bound", () => {
    record("quiet", "Cquiet", "quiet-1", "quiet-token");
    for (let index = 0; index < 2000; index += 1) {
      record("busy", "Cbusy", `busy-${index}`, `busy-token-${index}`);
    }
    expect(resolve("quiet", "Cquiet", "quiet-1")).toBe("quiet-token");
    expect(resolve("busy", "Cbusy", "busy-0")).toBeUndefined();
    expect(resolve("busy", "Cbusy", "busy-1999")).toBe("busy-token-1999");
  });

  it("re-quoting a message replaces its token and moves it out of eviction range", () => {
    record("refresh", "Crefresh", "kept", "old-token");
    for (let index = 0; index < 499; index += 1) {
      record("refresh", "Crefresh", `filler-${index}`, `filler-token-${index}`);
    }
    record("refresh", "Crefresh", "kept", "new-token");
    for (let index = 0; index < 400; index += 1) {
      record("refresh", "Crefresh", `later-${index}`, `later-token-${index}`);
    }
    expect(resolve("refresh", "Crefresh", "kept")).toBe("new-token");
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
