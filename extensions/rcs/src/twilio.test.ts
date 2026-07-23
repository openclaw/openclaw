// Rcs tests cover twilio plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwilioContentSpec } from "./content.js";
import type { TwilioRcsApiError } from "./twilio-api.js";
import {
  buildTwilioInboundMessage,
  buildTwilioStatusEvent,
  parseTwilioFormBody,
  resolveRcsStatusCallbackUrl,
  resolveTwilioWebhookSignatureUrl,
  retrieveTwilioMessagingService,
  sendRcsContentViaTwilio,
  sendRcsViaTwilio,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedRcsAccount } from "./types.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

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
    sharedWebhookPath: "",
    sharedWebhookPublicUrl: "",
    smsForwardWebhookPath: "",
    statusCallbacks: false,
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 3000,
    ...overrides,
  };
}

function cancelTrackedTextResponse(
  text: string,
  init?: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

function expectRequestUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof URL ? value.toString() : value.url;
}

function expectRequestBody(init: RequestInit | undefined): URLSearchParams {
  if (!(init?.body instanceof URLSearchParams)) {
    throw new Error("Expected URLSearchParams request body.");
  }
  return init.body;
}

describe("buildTwilioInboundMessage", () => {
  it("parses an RCS inbound message", () => {
    const msg = buildTwilioInboundMessage({
      From: "rcs:+15551234567",
      To: "rcs:myagent_abc_agent",
      Body: "hello",
      MessageSid: "SM123",
      AccountSid: "AC123",
    });
    expect(msg).toMatchObject({
      from: "rcs:+15551234567",
      to: "rcs:myagent_abc_agent",
      body: "hello",
      messageSid: "SM123",
      viaRcs: true,
      mediaUrls: [],
    });
  });

  it("marks SMS-fallback inbound as not via RCS", () => {
    const msg = buildTwilioInboundMessage({
      From: "+15551234567",
      To: "+15557654321",
      Body: "hello",
      MessageSid: "SM124",
    });
    expect(msg?.viaRcs).toBe(false);
  });

  it("accepts button taps with ButtonText and ButtonPayload", () => {
    const msg = buildTwilioInboundMessage({
      From: "rcs:+15551234567",
      To: "rcs:myagent_abc_agent",
      Body: "",
      ButtonText: "Yes, do it",
      ButtonPayload: "confirm-1",
      MessageSid: "SM125",
    });
    expect(msg?.body).toBe("Yes, do it");
    expect(msg?.buttonPayload).toBe("confirm-1");
  });

  it("accepts postback-only taps carrying just a ButtonPayload", () => {
    const msg = buildTwilioInboundMessage({
      From: "rcs:+15551234567",
      To: "rcs:myagent_abc_agent",
      Body: "",
      ButtonPayload: "confirm-1",
      MessageSid: "SM130",
    });
    expect(msg).not.toBeNull();
    expect(msg?.body).toBe("");
    expect(msg?.buttonPayload).toBe("confirm-1");
  });

  it("accepts media-only messages and collects media urls", () => {
    const msg = buildTwilioInboundMessage({
      From: "rcs:+15551234567",
      To: "rcs:myagent_abc_agent",
      Body: "",
      NumMedia: "2",
      MediaUrl0: "https://api.twilio.com/media/0",
      MediaUrl1: "https://api.twilio.com/media/1",
      MessageSid: "SM126",
    });
    expect(msg?.mediaUrls).toEqual([
      "https://api.twilio.com/media/0",
      "https://api.twilio.com/media/1",
    ]);
  });

  it("rejects payloads without sid or content", () => {
    expect(buildTwilioInboundMessage({ From: "rcs:+1555", To: "x", Body: "hi" })).toBeNull();
    expect(buildTwilioInboundMessage({ From: "rcs:+1555", To: "x", MessageSid: "SM1" })).toBeNull();
  });
});

describe("buildTwilioStatusEvent", () => {
  it("parses delivery status callbacks including read", () => {
    const event = buildTwilioStatusEvent({
      MessageSid: "SM123",
      MessageStatus: "read",
      To: "rcs:+15551234567",
    });
    expect(event).toMatchObject({ messageSid: "SM123", status: "read" });
  });

  it("maps post-delivery EventType=READ callbacks to read status", () => {
    const event = buildTwilioStatusEvent({
      MessageSid: "SM123",
      MessageStatus: "delivered",
      EventType: "READ",
      To: "rcs:+15551234567",
    });
    expect(event).toMatchObject({ messageSid: "SM123", status: "read" });
  });

  it("treats EventType=READ as a status even without MessageStatus", () => {
    const event = buildTwilioStatusEvent({
      MessageSid: "SM123",
      EventType: "READ",
    });
    expect(event).toMatchObject({ messageSid: "SM123", status: "read" });
  });

  it("captures error codes", () => {
    const event = buildTwilioStatusEvent({
      MessageSid: "SM123",
      MessageStatus: "failed",
      ErrorCode: "63106",
    });
    expect(event?.errorCode).toBe("63106");
  });

  it("rejects payloads without sid or status", () => {
    expect(buildTwilioStatusEvent({ MessageSid: "SM123" })).toBeNull();
    expect(buildTwilioStatusEvent({ MessageStatus: "read" })).toBeNull();
  });
});

describe("resolveRcsStatusCallbackUrl", () => {
  it("appends /status to the public webhook url", () => {
    expect(resolveRcsStatusCallbackUrl("https://x.example/webhooks/rcs")).toBe(
      "https://x.example/webhooks/rcs/status",
    );
    expect(resolveRcsStatusCallbackUrl("https://x.example/webhooks/rcs/")).toBe(
      "https://x.example/webhooks/rcs/status",
    );
    expect(resolveRcsStatusCallbackUrl("")).toBe("");
  });
});

describe("sendRcsViaTwilio", () => {
  it("sends rcs-only messages through the messaging service", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("To")).toBe("rcs:+15551234567");
      expect(body.get("MessagingServiceSid")).toBe("MG123");
      expect(body.get("From")).toBeNull();
      return new Response(
        JSON.stringify({ sid: "SM1", to: "rcs:+15551234567", status: "accepted" }),
        { status: 201 },
      );
    });
    const result = await sendRcsViaTwilio({
      account: createAccount(),
      to: "+15551234567",
      text: "hello",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.sid).toBe("SM1");
  });

  it("keeps bare E.164 for rcs-preferred fallback sends", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = expectRequestBody(init);
      expect(body.get("To")).toBe("+15551234567");
      return new Response(JSON.stringify({ sid: "SM1", to: "+15551234567" }), { status: 201 });
    });
    await sendRcsViaTwilio({
      account: createAccount({ transport: "rcs-preferred" }),
      to: "+15551234567",
      text: "hello",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  });

  it("uses the sender id as From without a messaging service", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("From")).toBe("rcs:myagent_abc_agent");
      expect(body.get("MessagingServiceSid")).toBeNull();
      return new Response(JSON.stringify({ sid: "SM2" }), { status: 201 });
    });
    await sendRcsViaTwilio({
      account: createAccount({ messagingServiceSid: "", senderId: "rcs:myagent_abc_agent" }),
      to: "+15551234567",
      text: "hello",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("appends MediaUrl entries for media sends", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.getAll("MediaUrl")).toEqual(["https://cdn.example/a.png"]);
      return new Response(JSON.stringify({ sid: "SM3" }), { status: 201 });
    });
    await sendRcsViaTwilio({
      account: createAccount(),
      to: "+15551234567",
      mediaUrls: ["https://cdn.example/a.png"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requests status callbacks when enabled", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("StatusCallback")).toBe("https://gateway.example.com/webhooks/rcs/status");
      return new Response(JSON.stringify({ sid: "SM4" }), { status: 201 });
    });
    await sendRcsViaTwilio({
      account: createAccount({ statusCallbacks: true }),
      to: "+15551234567",
      text: "hello",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws a typed error on Twilio failures", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 63106, message: "not RCS enabled" }), {
          status: 400,
        }),
    );
    await expect(
      sendRcsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "TwilioRcsApiError",
      twilioCode: 63106,
    } satisfies Partial<TwilioRcsApiError>);
  });

  it("bounds and cancels oversized guarded Twilio error bodies", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedTextResponse(`${"upstream unavailable ".repeat(512)}tail`, {
      status: 503,
    });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: tracked.response,
      release,
    });

    let caught: Error | undefined;
    try {
      await sendRcsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("Twilio RCS send failed (503): upstream unavailable");
    expect(caught?.message).toContain("... [truncated]");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("requires text or media", async () => {
    await expect(
      sendRcsViaTwilio({ account: createAccount(), to: "+15551234567" }),
    ).rejects.toThrow(/text or media/);
  });

  it("rejects malformed JSON from successful Twilio sends", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("not json", { status: 201 }));

    await expect(
      sendRcsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
        fetchImpl,
      }),
    ).rejects.toThrow("Twilio RCS send returned malformed JSON.");
  });

  it("bounds and cancels oversized guarded Twilio success bodies", async () => {
    const release = vi.fn(async () => {});
    const tracked = cancelTrackedTextResponse("x".repeat(1024 * 1024 + 1), { status: 201 });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: tracked.response,
      release,
    });

    await expect(
      sendRcsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        text: "hello",
      }),
    ).rejects.toThrow(
      "Twilio RCS API response body too large: 1048577 bytes (limit: 1048576 bytes)",
    );

    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("Twilio RCS content sends", () => {
  const spec: TwilioContentSpec = {
    contentType: "card",
    request: {
      friendly_name: "openclaw_rcs_dynamic",
      language: "en",
      types: {
        "twilio/card": {
          title: "Pick",
          actions: [{ type: "QUICK_REPLY", id: "yes", title: "Yes" }],
        },
      },
    },
    variables: {},
  };

  it("creates the content template then sends the message by ContentSid", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = expectRequestUrl(url);
      calls.push(requestUrl);
      if (requestUrl === "https://content.twilio.com/v1/Content") {
        return new Response(JSON.stringify({ sid: "HX9" }), { status: 201 });
      }
      const body = expectRequestBody(init);
      expect(requestUrl).toContain("/Messages.json");
      expect(body.get("ContentSid")).toBe("HX9");
      expect(body.get("MessagingServiceSid")).toBe("MG123");
      expect(body.get("To")).toBe("rcs:+15551234567");
      expect(body.get("Body")).toBeNull();
      return new Response(
        JSON.stringify({ sid: "SM9", to: "rcs:+15551234567", status: "queued" }),
        { status: 201 },
      );
    });
    const result = await sendRcsContentViaTwilio({
      account: createAccount(),
      to: "+15551234567",
      content: spec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.sid).toBe("SM9");
    expect(calls[0]).toBe("https://content.twilio.com/v1/Content");
    expect(calls[1]).toContain("/Messages.json");
  });

  it("serializes ContentVariables when the spec includes them", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (expectRequestUrl(url) === "https://content.twilio.com/v1/Content") {
        return new Response(JSON.stringify({ sid: "HX7" }), { status: 201 });
      }
      const body = expectRequestBody(init);
      expect(body.get("ContentVariables")).toBe('{"1":"Ada"}');
      return new Response(JSON.stringify({ sid: "SM7" }), { status: 201 });
    });
    await sendRcsContentViaTwilio({
      account: createAccount(),
      to: "+15551234567",
      content: { ...spec, variables: { "1": "Ada" } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws a typed error when content creation fails", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 20422, message: "invalid content" }), { status: 400 }),
    );
    await expect(
      sendRcsContentViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        content: spec,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "TwilioRcsApiError",
      twilioCode: 20422,
    } satisfies Partial<TwilioRcsApiError>);
  });

  it("uses the sender id as From for content sends without a messaging service", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (expectRequestUrl(url) === "https://content.twilio.com/v1/Content") {
        return new Response(JSON.stringify({ sid: "HX5" }), { status: 201 });
      }
      const body = expectRequestBody(init);
      expect(body.get("From")).toBe("rcs:myagent_abc_agent");
      expect(body.get("MessagingServiceSid")).toBeNull();
      return new Response(JSON.stringify({ sid: "SM5" }), { status: 201 });
    });
    await sendRcsContentViaTwilio({
      account: createAccount({ messagingServiceSid: "", senderId: "rcs:myagent_abc_agent" }),
      to: "+15551234567",
      content: spec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("Twilio RCS lookup helpers", () => {
  it("rejects malformed JSON from Twilio Messaging Service lookup", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("NOT JSON {{{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      retrieveTwilioMessagingService({
        account: createAccount({ messagingServiceSid: "MG123" }),
        serviceSid: "MG123",
        fetchImpl,
      }),
    ).rejects.toThrow("Twilio Messaging Service lookup returned malformed JSON.");
  });
});

describe("Twilio signature validation", () => {
  it("round-trips signature computation and verification", () => {
    const form = parseTwilioFormBody("Body=hi&From=rcs%3A%2B15551234567&MessageSid=SM1");
    const url = "https://gateway.example.com/webhooks/rcs";
    const signature = "QYB6bLhZa+Zesj+IEnLcbIkL8bA=";
    expect(verifyTwilioSignature({ signature, url, authToken: "secret", form })).toBe(true);
    expect(verifyTwilioSignature({ signature, url, authToken: "other", form })).toBe(false);
  });
});

describe("resolveTwilioWebhookSignatureUrl", () => {
  // Twilio signs the exact URL it posted to, including any query string added by the reverse proxy.
  // These cases protect the critical path: a URL mismatch is the #1 cause of 403 on signature checks.
  const req = (url: string) =>
    ({ url }) as Parameters<typeof resolveTwilioWebhookSignatureUrl>[0]["req"];

  it("returns publicWebhookUrl unchanged when request has no query string", () => {
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: req("/webhooks/rcs"),
        publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      }),
    ).toBe("https://gateway.example.com/webhooks/rcs");
  });

  it("appends request query to publicWebhookUrl when publicWebhookUrl has no query", () => {
    // Reverse proxy may add ?foo=bar to the inbound request path.
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: req("/webhooks/rcs?foo=bar"),
        publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      }),
    ).toBe("https://gateway.example.com/webhooks/rcs?foo=bar");
  });

  it("returns publicWebhookUrl as-is when it already has a query string (pre-configured wins)", () => {
    // If the operator has a query in publicWebhookUrl, use that exact string for signature.
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: req("/webhooks/rcs?req=1"),
        publicWebhookUrl: "https://gateway.example.com/webhooks/rcs?configured=1",
      }),
    ).toBe("https://gateway.example.com/webhooks/rcs?configured=1");
  });

  it("inserts request query before fragment in publicWebhookUrl", () => {
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: req("/webhooks/rcs?foo=bar"),
        publicWebhookUrl: "https://gateway.example.com/webhooks/rcs#section",
      }),
    ).toBe("https://gateway.example.com/webhooks/rcs?foo=bar#section");
  });

  it("handles a malformed request url gracefully", () => {
    expect(
      resolveTwilioWebhookSignatureUrl({
        req: req("not-a-url"),
        publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      }),
    ).toBe("https://gateway.example.com/webhooks/rcs");
  });
});
