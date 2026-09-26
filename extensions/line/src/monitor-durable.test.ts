// Line tests cover monitor durable plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveLineDurableReplyOptions } from "./monitor-durable.js";

describe("resolveLineDurableReplyOptions", () => {
  it("enables durable final delivery for push-only text replies", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "final",
        to: "U123",
        replyToken: "reply-token",
        replyTokenUsed: true,
      }),
      // No requiredCapabilities or reply-to: core derives both from the payload and
      // the turn context, and naming them again would mirror that from fewer inputs.
    ).toEqual({ to: "U123" });
  });

  it("keeps unused reply-token delivery on the legacy path", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "final",
        to: "U123",
        replyToken: "reply-token",
        replyTokenUsed: false,
      }),
    ).toBe(false);
  });

  it("keeps a reply that answers a message on the durable path", () => {
    // The adapter declares replyTo and quotes the answered message, so answering one
    // must not push the reply inline, where a crash cannot be recovered.
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello", replyToId: "630776817589944423" },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toEqual({ to: "U123" });
  });

  it("keeps rich and media replies on the legacy path", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello", channelData: { line: { quickReplies: ["One"] } } },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "photo", mediaUrl: "https://example.com/image.png" },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
  });

  it("keeps non-final and empty replies on the legacy path", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "block",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "" },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
  });
});
