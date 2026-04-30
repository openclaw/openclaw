import { describe, expect, it } from "vitest";
import {
  parseVesicleWebhookPayload,
  signVesicleWebhookBody,
  verifyVesicleWebhookSignature,
} from "./webhook.js";

describe("Vesicle webhook security", () => {
  it("verifies Vesicle HMAC signatures with and without the sha256 prefix", () => {
    const body = JSON.stringify({
      messageGuid: "msg-1",
      chatGuid: "iMessage;-;+15551234567",
      sender: "+15551234567",
      text: "hello",
    });
    const signature = signVesicleWebhookBody(body, "secret");

    expect(verifyVesicleWebhookSignature({ body, secret: "secret", signature })).toBe(true);
    expect(
      verifyVesicleWebhookSignature({
        body,
        secret: "secret",
        signature: signature.replace(/^sha256=/, ""),
      }),
    ).toBe(true);
    expect(verifyVesicleWebhookSignature({ body, secret: "wrong", signature })).toBe(false);
  });
});

describe("parseVesicleWebhookPayload", () => {
  it("parses the native Vesicle inbound envelope", () => {
    const parsed = parseVesicleWebhookPayload(
      JSON.stringify({
        messageGuid: "msg-1",
        chatGuid: "iMessage;+;chat123",
        isGroup: true,
        sender: "+15551234567",
        service: "iMessage",
        date: 1_777_000_000,
        text: "hello",
        isFromMe: false,
        rowId: 42,
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      message: {
        messageGuid: "msg-1",
        chatGuid: "iMessage;+;chat123",
        isGroup: true,
        sender: "+15551234567",
        service: "iMessage",
        date: 1_777_000_000,
        text: "hello",
        isFromMe: false,
        rowId: 42,
      },
    });
  });

  it("rejects payloads without required message identity fields", () => {
    expect(parseVesicleWebhookPayload(JSON.stringify({ text: "hello" }))).toEqual({
      ok: false,
      error: "missing required message fields",
    });
  });
});
