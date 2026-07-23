import { createHmac } from "node:crypto";
// RCS tests cover webhook plugin behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createFixedWindowRateLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RcsChannelRuntime } from "./inbound.js";
import { buildTwilioInboundMessage, parseTwilioFormBody } from "./twilio.js";
import type { RcsInboundMessage, ResolvedRcsAccount } from "./types.js";
import { createRcsWebhookHandler, createRcsSharedTwilioWebhookHandler } from "./webhook.js";

const dispatchRcsInboundEvent = vi.hoisted(() =>
  vi.fn(async (_params: { msg: RcsInboundMessage }) => undefined),
);

vi.mock("./inbound.js", () => ({
  dispatchRcsInboundEvent,
}));

const fetchConfiguredLocalOriginWithSsrFGuard = vi.hoisted(() =>
  vi.fn(
    async (params: {
      url: string;
      configuredLocalOriginBaseUrl: string;
      auditContext?: string;
      timeoutMs?: number;
      init?: RequestInit;
    }) => ({
      response: new Response("<Response></Response>", {
        status: 200,
        headers: { "content-type": "text/xml; charset=utf-8" },
      }),
      finalUrl: params.url,
      release: async () => {},
    }),
  ),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  fetchConfiguredLocalOriginWithSsrFGuard,
}));

function computeTwilioSignature(params: {
  url: string;
  authToken: string;
  form: Record<string, string>;
}): string {
  const data =
    params.url +
    Object.keys(params.form)
      .toSorted()
      .map((key) => `${key}${params.form[key] ?? ""}`)
      .join("");
  return createHmac("sha1", params.authToken).update(data).digest("base64");
}

function createAccount(overrides: Partial<ResolvedRcsAccount> = {}): ResolvedRcsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    messagingServiceSid: "MG123",
    senderId: "",
    transport: "rcs-only",
    defaultTo: "",
    webhookPath: "/webhooks/rcs",
    publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
    sharedWebhookPath: "/webhooks/sms",
    sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/sms",
    smsForwardWebhookPath: "/webhooks/sms/native",
    statusCallbacks: true,
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "allowlist",
    allowFrom: ["+15551234567"],
    textChunkLimit: 3000,
    ...overrides,
  } as ResolvedRcsAccount;
}

type TestRcsWebhookHandlerParams = Omit<
  Parameters<typeof createRcsWebhookHandler>[0],
  "ingress"
> & {
  channelRuntime: RcsChannelRuntime;
};

type TestRcsSharedWebhookHandlerParams = Omit<
  Parameters<typeof createRcsSharedTwilioWebhookHandler>[0],
  "ingress"
> & {
  channelRuntime: RcsChannelRuntime;
};

function createTestIngress(params: TestRcsWebhookHandlerParams) {
  const seen = new Set<string>();
  return {
    enqueue: async (form: Record<string, string>) => {
      const msg = buildTwilioInboundMessage(form);
      if (!msg) {
        throw new Error("invalid test RCS payload");
      }
      const duplicate = seen.has(msg.messageSid);
      seen.add(msg.messageSid);
      if (!duplicate) {
        await dispatchRcsInboundEvent({ ...params, msg });
      }
      return { duplicate };
    },
  };
}

function createTestRcsWebhookHandler(
  params: TestRcsWebhookHandlerParams,
  deps: NonNullable<Parameters<typeof createRcsWebhookHandler>[1]> = {},
) {
  return createRcsWebhookHandler({ ...params, ingress: createTestIngress(params) }, deps);
}

function createTestRcsSharedWebhookHandler(
  params: TestRcsSharedWebhookHandlerParams,
  deps: NonNullable<Parameters<typeof createRcsSharedTwilioWebhookHandler>[1]> = {},
) {
  return createRcsSharedTwilioWebhookHandler(
    { ...params, ingress: createTestIngress(params) },
    deps,
  );
}

function createRequest(params: {
  body: string;
  signature: string;
  url?: string;
  localPort?: number;
  remoteAddress?: string;
}): IncomingMessage {
  const req = Readable.from([params.body]) as IncomingMessage;
  req.method = "POST";
  req.url = params.url ?? "/webhooks/sms";
  req.headers = {
    "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": params.signature,
  };
  Object.defineProperty(req, "socket", {
    value: {
      remoteAddress: params.remoteAddress ?? "127.0.0.1",
      localPort: params.localPort ?? 18789,
    },
  });
  return req;
}

function createResponse(): ServerResponse & { body?: string; endMock: ReturnType<typeof vi.fn> } {
  const endMock = vi.fn(function (this: ServerResponse & { body?: string }, body?: string) {
    this.body = body;
    return this;
  });
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    end: endMock,
    endMock,
  } as unknown as ServerResponse & { body?: string; endMock: ReturnType<typeof vi.fn> };
}

function createSignedRcsWebhookRequest(params: {
  from: string;
  messageSid: string;
  url?: string;
  remoteAddress?: string;
}): IncomingMessage {
  const url = params.url ?? "https://gateway.example.com/webhooks/rcs";
  const body = [
    "AccountSid=AC123",
    `From=${encodeURIComponent(params.from)}`,
    "To=rcs%3Aexample_agent",
    "Body=hello",
    `MessageSid=${params.messageSid}`,
  ].join("&");
  const signature = computeTwilioSignature({
    url,
    authToken: "secret",
    form: parseTwilioFormBody(body),
  });
  return createRequest({
    body,
    signature,
    url: new URL(url).pathname,
    remoteAddress: params.remoteAddress,
  });
}

describe("createRcsWebhookHandler", () => {
  beforeEach(() => {
    dispatchRcsInboundEvent.mockClear();
  });

  it("does not acknowledge when the durable enqueue fails", async () => {
    const handler = createRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      ingress: {
        enqueue: vi.fn(async () => {
          throw new Error("sqlite unavailable");
        }),
      },
    });
    const res = createResponse();

    await expect(
      handler(
        createSignedRcsWebhookRequest({
          from: "rcs:+15551234567",
          messageSid: "SM-durable-failure",
        }),
        res,
      ),
    ).rejects.toThrow("sqlite unavailable");

    expect(res.endMock).not.toHaveBeenCalled();
  });

  it("acks and drops messages after the per-sender rate limit", async () => {
    const log = { warn: vi.fn() };
    const handler = createTestRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as RcsChannelRuntime,
      log,
    });

    for (let i = 0; i < 30; i += 1) {
      const res = createResponse();
      await handler(
        createSignedRcsWebhookRequest({
          from: "rcs:+15551234567",
          messageSid: `SM-sender-limit-${i}`,
          remoteAddress: "203.0.113.10",
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
    }

    const limitedRes = createResponse();
    await handler(
      createSignedRcsWebhookRequest({
        from: "rcs:+15551234567",
        messageSid: "SM-sender-limit-30",
        remoteAddress: "203.0.113.10",
      }),
      limitedRes,
    );

    expect(limitedRes.statusCode).toBe(200);
    expect(limitedRes.body).toBe("<Response></Response>");
    expect(dispatchRcsInboundEvent).toHaveBeenCalledTimes(30);
    expect(log.warn).toHaveBeenCalledWith(
      "RCS webhook sender rate limit exceeded for +15551234567",
    );
  });

  it("keeps different From numbers in independent sender buckets", async () => {
    const handler = createTestRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as RcsChannelRuntime,
    });

    for (let i = 0; i < 30; i += 1) {
      const res = createResponse();
      await handler(
        createSignedRcsWebhookRequest({
          from: "rcs:+15551234567",
          messageSid: `SM-first-sender-${i}`,
          remoteAddress: "203.0.113.20",
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
    }

    const secondSenderRes = createResponse();
    await handler(
      createSignedRcsWebhookRequest({
        from: "rcs:+15557654321",
        messageSid: "SM-second-sender",
        remoteAddress: "203.0.113.20",
      }),
      secondSenderRes,
    );

    expect(secondSenderRes.statusCode).toBe(200);
    expect(dispatchRcsInboundEvent).toHaveBeenCalledTimes(31);
    expect(dispatchRcsInboundEvent.mock.calls[30]?.[0].msg).toMatchObject({
      from: "rcs:+15557654321",
    });
  });

  it("acks validated callbacks over the IP rate limit with empty TwiML instead of 429", async () => {
    const log = { warn: vi.fn() };
    const handler = createTestRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as RcsChannelRuntime,
      log,
    });

    for (let i = 0; i < 600; i += 1) {
      const res = createResponse();
      await handler(
        createSignedRcsWebhookRequest({
          from: `rcs:+1555${String(1000000 + i)}`,
          messageSid: `SM-ip-ack-${i}`,
          remoteAddress: "203.0.113.31",
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
    }
    expect(dispatchRcsInboundEvent).toHaveBeenCalledTimes(600);

    const droppedRes = createResponse();
    await handler(
      createSignedRcsWebhookRequest({
        from: "rcs:+15559990001",
        messageSid: "SM-ip-ack-dropped",
        remoteAddress: "203.0.113.31",
      }),
      droppedRes,
    );

    expect(droppedRes.statusCode).toBe(200);
    expect(droppedRes.body).toBe("<Response></Response>");
    expect(dispatchRcsInboundEvent).toHaveBeenCalledTimes(600);
    expect(log.warn).toHaveBeenCalledWith(
      "RCS webhook rate limit exceeded for 203.0.113.31; acknowledged validated callback SM-ip-ack-dropped without dispatch",
    );
  });

  it("keeps 429 for over-limit traffic that fails validation", async () => {
    const handler = createTestRcsWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as RcsChannelRuntime,
    });
    const invalidBody =
      "AccountSid=AC123&From=rcs%3A%2B15551234567&To=rcs%3Aexample_agent&Body=hello&MessageSid=SM-ip-limit";

    for (let i = 0; i < 600; i += 1) {
      const res = createResponse();
      await handler(
        createRequest({
          body: invalidBody,
          signature: "invalid",
          url: "/webhooks/rcs",
          remoteAddress: "203.0.113.30",
        }),
        res,
      );
      expect(res.statusCode).toBe(403);
    }

    const limitedRes = createResponse();
    await handler(
      createRequest({
        body: invalidBody,
        signature: "invalid",
        url: "/webhooks/rcs",
        remoteAddress: "203.0.113.30",
      }),
      limitedRes,
    );
    expect(limitedRes.statusCode).toBe(429);

    const ackedRes = createResponse();
    await handler(
      createSignedRcsWebhookRequest({
        from: "rcs:+15559990002",
        messageSid: "SM-ip-limit-valid",
        remoteAddress: "203.0.113.30",
      }),
      ackedRes,
    );

    expect(ackedRes.statusCode).toBe(200);
    expect(dispatchRcsInboundEvent).not.toHaveBeenCalled();
  });

  it("does not replay-cache callbacks dropped by the rate limit", async () => {
    const ipRateLimiter = createFixedWindowRateLimiter({
      maxRequests: 600,
      windowMs: 60_000,
      maxTrackedKeys: 5_000,
    });
    const handler = createTestRcsWebhookHandler(
      {
        cfg: {},
        account: createAccount(),
        channelRuntime: {} as RcsChannelRuntime,
      },
      { ipRateLimiter },
    );

    for (let i = 0; i < 600; i += 1) {
      await handler(
        createSignedRcsWebhookRequest({
          from: `rcs:+1555${String(2000000 + i)}`,
          messageSid: `SM-ip-cache-${i}`,
          remoteAddress: "203.0.113.32",
        }),
        createResponse(),
      );
    }
    await handler(
      createSignedRcsWebhookRequest({
        from: "rcs:+15559990003",
        messageSid: "SM-ip-cache-dropped",
        remoteAddress: "203.0.113.32",
      }),
      createResponse(),
    );
    expect(dispatchRcsInboundEvent).toHaveBeenCalledTimes(600);

    // Reset stands in for the fixed window expiring before Twilio redelivers the SID.
    ipRateLimiter.clear();
    const redeliveredRes = createResponse();
    await handler(
      createSignedRcsWebhookRequest({
        from: "rcs:+15559990003",
        messageSid: "SM-ip-cache-dropped",
        remoteAddress: "203.0.113.32",
      }),
      redeliveredRes,
    );

    expect(redeliveredRes.statusCode).toBe(200);
    expect(dispatchRcsInboundEvent).toHaveBeenCalledTimes(601);
  });

  it("keeps 429 for over-limit traffic when signature validation is disabled", async () => {
    const handler = createTestRcsWebhookHandler({
      cfg: {},
      account: createAccount({ dangerouslyDisableSignatureValidation: true }),
      channelRuntime: {} as RcsChannelRuntime,
    });

    for (let i = 0; i < 600; i += 1) {
      const res = createResponse();
      await handler(
        createRequest({
          body: `AccountSid=AC123&From=rcs%3A%2B1555${String(3000000 + i)}&To=rcs%3Aexample_agent&Body=hello&MessageSid=SM-ip-nosig-${i}`,
          signature: "unused-signature",
          url: "/webhooks/rcs",
          remoteAddress: "203.0.113.33",
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
    }

    const throttledRes = createResponse();
    await handler(
      createRequest({
        body: "AccountSid=AC123&From=rcs%3A%2B15559990004&To=rcs%3Aexample_agent&Body=hello&MessageSid=SM-ip-nosig-throttled",
        signature: "unused-signature",
        url: "/webhooks/rcs",
        remoteAddress: "203.0.113.33",
      }),
      throttledRes,
    );

    expect(throttledRes.statusCode).toBe(429);
    expect(dispatchRcsInboundEvent).toHaveBeenCalledTimes(600);
  });
});

describe("createRcsSharedTwilioWebhookHandler", () => {
  beforeEach(() => {
    dispatchRcsInboundEvent.mockClear();
    fetchConfiguredLocalOriginWithSsrFGuard.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches RCS payloads signed for the shared Twilio webhook URL", async () => {
    const body =
      "AccountSid=AC123&From=rcs%3A%2B15551234567&To=rcs%3Aexample_agent&Body=hello&MessageSid=SM123";
    const signature = computeTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form: parseTwilioFormBody(body),
    });
    const handler = createTestRcsSharedWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as RcsChannelRuntime,
      sharedPublicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      smsForwardWebhookPath: "/webhooks/sms/native",
    });

    const res = createResponse();
    await handler(createRequest({ body, signature }), res);

    expect(res.statusCode).toBe(200);
    expect(dispatchRcsInboundEvent).toHaveBeenCalledTimes(1);
    expect(dispatchRcsInboundEvent.mock.calls[0]?.[0].msg).toMatchObject({
      from: "rcs:+15551234567",
      to: "rcs:example_agent",
      body: "hello",
      viaRcs: true,
    });
    expect(fetchConfiguredLocalOriginWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("forwards non-RCS payloads to the internal SMS webhook path", async () => {
    const body =
      "AccountSid=AC123&From=%2B15551234567&To=%2B15557654321&Body=hello&MessageSid=SM124";
    const signature = computeTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms?foo=bar",
      authToken: "secret",
      form: parseTwilioFormBody(body),
    });
    const handler = createTestRcsSharedWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as RcsChannelRuntime,
      sharedPublicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      smsForwardWebhookPath: "/webhooks/sms/native",
    });

    const res = createResponse();
    await handler(createRequest({ body, signature, url: "/webhooks/sms?foo=bar" }), res);

    expect(res.statusCode).toBe(200);
    expect(dispatchRcsInboundEvent).not.toHaveBeenCalled();
    expect(fetchConfiguredLocalOriginWithSsrFGuard).toHaveBeenCalledTimes(1);
    const forwardCall = fetchConfiguredLocalOriginWithSsrFGuard.mock.calls[0]?.[0];
    expect(forwardCall?.url).toBe("http://127.0.0.1:18789/webhooks/sms/native?foo=bar");
    expect(forwardCall?.configuredLocalOriginBaseUrl).toBe("http://127.0.0.1:18789");
    expect(forwardCall?.init).toMatchObject({
      method: "POST",
      body,
    });
    const forwardedHeaders = (forwardCall?.init?.headers ?? {}) as Record<string, string>;
    expect(forwardedHeaders["x-twilio-signature"]).toBe(signature);
  });

  it("rejects non-RCS payloads before forwarding when the shared signature is invalid", async () => {
    const body =
      "AccountSid=AC123&From=%2B15551234567&To=%2B15557654321&Body=hello&MessageSid=SM126";
    const signature = computeTwilioSignature({
      url: "https://gateway.example.com/webhooks/rcs",
      authToken: "secret",
      form: parseTwilioFormBody(body),
    });
    const handler = createTestRcsSharedWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as RcsChannelRuntime,
      sharedPublicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      smsForwardWebhookPath: "/webhooks/sms/native",
    });

    const res = createResponse();
    await handler(createRequest({ body, signature }), res);

    expect(res.statusCode).toBe(403);
    expect(fetchConfiguredLocalOriginWithSsrFGuard).not.toHaveBeenCalled();
    expect(dispatchRcsInboundEvent).not.toHaveBeenCalled();
  });

  it("acks validated over-limit callbacks without dispatch or SMS forward", async () => {
    const log = { warn: vi.fn() };
    const handler = createTestRcsSharedWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as RcsChannelRuntime,
      sharedPublicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      smsForwardWebhookPath: "/webhooks/sms/native",
      log,
    });

    for (let i = 0; i < 600; i += 1) {
      const res = createResponse();
      await handler(
        createSignedRcsWebhookRequest({
          from: `rcs:+1555${String(4000000 + i)}`,
          messageSid: `SM-shared-ack-${i}`,
          url: "https://gateway.example.com/webhooks/sms",
          remoteAddress: "203.0.113.40",
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
    }
    expect(dispatchRcsInboundEvent).toHaveBeenCalledTimes(600);

    const droppedRcsRes = createResponse();
    await handler(
      createSignedRcsWebhookRequest({
        from: "rcs:+15559990005",
        messageSid: "SM-shared-ack-dropped",
        url: "https://gateway.example.com/webhooks/sms",
        remoteAddress: "203.0.113.40",
      }),
      droppedRcsRes,
    );
    expect(droppedRcsRes.statusCode).toBe(200);
    expect(droppedRcsRes.body).toBe("<Response></Response>");
    expect(dispatchRcsInboundEvent).toHaveBeenCalledTimes(600);
    expect(log.warn).toHaveBeenCalledWith(
      "RCS shared webhook rate limit exceeded for 203.0.113.40; acknowledged validated callback SM-shared-ack-dropped without dispatch",
    );

    const smsBody =
      "AccountSid=AC123&From=%2B15551234567&To=%2B15557654321&Body=hello&MessageSid=SM-shared-sms-dropped";
    const smsSignature = computeTwilioSignature({
      url: "https://gateway.example.com/webhooks/sms",
      authToken: "secret",
      form: parseTwilioFormBody(smsBody),
    });
    const droppedSmsRes = createResponse();
    await handler(
      createRequest({
        body: smsBody,
        signature: smsSignature,
        remoteAddress: "203.0.113.40",
      }),
      droppedSmsRes,
    );

    expect(droppedSmsRes.statusCode).toBe(200);
    expect(droppedSmsRes.body).toBe("<Response></Response>");
    expect(fetchConfiguredLocalOriginWithSsrFGuard).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "RCS shared webhook rate limit exceeded for 203.0.113.40; acknowledged validated callback SM-shared-sms-dropped without SMS forward",
    );
  });

  it("rejects RCS payloads not signed for the shared Twilio webhook URL", async () => {
    const body =
      "AccountSid=AC123&From=rcs%3A%2B15551234567&To=rcs%3Aexample_agent&Body=hello&MessageSid=SM125";
    const signature = computeTwilioSignature({
      url: "https://gateway.example.com/webhooks/rcs",
      authToken: "secret",
      form: parseTwilioFormBody(body),
    });
    const handler = createTestRcsSharedWebhookHandler({
      cfg: {},
      account: createAccount(),
      channelRuntime: {} as RcsChannelRuntime,
      sharedPublicWebhookUrl: "https://gateway.example.com/webhooks/sms",
      smsForwardWebhookPath: "/webhooks/sms/native",
    });

    const res = createResponse();
    await handler(createRequest({ body, signature }), res);

    expect(res.statusCode).toBe(403);
    expect(dispatchRcsInboundEvent).not.toHaveBeenCalled();
  });
});
