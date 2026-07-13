import { describe, expect, it } from "vitest";
import { canonicalizeVoiceCallMediaBase64, decodeVoiceCallMediaBase64 } from "./media-base64.js";
import {
  TelnyxStreamFrameAdapter,
  TwilioStreamFrameAdapter,
} from "./webhook/stream-frame-adapter.js";

describe("voice-call media base64", () => {
  it("canonicalizes and decodes valid media payloads", () => {
    expect(canonicalizeVoiceCallMediaBase64(" aGVs bG8 \n")).toBe("aGVsbG8=");
    expect(decodeVoiceCallMediaBase64("aGVsbG8", "test").toString("utf8")).toBe("hello");
  });

  it("rejects malformed media payloads instead of letting Buffer decode partial bytes", () => {
    expect(canonicalizeVoiceCallMediaBase64("aGVsbG8!")).toBeUndefined();
    expect(() => decodeVoiceCallMediaBase64("aGVsbG8!", "test")).toThrow(
      "test media payload was not valid base64",
    );
  });

  it.each([new TwilioStreamFrameAdapter(), new TelnyxStreamFrameAdapter()])(
    "validates and canonicalizes provider media frames",
    (adapter) => {
      expect(
        adapter.parseInbound(JSON.stringify({ event: "media", media: { payload: "AAA@@@" } })),
      ).toEqual({ kind: "ignored" });
      expect(
        adapter.parseInbound(JSON.stringify({ event: "media", media: { payload: " AA A \n" } })),
      ).toEqual({ kind: "media", payloadBase64: "AAA=" });
    },
  );
});
