import { describe, expect, it } from "vitest";
import type { WebhookContext } from "../types.js";
import { TelnyxProvider } from "./telnyx.js";

function createCtx(params?: Partial<WebhookContext>): WebhookContext {
  return {
    headers: {},
    rawBody: "{}",
    url: "http://localhost/voice/webhook",
    method: "POST",
    query: {},
    remoteAddress: "127.0.0.1",
    ...params,
  };
}

describe("TelnyxProvider.verifyWebhook", () => {
  it("fails closed when public key is missing and skipVerification is false", () => {
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: undefined },
      { skipVerification: false },
    );

    const result = provider.verifyWebhook(createCtx());
    expect(result.ok).toBe(false);
  });

  it("allows requests when skipVerification is true (development only)", () => {
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: undefined },
      { skipVerification: true },
    );

    const result = provider.verifyWebhook(createCtx());
    expect(result.ok).toBe(true);
  });

  it("fails when signature headers are missing (with public key configured)", () => {
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: "public-key" },
      { skipVerification: false },
    );

    const result = provider.verifyWebhook(createCtx({ headers: {} }));
    expect(result.ok).toBe(false);
  });
});
