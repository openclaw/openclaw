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
const directHeaders = { host: "example.com", "x-forwarded-proto": "https" };

function context(overrides: Partial<WebhookContext> = {}): WebhookContext {
  return { headers: {}, rawBody: "", url: publicUrl, method: "POST", ...overrides };
}

function plivoV3Headers(canonicalBase: string, nonce: string) {
  return {
    ...directHeaders,
    "x-plivo-signature-v3": hmac("sha256", `${canonicalBase}.${nonce}`),
    "x-plivo-signature-v3-nonce": nonce,
  };
}

function hmac(algorithm: string, data: string) {
  return crypto.createHmac(algorithm, authToken).update(data).digest("base64");
}

function twilioSignature(url: string, postBody = twilioBody): string {
  const sortedParams = Array.from(new URLSearchParams(postBody).entries()).toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  );

  return hmac("sha1", url + sortedParams.map(([key, value]) => key + value).join(""));
}

function expectReplay(first: WebhookVerificationResult, second: WebhookVerificationResult) {
  expect(first.ok).toBe(true);
  expect(first.isReplay).not.toBe(true);
  expect(first.verifiedRequestKey).toMatch(/./);
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

function createSignedTelnyxWebhookRequest(timestamp = String(Math.floor(Date.now() / 1000))) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pemPublicKey = publicKey.export({ format: "pem", type: "spki" });
  const rawBody = JSON.stringify({
    data: { event_type: "call.initiated", payload: { call_control_id: "call-1" } },
    nonce: crypto.randomUUID(),
  });
  const signedPayload = `${timestamp}|${rawBody}`;
  const signature = crypto.sign(null, Buffer.from(signedPayload), privateKey).toString("base64");

  return {
    signature,
    verify(signatureValue = signature) {
      return verifyTelnyxWebhook(
        context({
          headers: {
            "telnyx-signature-ed25519": signatureValue,
            "telnyx-timestamp": timestamp,
          },
          rawBody,
        }),
        pemPublicKey,
      );
    },
  };
}

describe("skip verification request keys", () => {
  it.each(["plivo", "telnyx"] as const)(
    "%s returns a stable request key when verification is skipped",
    (provider) => {
      const ctx = context({ rawBody: "synthetic-skipped-request" });
      const verify = () =>
        provider === "plivo"
          ? verifyPlivoWebhook(ctx, "token", { skipVerification: true })
          : verifyTelnyxWebhook(ctx, undefined, { skipVerification: true });
      const first = verify();
      expect(first.ok).toBe(true);
      expect(first.verifiedRequestKey).toMatch(new RegExp(`^${provider}:skip:`));
      expect(verify()).toMatchObject({
        verifiedRequestKey: first.verifiedRequestKey,
        isReplay: true,
      });
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
      first.releaseReplay?.();
      expect(
        verifyPlivoWebhook(
          { ...ctx, headers: { ...ctx.headers, "x-plivo-signature-v3": "invalid" } },
          authToken,
        ),
      ).toMatchObject({ ok: false, reason: "Invalid Plivo V3 signature" });
    },
  );

  it.each([
    {
      name: "pins the configured public path",
      origin: "https://voice.openclaw.ai/admin",
      headers: { host: "voice.openclaw.ai" },
      url: "https://voice.openclaw.ai/admin?flow=answer&callId=abc",
      options: { publicUrl: "https://voice.openclaw.ai/voice/webhook?provider=plivo" },
      remoteAddress: undefined,
      expected: { ok: false, reason: "Invalid Plivo V3 signature" },
    },
    {
      name: "matches IPv4-mapped trusted proxies",
      origin: "https://proxy.example.com/voice/webhook",
      headers: { host: "localhost:3000", "x-forwarded-host": "proxy.example.com" },
      url: "http://localhost:3000/voice/webhook?flow=answer&callId=abc",
      options: { trustForwardingHeaders: true, trustedProxyIPs: ["127.0.0.1"] },
      remoteAddress: "::ffff:127.0.0.1",
      expected: { ok: true },
    },
  ])("$name", ({ name, origin, headers, url, options, remoteAddress, expected }) => {
    const base = `${origin}?callId=abc&flow=answer.CallStatusin-progressCallUUIDuuidFrom+15550000000`;
    const ctx = context({
      headers: { ...plivoV3Headers(base, name), ...headers },
      rawBody: plivoBody,
      url,
      query: { flow: "answer", callId: "abc" },
      remoteAddress,
    });
    expect(verifyPlivoWebhook(ctx, authToken, options)).toMatchObject(expected);
  });

  it("rejects missing signatures", () => {
    const result = verifyPlivoWebhook(context({ headers: directHeaders }), "token");

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Missing Plivo signature headers/);
  });

  it("treats query-only V2 variants as the same verified request", () => {
    const nonce = "nonce-replay-v2";
    const headers = {
      ...directHeaders,
      "x-plivo-signature-v2": hmac("sha256", publicUrl + nonce),
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
    expectReplay(verify("answer"), verify("getinput"));
  });
});

describe("verifyTelnyxWebhook", () => {
  it("rejects signed timestamps with trailing characters", () => {
    const request = createSignedTelnyxWebhookRequest(`${Math.floor(Date.now() / 1000)}abc`);

    expect(request.verify()).toEqual({
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
    expectReplay(request.verify(), request.verify(urlSafeSignature));
  });
});

describe("reconstructWebhookUrl", () => {
  const fallback = "https://fallback.example/voice/webhook?callId=ipv6";
  it.each([
    [{ host: "[::1]evil" }, fallback, undefined],
    [{ host: "[not-ipv6]:8443" }, fallback, undefined],
    [
      { host: "fallback.example", "x-forwarded-host": "[fe80::1%25eth0]" },
      "http://localhost:3000/voice/webhook?callId=ipv6",
      { trustForwardingHeaders: true },
    ],
  ] as const)("falls back from malformed or scoped IPv6 hosts: %j", (headers, url, options) => {
    expect(reconstructWebhookUrl(context({ headers, url }), options)).toBe(fallback);
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
    expect(result.ok).toBe(true);

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
    for (const text of ["Invalid signature for URL:", "turnToken=***", "callId=***"]) {
      expect(result.reason).toContain(text);
    }
    for (const text of ["secret-turn-token", "user:pass", "fragment-secret"]) {
      expect(result.reason).not.toContain(text);
    }
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

  function forwardedRequest(host: string, forwarded: string, extra: Partial<WebhookContext> = {}) {
    return {
      url: "http://localhost:3000/voice/webhook",
      ...extra,
      headers: {
        host,
        "x-forwarded-host": forwarded,
        "x-twilio-signature": "invalid",
        ...extra.headers,
      },
    };
  }
  it.each<
    [string, ReturnType<typeof forwardedRequest>, Parameters<typeof verifyTwilio>[1], string]
  >([
    [
      "ngrok loopback still requires a signature",
      forwardedRequest("127.0.0.1:3334", "local.ngrok-free.app", {
        url: "http://127.0.0.1:3334/voice/webhook",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-proto": "https" },
      }),
      { allowNgrokFreeTierLoopbackBypass: true },
      "Invalid signature",
    ],
    [
      "forwarding requires trust",
      forwardedRequest("legitimate.example.com", "attacker.evil.com"),
      undefined,
      "https://legitimate.example.com/voice/webhook",
    ],
    [
      "forwarded host must be allowlisted",
      forwardedRequest("localhost:3000", "attacker.evil.com"),
      { allowedHosts: ["myapp.ngrok.io", "webhook.example.com"] },
      "https://localhost/voice/webhook",
    ],
    [
      "trusted proxy requires a remote IP",
      forwardedRequest("legitimate.example.com", "proxy.example.com", {
        headers: { "x-forwarded-proto": "https" },
      }),
      { trustForwardingHeaders: true, trustedProxyIPs: ["203.0.113.10"] },
      "https://legitimate.example.com/voice/webhook",
    ],
  ])("%s", (_name, request, options, expected) => {
    const result = verifyTwilio(request, options);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(expected);
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

    expect(result.ok).toBe(true);
    expect(result.verifiedRequestKey).toMatch(/^twilio:req:/);
  });
});
