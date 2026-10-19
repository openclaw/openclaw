import crypto from "node:crypto";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import type { WebhookContext, WebhookVerificationResult } from "./types.js";
import {
  reconstructWebhookUrl,
  verifyPlivoWebhook,
  verifyTelnyxWebhook,
  verifyTwilioWebhook,
} from "./webhook-security.js";

const authToken = "test-auth-token";
const publicUrl = "https://example.com/voice/webhook";
const twilioBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
const plivoBody = "CallUUID=uuid&CallStatus=in-progress&From=%2B15550000000";

function context(overrides: Partial<WebhookContext> = {}): WebhookContext {
  return { headers: {}, rawBody: "", url: publicUrl, method: "POST", ...overrides };
}

function plivoV3Headers(canonicalBase: string, nonce: string) {
  return {
    host: "example.com",
    "x-forwarded-proto": "https",
    "x-plivo-signature-v3": crypto
      .createHmac("sha256", authToken)
      .update(`${canonicalBase}.${nonce}`)
      .digest("base64"),
    "x-plivo-signature-v3-nonce": nonce,
  };
}

function twilioSignature(url: string, postBody = twilioBody): string {
  let dataToSign = url;
  const sortedParams = Array.from(new URLSearchParams(postBody).entries()).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  );

  for (const [key, value] of sortedParams) {
    dataToSign += key + value;
  }

  return crypto.createHmac("sha1", authToken).update(dataToSign).digest("base64");
}

function expectReplay(first: WebhookVerificationResult, second: WebhookVerificationResult) {
  expect(first.ok).toBe(true);
  expect(first.isReplay).not.toBe(true);
  if (!first.verifiedRequestKey) {
    throw new Error("verified webhook request did not produce a request key");
  }
  expect(second.ok).toBe(true);
  expect(second.isReplay).toBe(true);
  expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
  expect(first.releaseReplay).toEqual(expect.any(Function));
  expect(second.releaseReplay).toBeUndefined();
}

function verifyTwilio(
  overrides: Partial<WebhookContext>,
  options?: Parameters<typeof verifyTwilioWebhook>[2],
) {
  return verifyTwilioWebhook(context({ rawBody: twilioBody, ...overrides }), authToken, options);
}

function createSignedTelnyxWebhookRequest(options?: { timestamp?: string }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pemPublicKey = publicKey.export({ format: "pem", type: "spki" });
  const timestamp = options?.timestamp ?? String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({
    data: { event_type: "call.initiated", payload: { call_control_id: "call-1" } },
    nonce: crypto.randomUUID(),
  });
  const signedPayload = `${timestamp}|${rawBody}`;
  const signature = crypto.sign(null, Buffer.from(signedPayload), privateKey).toString("base64");

  return {
    pemPublicKey,
    signature,
    makeCtx(signatureValue = signature) {
      return context({
        headers: {
          "telnyx-signature-ed25519": signatureValue,
          "telnyx-timestamp": timestamp,
        },
        rawBody,
      });
    },
  };
}

const skipVerificationRequestKeyCases = [
  {
    name: "Plivo",
    prefix: /^plivo:skip:/,
    ctx: context({ rawBody: "CallUUID=uuid&CallStatus=in-progress" }),
    verify: (ctx: WebhookContext) => verifyPlivoWebhook(ctx, "token", { skipVerification: true }),
  },
  {
    name: "Telnyx",
    prefix: /^telnyx:skip:/,
    ctx: context({ rawBody: JSON.stringify({ data: { event_type: "call.initiated" } }) }),
    verify: (ctx: WebhookContext) =>
      verifyTelnyxWebhook(ctx, undefined, { skipVerification: true }),
  },
];

describe("skip verification request keys", () => {
  it.each(skipVerificationRequestKeyCases)(
    "$name returns a stable request key when verification is skipped",
    ({ prefix, ctx, verify }) => {
      const first = verify(ctx);
      const second = verify(ctx);

      expect(first.ok).toBe(true);
      expect(first.verifiedRequestKey).toMatch(prefix);
      expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
      expect(second.isReplay).toBe(true);
    },
  );

  it("does not keep replay keys whose expiry would exceed the Date range", () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
    const verify = () =>
      verifyTwilio(
        { rawBody: "CallSid=CS-overflow&CallStatus=completed" },
        { skipVerification: true },
      );

    try {
      const first = verify();
      expect(first.ok).toBe(true);
      expect(first.isReplay).not.toBe(true);

      dateNow.mockReturnValue(Date.parse("2026-05-29T12:00:00.000Z"));
      const second = verify();
      expect(second.ok).toBe(true);
      expect(second.isReplay).not.toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe("verifyPlivoWebhook", () => {
  it.each([
    ["GET", "?q=x", "Foo=y", "?q=x."],
    [
      "POST",
      "",
      "toString=z&__proto__=b&constructor=c&__proto__=a",
      "?__proto__a__proto__bconstructorctoStringz",
    ],
    [
      "POST",
      "?2=x&10=y&b=%2B&a=hello+world&%C3%A4=z",
      "Tag=z&Tag=a&Tag=a&Raw=%26%3D&Tag=hello+world&Tag=%C3%A4",
      "?10=y&2=x&a=hello world&b=+&ä=z.Raw&=TagaTagaTaghello worldTagzTagä",
    ],
  ] as const)(
    "accepts valid V3 signature (including multi-signature header): %s %s %s",
    (method, query, rawBody, suffix) => {
      const nonce = `literal-${method}-${query}-${rawBody}`;
      const canonicalBase = publicUrl + suffix;
      const headers = plivoV3Headers(canonicalBase, nonce);
      const ctx = context({
        headers: {
          ...headers,
          "x-plivo-signature-v3": `bad, ${headers["x-plivo-signature-v3"]}`,
        },
        rawBody,
        url: publicUrl + query,
        method,
      });
      const first = verifyPlivoWebhook(ctx, authToken);
      const second = verifyPlivoWebhook(ctx, authToken);

      expectReplay(first, second);
      expect(first).toMatchObject({
        version: "v3",
        verifiedRequestKey: `plivo:v3:${crypto.createHash("sha256").update(`${canonicalBase}\n${nonce}`).digest("hex")}`,
      });
      first.releaseReplay?.();
      expect(
        verifyPlivoWebhook(
          { ...ctx, headers: { ...ctx.headers, "x-plivo-signature-v3": "invalid" } },
          authToken,
        ),
      ).toMatchObject({ ok: false, version: "v3", reason: "Invalid Plivo V3 signature" });
    },
  );

  it("pins Plivo publicUrl verification to the configured path", () => {
    const nonce = "nonce-public-url-path";
    const attackerPathUrl = "https://voice.openclaw.ai/admin?flow=answer&callId=abc";
    const result = verifyPlivoWebhook(
      context({
        headers: {
          ...plivoV3Headers(
            "https://voice.openclaw.ai/admin?callId=abc&flow=answer.CallStatusin-progressCallUUIDuuidFrom+15550000000",
            nonce,
          ),
          host: "voice.openclaw.ai",
        },
        rawBody: plivoBody,
        url: attackerPathUrl,
        query: { flow: "answer", callId: "abc" },
      }),
      authToken,
      { publicUrl: "https://voice.openclaw.ai/voice/webhook?provider=plivo" },
    );

    expect(result).toMatchObject({
      ok: false,
      version: "v3",
      verificationUrl: "https://voice.openclaw.ai/voice/webhook?flow=answer&callId=abc",
    });
  });

  it("matches trusted proxies for Plivo when Node reports an IPv4-mapped remote address", () => {
    const nonce = "nonce-ipv4-mapped-plivo";
    const webhookUrl = "https://proxy.example.com/voice/webhook?flow=answer&callId=abc";
    const result = verifyPlivoWebhook(
      context({
        headers: {
          ...plivoV3Headers(
            "https://proxy.example.com/voice/webhook?callId=abc&flow=answer.CallStatusin-progressCallUUIDuuidFrom+15550000000",
            nonce,
          ),
          host: "localhost:3000",
          "x-forwarded-host": "proxy.example.com",
        },
        rawBody: plivoBody,
        url: "http://localhost:3000/voice/webhook?flow=answer&callId=abc",
        query: { flow: "answer", callId: "abc" },
        remoteAddress: "::ffff:127.0.0.1",
      }),
      authToken,
      { trustForwardingHeaders: true, trustedProxyIPs: ["127.0.0.1"] },
    );

    expect(result).toMatchObject({ ok: true, version: "v3", verificationUrl: webhookUrl });
  });

  it("rejects missing signatures", () => {
    const result = verifyPlivoWebhook(
      context({ headers: { host: "example.com", "x-forwarded-proto": "https" } }),
      "token",
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Missing Plivo signature headers/);
  });

  it("treats query-only V2 variants as the same verified request", () => {
    const nonce = "nonce-replay-v2";
    const headers = {
      host: "example.com",
      "x-forwarded-proto": "https",
      "x-plivo-signature-v2": crypto
        .createHmac("sha256", authToken)
        .update(publicUrl + nonce)
        .digest("base64"),
      "x-plivo-signature-v2-nonce": nonce,
    };
    const verify = (flow: string) =>
      verifyPlivoWebhook(
        context({
          headers,
          rawBody: "CallUUID=uuid&CallStatus=in-progress",
          url: `${publicUrl}?flow=${flow}&callId=abc`,
          query: { flow, callId: "abc" },
        }),
        authToken,
      );
    const first = verify("answer");
    const second = verify("getinput");

    expect(first.verifiedRequestKey).toBeTypeOf("string");
    expectReplay(first, second);
  });
});

describe("verifyTelnyxWebhook", () => {
  it("rejects signed timestamps with trailing characters", () => {
    const request = createSignedTelnyxWebhookRequest({
      timestamp: `${Math.floor(Date.now() / 1000)}abc`,
    });

    expect(verifyTelnyxWebhook(request.makeCtx(), request.pemPublicKey)).toEqual({
      ok: false,
      reason: "Invalid timestamp header",
    });
  });

  it("treats Base64 and Base64URL signatures as the same replayed request", () => {
    const request = createSignedTelnyxWebhookRequest();
    const urlSafeSignature = request.signature
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const first = verifyTelnyxWebhook(request.makeCtx(), request.pemPublicKey);
    const second = verifyTelnyxWebhook(request.makeCtx(urlSafeSignature), request.pemPublicKey);

    expectReplay(first, second);
  });
});

describe("reconstructWebhookUrl", () => {
  it.each(["[::1]evil", "[not-ipv6]:8443"])(
    "rejects malformed bracketed Host value %s and falls back to the request URL",
    (host) => {
      const fallbackUrl = "https://fallback.example/voice/webhook?callId=ipv6";
      const verificationUrl = reconstructWebhookUrl(
        context({ headers: { host }, url: fallbackUrl }),
      );

      expect(verificationUrl).toBe(fallbackUrl);
    },
  );

  it("skips a scoped forwarded IPv6 host and uses the direct Host fallback", () => {
    const verificationUrl = reconstructWebhookUrl(
      context({
        headers: {
          host: "fallback.example",
          "x-forwarded-host": "[fe80::1%25eth0]",
        },
        url: "http://localhost:3000/voice/webhook?callId=ipv6",
      }),
      { trustForwardingHeaders: true },
    );

    expect(verificationUrl).toBe("https://fallback.example/voice/webhook?callId=ipv6");
  });
});

describe("verifyTwilioWebhook", () => {
  it("verifies a signature reconstructed from an allowed bracketed IPv6 proxy host", () => {
    const postBody = "CallSid=CS-IPV6&CallStatus=completed";
    const webhookUrl = "https://[2001:db8::1]/voice/webhook?callId=ipv6";
    const signature = twilioSignature(webhookUrl, postBody);

    const verify = (idempotencyToken: string) =>
      verifyTwilio(
        {
          headers: {
            host: "localhost:3000",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "[2001:db8::1]:8443",
            "x-twilio-signature": signature,
            "i-twilio-idempotency-token": idempotencyToken,
          },
          rawBody: postBody,
          url: "http://localhost:3000/voice/webhook?callId=ipv6",
        },
        { allowedHosts: ["[2001:0db8:0000:0000:0000:0000:0000:0001]"] },
      );
    const result = verify("first");

    expect(result).toMatchObject({ ok: true, verificationUrl: webhookUrl });
    expectReplay(result, verify("changed"));
  });

  it("uses the configured public path with the request query", () => {
    const configuredUrl = "https://example.com/proxy/voice/webhook";
    const urlWithQuery = `${configuredUrl}?callId=abc`;
    const verifySignedUrl = (signedUrl: string) =>
      verifyTwilio(
        {
          headers: {
            host: "example.com",
            "x-forwarded-proto": "https",
            "x-twilio-signature": twilioSignature(signedUrl),
          },
          url: "http://local/voice/webhook?callId=abc",
          query: { callId: "abc" },
        },
        { publicUrl: configuredUrl },
      );

    const result = verifySignedUrl(urlWithQuery);
    expect(result).toMatchObject({ ok: true, verificationUrl: urlWithQuery });

    const localPathResult = verifySignedUrl("https://example.com/voice/webhook?callId=abc");
    expect(localPathResult.ok).toBe(false);
    expect(localPathResult.reason).toContain(`${configuredUrl}?callId=***`);
  });

  it("redacts query params from invalid Twilio signature diagnostics", () => {
    const result = verifyTwilio(
      {
        headers: {
          host: "example.com",
          "x-twilio-signature": "invalid",
        },
        url: "https://example.com/voice/webhook?callId=call-1&turnToken=secret-turn-token",
        query: { callId: "call-1", turnToken: "secret-turn-token" },
      },
      { publicUrl: "https://user:pass@example.com/callback#fragment-secret" },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Invalid signature for URL:");
    expect(result.reason).toContain("turnToken=***");
    expect(result.reason).toContain("callId=***");
    expect(result.reason).not.toContain("secret-turn-token");
    expect(result.reason).not.toContain("user:pass");
    expect(result.reason).not.toContain("fragment-secret");
  });

  it("does not echo malformed verification URLs in diagnostics", () => {
    const result = verifyTwilio(
      {
        headers: { "x-twilio-signature": "invalid" },
        rawBody: "CallSid=CS123",
        url: "https://local/voice/webhook",
      },
      { publicUrl: "not a url?turnToken=secret-turn-token" },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "Invalid signature for URL: <invalid verification URL>",
    });
    expect(result.reason).not.toContain("secret-turn-token");
  });

  it("does not allow invalid signatures for ngrok free tier on loopback", () => {
    const result = verifyTwilio(
      {
        headers: {
          host: "127.0.0.1:3334",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "local.ngrok-free.app",
          "x-twilio-signature": "invalid",
        },
        url: "http://127.0.0.1:3334/voice/webhook",
        remoteAddress: "127.0.0.1",
      },
      { allowNgrokFreeTierLoopbackBypass: true },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Invalid signature/);
    expect(result.isNgrokFreeTier).toBe(true);
  });

  it("ignores attacker X-Forwarded-Host without allowedHosts or trustForwardingHeaders", () => {
    const result = verifyTwilio({
      headers: {
        host: "legitimate.example.com",
        "x-forwarded-host": "attacker.evil.com",
        "x-twilio-signature": "invalid",
      },
      url: "http://localhost:3000/voice/webhook",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("https://legitimate.example.com/voice/webhook");
    expect(result.verificationUrl).toBeUndefined();
  });

  it("rejects X-Forwarded-Host not in allowedHosts whitelist", () => {
    const result = verifyTwilio(
      {
        headers: {
          host: "localhost:3000",
          "x-forwarded-host": "attacker.evil.com",
          "x-twilio-signature": "invalid",
        },
        url: "http://localhost:3000/voice/webhook",
      },
      { allowedHosts: ["myapp.ngrok.io", "webhook.example.com"] },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("https://localhost/voice/webhook");
    expect(result.verificationUrl).toBeUndefined();
  });

  it("ignores forwarding headers when trustedProxyIPs are set but remote IP is missing", () => {
    const result = verifyTwilio(
      {
        headers: {
          host: "legitimate.example.com",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "proxy.example.com",
          "x-twilio-signature": "invalid",
        },
        url: "http://localhost:3000/voice/webhook",
      },
      { trustForwardingHeaders: true, trustedProxyIPs: ["203.0.113.10"] },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("https://legitimate.example.com/voice/webhook");
    expect(result.verificationUrl).toBeUndefined();
  });
  it("succeeds when Twilio signs URL without port but server URL has port", () => {
    const urlWithPort = "https://example.com:8443/voice/webhook";
    const signedUrl = "https://example.com/voice/webhook";
    const result = verifyTwilio(
      {
        headers: {
          host: "example.com:8443",
          "x-twilio-signature": twilioSignature(signedUrl),
        },
        url: urlWithPort,
      },
      { publicUrl: urlWithPort },
    );

    expect(result).toMatchObject({ ok: true, verificationUrl: signedUrl });
    expect(result.verifiedRequestKey).toMatch(/^twilio:req:/);
  });
});
