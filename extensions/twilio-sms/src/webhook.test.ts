// Authored by: cc (Claude Code) | 2026-03-18
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { normalizeSmsConfig } from "./config.js";
import { handleSmsRequest, verifySmsSignature, type SmsMessage } from "./webhook.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_TOKEN = "test-auth-token";
const PUBLIC_URL = "https://example.com/sms/webhook";

function makeSignature(publicUrl: string, params: Record<string, string>, token: string): string {
  const str = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + (params[k] ?? ""), publicUrl);
  return crypto.createHmac("sha1", token).update(str, "utf8").digest("base64");
}

function buildBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function makeRequest(opts: {
  method?: string;
  body?: string;
  signature?: string;
}): IncomingMessage {
  const { method = "POST", body = "", signature = "" } = opts;
  const req = {
    method,
    headers: {
      "x-twilio-signature": signature,
      "content-type": "application/x-www-form-urlencoded",
    },
    on: vi.fn(),
  } as unknown as IncomingMessage;

  // Simulate readable stream for body
  const dataHandlers: Array<(chunk: Buffer) => void> = [];
  const endHandlers: Array<() => void> = [];
  (req.on as ReturnType<typeof vi.fn>).mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: Buffer) => void);
      if (event === "end") endHandlers.push(handler as () => void);
      return req;
    },
  );

  // Flush body on next tick so the promise chain resolves
  Promise.resolve().then(() => {
    dataHandlers.forEach((h) => h(Buffer.from(body, "utf8")));
    endHandlers.forEach((h) => h());
  });

  return req;
}

function makeResponse(): ServerResponse & {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
} {
  const res = {
    statusCode: 200,
    body: "",
    headers: {} as Record<string, string>,
    headersSent: false,
    writeHead: vi.fn(function (this: typeof res, code: number, hdrs?: Record<string, string>) {
      this.statusCode = code;
      this.headers = { ...this.headers, ...(hdrs ?? {}) };
      (this as unknown as { headersSent: boolean }).headersSent = true;
    }),
    end: vi.fn(function (this: typeof res, body: string) {
      this.body = body;
    }),
  } as unknown as ServerResponse & {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  };
  return res;
}

// ---------------------------------------------------------------------------
// verifySmsSignature
// ---------------------------------------------------------------------------

describe("verifySmsSignature", () => {
  const params = { Body: "hello", From: "+15550001234", To: "+15550009999", MessageSid: "SM123" };

  it("returns true for a valid signature", () => {
    const sig = makeSignature(PUBLIC_URL, params, AUTH_TOKEN);
    expect(verifySmsSignature(AUTH_TOKEN, PUBLIC_URL, params, sig)).toBe(true);
  });

  it("returns false for a tampered payload", () => {
    const sig = makeSignature(PUBLIC_URL, params, AUTH_TOKEN);
    const tampered = { ...params, Body: "evil" };
    expect(verifySmsSignature(AUTH_TOKEN, PUBLIC_URL, tampered, sig)).toBe(false);
  });

  it("returns false for an empty signature", () => {
    expect(verifySmsSignature(AUTH_TOKEN, PUBLIC_URL, params, "")).toBe(false);
  });

  it("returns false for wrong auth token", () => {
    const sig = makeSignature(PUBLIC_URL, params, "wrong-token");
    expect(verifySmsSignature(AUTH_TOKEN, PUBLIC_URL, params, sig)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleSmsRequest
// ---------------------------------------------------------------------------

const baseParams = {
  Body: "hello agent",
  From: "+15550001234",
  To: "+15550009999",
  MessageSid: "SM_test123",
};

const baseConfig = normalizeSmsConfig({
  twilio: { accountSid: "AC123", authToken: AUTH_TOKEN },
  publicUrl: PUBLIC_URL,
  inboundPolicy: "open",
  skipSignatureVerification: true,
});

describe("handleSmsRequest — method guard", () => {
  it("returns 405 for GET requests", async () => {
    const req = makeRequest({ method: "GET" });
    const res = makeResponse();
    const onMessage = vi.fn();
    await handleSmsRequest(req, res, { config: baseConfig, onMessage });
    expect(res.statusCode).toBe(405);
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("handleSmsRequest — signature verification", () => {
  const cfgWithSigVerify = normalizeSmsConfig({
    twilio: { accountSid: "AC123", authToken: AUTH_TOKEN },
    publicUrl: PUBLIC_URL,
    inboundPolicy: "open",
    skipSignatureVerification: false,
  });

  it("accepts a request with a valid signature", async () => {
    const body = buildBody(baseParams);
    const sig = makeSignature(PUBLIC_URL, baseParams, AUTH_TOKEN);
    const req = makeRequest({ body, signature: sig });
    const res = makeResponse();
    const onMessage = vi.fn();
    await handleSmsRequest(req, res, { config: cfgWithSigVerify, onMessage });
    expect(res.statusCode).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("returns 403 for an invalid signature", async () => {
    const body = buildBody(baseParams);
    const req = makeRequest({ body, signature: "bad-sig" });
    const res = makeResponse();
    const onMessage = vi.fn();
    await handleSmsRequest(req, res, { config: cfgWithSigVerify, onMessage });
    expect(res.statusCode).toBe(403);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("returns 500 when publicUrl is missing", async () => {
    const cfgNoUrl = normalizeSmsConfig({
      twilio: { accountSid: "AC123", authToken: AUTH_TOKEN },
      inboundPolicy: "open",
      skipSignatureVerification: false,
    });
    const req = makeRequest({ body: buildBody(baseParams), signature: "any" });
    const res = makeResponse();
    await handleSmsRequest(req, res, { config: cfgNoUrl, onMessage: vi.fn() });
    expect(res.statusCode).toBe(500);
  });
});

describe("handleSmsRequest — allowlist policy", () => {
  const cfgAllowlist = normalizeSmsConfig({
    twilio: { accountSid: "AC123", authToken: AUTH_TOKEN },
    publicUrl: PUBLIC_URL,
    inboundPolicy: "allowlist",
    allowFrom: ["+15550001234"],
    skipSignatureVerification: true,
  });

  it("accepts a sender on the allowlist", async () => {
    const req = makeRequest({ body: buildBody(baseParams) });
    const res = makeResponse();
    const onMessage = vi.fn();
    await handleSmsRequest(req, res, { config: cfgAllowlist, onMessage });
    expect(res.statusCode).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("rejects a sender not on the allowlist", async () => {
    const params = { ...baseParams, From: "+15559999999" };
    const req = makeRequest({ body: buildBody(params) });
    const res = makeResponse();
    const onMessage = vi.fn();
    await handleSmsRequest(req, res, { config: cfgAllowlist, onMessage });
    expect(res.statusCode).toBe(403);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("open policy accepts any sender", async () => {
    const params = { ...baseParams, From: "+15559999999" };
    const req = makeRequest({ body: buildBody(params) });
    const res = makeResponse();
    const onMessage = vi.fn();
    await handleSmsRequest(req, res, { config: baseConfig, onMessage });
    expect(res.statusCode).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
  });
});

describe("handleSmsRequest — fromNumber enforcement", () => {
  const cfgWithFromNumber = normalizeSmsConfig({
    twilio: { accountSid: "AC123", authToken: AUTH_TOKEN },
    publicUrl: PUBLIC_URL,
    fromNumber: "+15550009999",
    inboundPolicy: "open",
    skipSignatureVerification: true,
  });

  it("accepts a message addressed to fromNumber", async () => {
    const req = makeRequest({ body: buildBody(baseParams) });
    const res = makeResponse();
    const onMessage = vi.fn();
    await handleSmsRequest(req, res, { config: cfgWithFromNumber, onMessage });
    expect(res.statusCode).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("rejects a message addressed to a different number", async () => {
    const params = { ...baseParams, To: "+15551111111" };
    const req = makeRequest({ body: buildBody(params) });
    const res = makeResponse();
    const onMessage = vi.fn();
    await handleSmsRequest(req, res, { config: cfgWithFromNumber, onMessage });
    expect(res.statusCode).toBe(403);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("skips check when fromNumber is not configured", async () => {
    const params = { ...baseParams, To: "+15551111111" };
    const req = makeRequest({ body: buildBody(params) });
    const res = makeResponse();
    const onMessage = vi.fn();
    await handleSmsRequest(req, res, { config: baseConfig, onMessage });
    expect(res.statusCode).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
  });
});

describe("handleSmsRequest — successful dispatch", () => {
  it("passes correct message fields to onMessage", async () => {
    const req = makeRequest({ body: buildBody(baseParams) });
    const res = makeResponse();
    let captured: SmsMessage | null = null;
    const onMessage = vi.fn((msg: SmsMessage) => {
      captured = msg;
    });
    await handleSmsRequest(req, res, { config: baseConfig, onMessage });
    expect(captured).not.toBeNull();
    expect(captured!.from).toBe("+15550001234");
    expect(captured!.body).toBe("hello agent");
    expect(captured!.messageSid).toBe("SM_test123");
    expect(captured!.receivedAt).toBeTypeOf("number");
  });

  it("responds with empty TwiML", async () => {
    const req = makeRequest({ body: buildBody(baseParams) });
    const res = makeResponse();
    await handleSmsRequest(req, res, { config: baseConfig, onMessage: vi.fn() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<Response/>");
    expect(res.headers["Content-Type"]).toBe("text/xml");
  });
});
