import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyPlivoWebhook,
  verifyTelnyxWebhook,
  verifyTwilioWebhook
} from "./webhook-security.js";
function canonicalizeBase64(input) {
  return Buffer.from(input, "base64").toString("base64");
}
function plivoV2Signature(params) {
  const digest = crypto.createHmac("sha256", params.authToken).update(params.urlNoQuery + params.nonce).digest("base64");
  return canonicalizeBase64(digest);
}
function plivoV3Signature(params) {
  const u = new URL(params.urlWithQuery);
  const baseNoQuery = `${u.protocol}//${u.host}${u.pathname}`;
  const queryPairs = [];
  for (const [k, v] of u.searchParams.entries()) {
    queryPairs.push([k, v]);
  }
  const queryMap = /* @__PURE__ */ new Map();
  for (const [k, v] of queryPairs) {
    queryMap.set(k, (queryMap.get(k) ?? []).concat(v));
  }
  const sortedQuery = Array.from(queryMap.keys()).toSorted().flatMap((k) => [...queryMap.get(k) ?? []].toSorted().map((v) => `${k}=${v}`)).join("&");
  const postParams = new URLSearchParams(params.postBody);
  const postMap = /* @__PURE__ */ new Map();
  for (const [k, v] of postParams.entries()) {
    postMap.set(k, (postMap.get(k) ?? []).concat(v));
  }
  const sortedPost = Array.from(postMap.keys()).toSorted().flatMap((k) => [...postMap.get(k) ?? []].toSorted().map((v) => `${k}${v}`)).join("");
  const hasPost = sortedPost.length > 0;
  let baseUrl = baseNoQuery;
  if (sortedQuery.length > 0 || hasPost) {
    baseUrl = `${baseNoQuery}?${sortedQuery}`;
  }
  if (sortedQuery.length > 0 && hasPost) {
    baseUrl = `${baseUrl}.`;
  }
  baseUrl = `${baseUrl}${sortedPost}`;
  const digest = crypto.createHmac("sha256", params.authToken).update(`${baseUrl}.${params.nonce}`).digest("base64");
  return canonicalizeBase64(digest);
}
function twilioSignature(params) {
  let dataToSign = params.url;
  const sortedParams = Array.from(new URLSearchParams(params.postBody).entries()).toSorted(
    (a, b) => a[0].localeCompare(b[0])
  );
  for (const [key, value] of sortedParams) {
    dataToSign += key + value;
  }
  return crypto.createHmac("sha1", params.authToken).update(dataToSign).digest("base64");
}
function expectReplayResultPair(first, second) {
  expect(first.ok).toBe(true);
  expect(first.isReplay).toBeFalsy();
  expect(first.verifiedRequestKey).toBeTruthy();
  expect(second.ok).toBe(true);
  expect(second.isReplay).toBe(true);
  expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
}
function expectAcceptedWebhookVersion(result, version) {
  expect(result).toMatchObject({ ok: true, version });
}
function verifyTwilioNgrokLoopback(signature) {
  return verifyTwilioWebhook(
    {
      headers: {
        host: "127.0.0.1:3334",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "local.ngrok-free.app",
        "x-twilio-signature": signature
      },
      rawBody: "CallSid=CS123&CallStatus=completed&From=%2B15550000000",
      url: "http://127.0.0.1:3334/voice/webhook",
      method: "POST",
      remoteAddress: "127.0.0.1"
    },
    "test-auth-token",
    { allowNgrokFreeTierLoopbackBypass: true }
  );
}
function verifyTwilioSignedRequest(params) {
  return verifyTwilioWebhook(
    {
      headers: params.headers,
      rawBody: params.rawBody,
      url: "http://local/voice/webhook?callId=abc",
      method: "POST",
      query: { callId: "abc" }
    },
    params.authToken,
    { publicUrl: params.publicUrl }
  );
}
describe("verifyPlivoWebhook", () => {
  it("accepts valid V2 signature", () => {
    const authToken = "test-auth-token";
    const nonce = "nonce-123";
    const ctxUrl = "http://local/voice/webhook?flow=answer&callId=abc";
    const verificationUrl = "https://example.com/voice/webhook";
    const signature = plivoV2Signature({
      authToken,
      urlNoQuery: verificationUrl,
      nonce
    });
    const result = verifyPlivoWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-plivo-signature-v2": signature,
          "x-plivo-signature-v2-nonce": nonce
        },
        rawBody: "CallUUID=uuid&CallStatus=in-progress",
        url: ctxUrl,
        method: "POST",
        query: { flow: "answer", callId: "abc" }
      },
      authToken
    );
    expectAcceptedWebhookVersion(result, "v2");
  });
  it("accepts valid V3 signature (including multi-signature header)", () => {
    const authToken = "test-auth-token";
    const nonce = "nonce-456";
    const urlWithQuery = "https://example.com/voice/webhook?flow=answer&callId=abc";
    const postBody = "CallUUID=uuid&CallStatus=in-progress&From=%2B15550000000";
    const good = plivoV3Signature({
      authToken,
      urlWithQuery,
      postBody,
      nonce
    });
    const result = verifyPlivoWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-plivo-signature-v3": `bad, ${good}`,
          "x-plivo-signature-v3-nonce": nonce
        },
        rawBody: postBody,
        url: urlWithQuery,
        method: "POST",
        query: { flow: "answer", callId: "abc" }
      },
      authToken
    );
    expectAcceptedWebhookVersion(result, "v3");
  });
  it("rejects missing signatures", () => {
    const result = verifyPlivoWebhook(
      {
        headers: { host: "example.com", "x-forwarded-proto": "https" },
        rawBody: "",
        url: "https://example.com/voice/webhook",
        method: "POST"
      },
      "token"
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Missing Plivo signature headers/);
  });
  it("marks replayed valid V3 requests as replay without failing auth", () => {
    const authToken = "test-auth-token";
    const nonce = "nonce-replay-v3";
    const urlWithQuery = "https://example.com/voice/webhook?flow=answer&callId=abc";
    const postBody = "CallUUID=uuid&CallStatus=in-progress&From=%2B15550000000";
    const signature = plivoV3Signature({
      authToken,
      urlWithQuery,
      postBody,
      nonce
    });
    const ctx = {
      headers: {
        host: "example.com",
        "x-forwarded-proto": "https",
        "x-plivo-signature-v3": signature,
        "x-plivo-signature-v3-nonce": nonce
      },
      rawBody: postBody,
      url: urlWithQuery,
      method: "POST",
      query: { flow: "answer", callId: "abc" }
    };
    const first = verifyPlivoWebhook(ctx, authToken);
    const second = verifyPlivoWebhook(ctx, authToken);
    expectReplayResultPair(first, second);
  });
  it("returns a stable request key when verification is skipped", () => {
    const ctx = {
      headers: {},
      rawBody: "CallUUID=uuid&CallStatus=in-progress",
      url: "https://example.com/voice/webhook",
      method: "POST"
    };
    const first = verifyPlivoWebhook(ctx, "token", { skipVerification: true });
    const second = verifyPlivoWebhook(ctx, "token", { skipVerification: true });
    expect(first.ok).toBe(true);
    expect(first.verifiedRequestKey).toMatch(/^plivo:skip:/);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
    expect(second.isReplay).toBe(true);
  });
});
describe("verifyTelnyxWebhook", () => {
  it("marks replayed valid requests as replay without failing auth", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pemPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString();
    const timestamp = String(Math.floor(Date.now() / 1e3));
    const rawBody = JSON.stringify({
      data: { event_type: "call.initiated", payload: { call_control_id: "call-1" } },
      nonce: crypto.randomUUID()
    });
    const signedPayload = `${timestamp}|${rawBody}`;
    const signature = crypto.sign(null, Buffer.from(signedPayload), privateKey).toString("base64");
    const ctx = {
      headers: {
        "telnyx-signature-ed25519": signature,
        "telnyx-timestamp": timestamp
      },
      rawBody,
      url: "https://example.com/voice/webhook",
      method: "POST"
    };
    const first = verifyTelnyxWebhook(ctx, pemPublicKey);
    const second = verifyTelnyxWebhook(ctx, pemPublicKey);
    expectReplayResultPair(first, second);
  });
  it("returns a stable request key when verification is skipped", () => {
    const ctx = {
      headers: {},
      rawBody: JSON.stringify({ data: { event_type: "call.initiated" } }),
      url: "https://example.com/voice/webhook",
      method: "POST"
    };
    const first = verifyTelnyxWebhook(ctx, void 0, { skipVerification: true });
    const second = verifyTelnyxWebhook(ctx, void 0, { skipVerification: true });
    expect(first.ok).toBe(true);
    expect(first.verifiedRequestKey).toMatch(/^telnyx:skip:/);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
    expect(second.isReplay).toBe(true);
  });
});
describe("verifyTwilioWebhook", () => {
  it("uses request query when publicUrl omits it", () => {
    const authToken = "test-auth-token";
    const publicUrl = "https://example.com/voice/webhook";
    const urlWithQuery = `${publicUrl}?callId=abc`;
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    const signature = twilioSignature({
      authToken,
      url: urlWithQuery,
      postBody
    });
    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-twilio-signature": signature
        },
        rawBody: postBody,
        url: "http://local/voice/webhook?callId=abc",
        method: "POST",
        query: { callId: "abc" }
      },
      authToken,
      { publicUrl }
    );
    expect(result.ok).toBe(true);
  });
  it("marks replayed valid requests as replay without failing auth", () => {
    const authToken = "test-auth-token";
    const publicUrl = "https://example.com/voice/webhook";
    const urlWithQuery = `${publicUrl}?callId=abc`;
    const postBody = "CallSid=CS777&CallStatus=completed&From=%2B15550000000";
    const signature = twilioSignature({ authToken, url: urlWithQuery, postBody });
    const headers = {
      host: "example.com",
      "x-forwarded-proto": "https",
      "x-twilio-signature": signature,
      "i-twilio-idempotency-token": "idem-replay-1"
    };
    const first = verifyTwilioSignedRequest({ headers, rawBody: postBody, authToken, publicUrl });
    const second = verifyTwilioSignedRequest({ headers, rawBody: postBody, authToken, publicUrl });
    expectReplayResultPair(first, second);
  });
  it("treats changed idempotency header as replay for identical signed requests", () => {
    const authToken = "test-auth-token";
    const publicUrl = "https://example.com/voice/webhook";
    const urlWithQuery = `${publicUrl}?callId=abc`;
    const postBody = "CallSid=CS778&CallStatus=completed&From=%2B15550000000";
    const signature = twilioSignature({ authToken, url: urlWithQuery, postBody });
    const first = verifyTwilioSignedRequest({
      headers: {
        host: "example.com",
        "x-forwarded-proto": "https",
        "x-twilio-signature": signature,
        "i-twilio-idempotency-token": "idem-replay-a"
      },
      rawBody: postBody,
      authToken,
      publicUrl
    });
    const second = verifyTwilioSignedRequest({
      headers: {
        host: "example.com",
        "x-forwarded-proto": "https",
        "x-twilio-signature": signature,
        "i-twilio-idempotency-token": "idem-replay-b"
      },
      rawBody: postBody,
      authToken,
      publicUrl
    });
    expectReplayResultPair(first, second);
  });
  it("rejects invalid signatures even when attacker injects forwarded host", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "127.0.0.1:3334",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "attacker.ngrok-free.app",
          "x-twilio-signature": "invalid"
        },
        rawBody: postBody,
        url: "http://127.0.0.1:3334/voice/webhook",
        method: "POST"
      },
      authToken
    );
    expect(result.ok).toBe(false);
    expect(result.isNgrokFreeTier).toBe(false);
    expect(result.reason).toMatch(/Invalid signature/);
  });
  it("accepts valid signatures for ngrok free tier on loopback when compatibility mode is enabled", () => {
    const webhookUrl = "https://local.ngrok-free.app/voice/webhook";
    const signature = twilioSignature({
      authToken: "test-auth-token",
      url: webhookUrl,
      postBody: "CallSid=CS123&CallStatus=completed&From=%2B15550000000"
    });
    const result = verifyTwilioNgrokLoopback(signature);
    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(webhookUrl);
  });
  it("does not allow invalid signatures for ngrok free tier on loopback", () => {
    const result = verifyTwilioNgrokLoopback("invalid");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Invalid signature/);
    expect(result.isNgrokFreeTier).toBe(true);
  });
  it("ignores attacker X-Forwarded-Host without allowedHosts or trustForwardingHeaders", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "legitimate.example.com",
          "x-forwarded-host": "attacker.evil.com",
          "x-twilio-signature": "invalid"
        },
        rawBody: postBody,
        url: "http://localhost:3000/voice/webhook",
        method: "POST"
      },
      authToken
    );
    expect(result.ok).toBe(false);
    expect(result.verificationUrl).toBe("https://legitimate.example.com/voice/webhook");
  });
  it("uses X-Forwarded-Host when allowedHosts whitelist is provided", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    const webhookUrl = "https://myapp.ngrok.io/voice/webhook";
    const signature = twilioSignature({ authToken, url: webhookUrl, postBody });
    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "localhost:3000",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "myapp.ngrok.io",
          "x-twilio-signature": signature
        },
        rawBody: postBody,
        url: "http://localhost:3000/voice/webhook",
        method: "POST"
      },
      authToken,
      { allowedHosts: ["myapp.ngrok.io"] }
    );
    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(webhookUrl);
  });
  it("rejects X-Forwarded-Host not in allowedHosts whitelist", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "localhost:3000",
          "x-forwarded-host": "attacker.evil.com",
          "x-twilio-signature": "invalid"
        },
        rawBody: postBody,
        url: "http://localhost:3000/voice/webhook",
        method: "POST"
      },
      authToken,
      { allowedHosts: ["myapp.ngrok.io", "webhook.example.com"] }
    );
    expect(result.ok).toBe(false);
    expect(result.verificationUrl).toBe("https://localhost/voice/webhook");
  });
  it("trusts forwarding headers only from trusted proxy IPs", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    const webhookUrl = "https://proxy.example.com/voice/webhook";
    const signature = twilioSignature({ authToken, url: webhookUrl, postBody });
    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "localhost:3000",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "proxy.example.com",
          "x-twilio-signature": signature
        },
        rawBody: postBody,
        url: "http://localhost:3000/voice/webhook",
        method: "POST",
        remoteAddress: "203.0.113.10"
      },
      authToken,
      { trustForwardingHeaders: true, trustedProxyIPs: ["203.0.113.10"] }
    );
    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(webhookUrl);
  });
  it("ignores forwarding headers when trustedProxyIPs are set but remote IP is missing", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "legitimate.example.com",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "proxy.example.com",
          "x-twilio-signature": "invalid"
        },
        rawBody: postBody,
        url: "http://localhost:3000/voice/webhook",
        method: "POST"
      },
      authToken,
      { trustForwardingHeaders: true, trustedProxyIPs: ["203.0.113.10"] }
    );
    expect(result.ok).toBe(false);
    expect(result.verificationUrl).toBe("https://legitimate.example.com/voice/webhook");
  });
  it("returns a stable request key when verification is skipped", () => {
    const ctx = {
      headers: {},
      rawBody: "CallSid=CS123&CallStatus=completed",
      url: "https://example.com/voice/webhook",
      method: "POST"
    };
    const first = verifyTwilioWebhook(ctx, "token", { skipVerification: true });
    const second = verifyTwilioWebhook(ctx, "token", { skipVerification: true });
    expect(first.ok).toBe(true);
    expect(first.verifiedRequestKey).toMatch(/^twilio:skip:/);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
    expect(second.isReplay).toBe(true);
  });
  it("succeeds when Twilio signs URL without port but server URL has port", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    const urlWithPort = "https://example.com:8443/voice/webhook";
    const signedUrl = "https://example.com/voice/webhook";
    const signature = twilioSignature({ authToken, url: signedUrl, postBody });
    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "example.com:8443",
          "x-twilio-signature": signature
        },
        rawBody: postBody,
        url: urlWithPort,
        method: "POST"
      },
      authToken,
      { publicUrl: urlWithPort }
    );
    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(signedUrl);
    expect(result.verifiedRequestKey).toMatch(/^twilio:req:/);
  });
});
