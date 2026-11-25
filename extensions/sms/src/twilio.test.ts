import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForEffectPreparation } from "../../test-support/effect-preparation.test-support.js";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { resolveTwilioStatusCallbackUrl } from "./public-webhook-url.js";
import {
  buildTwilioInboundMessage,
  listTwilioIncomingPhoneNumbers,
  listTwilioMessages,
  readTwilioWebhookForm,
  resolveTwilioWebhookSignatureUrl,
  retrieveTwilioMessagingService,
  sendSmsViaTwilio,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";
import {
  createSmsTestAccount,
  createSmsTestForm,
  createSmsTestMessage,
  createSmsTestPhoneNumber,
  signSmsTestForm,
} from "./webhook.test-support.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const WEBHOOK = "https://gateway.example.com/webhooks/sms";
const RETRIES = "rp=ct,rt,5xx&rt=5000&rc=1";

const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

function mockTwilioFetch(implementation?: typeof fetch) {
  const fetchImpl = vi.fn<typeof fetch>(implementation);
  fetchWithSsrFGuardMock.mockImplementation(async ({ url, init, beforeRequest }) => {
    await effectGate.prepare?.();
    beforeRequest?.();
    return { response: await fetchImpl(url, init), release: async () => {} };
  });
  return fetchImpl;
}

function createAccount(overrides: Partial<ResolvedSmsAccount> = {}): ResolvedSmsAccount {
  return createSmsTestAccount({ accountId: "default", ...overrides });
}

function createTwilioSendInput(account = createAccount(), text = "hello") {
  return { account, to: "+15551234567", text };
}

function inboundForm(fields: Record<string, string> = {}) {
  return createSmsTestForm({ AccountSid: "", ...fields });
}

function signatureInput(form: Record<string, string>) {
  return { form, url: WEBHOOK, authToken: "secret", signature: signSmsTestForm(form).signature };
}

function mockResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValue({ response, release });
  return release;
}

function mockJson(payload: unknown, status = 201) {
  return mockTwilioFetch(async () => Response.json(payload, { status }));
}

function send(account = createAccount(), text = "hello") {
  return sendSmsViaTwilio(createTwilioSendInput(account, text));
}

function readUrlEncodedRequestBody(init: RequestInit | undefined): URLSearchParams {
  if (typeof init?.body === "string") {
    return new URLSearchParams(init.body);
  }
  if (init?.body instanceof URLSearchParams) {
    return init.body;
  }
  throw new Error("Expected Twilio request body to be URL-encoded.");
}

async function readTestTwilioForm(body: string): Promise<Record<string, string>> {
  const req = createMockIncomingRequest([body]);
  req.headers = { "content-length": String(Buffer.byteLength(body)) };
  return await readTwilioWebhookForm(req);
}

describe("Twilio SMS helpers", () => {
  it.each([false, true])(
    "rechecks guarded credentials after transport preparation (replaced=%s)",
    async (replaced) => {
      const preparing = createDeferred();
      const prepared = createDeferred();
      const dispatched = createDeferred();
      const response = createDeferred<Response>();
      const account = createAccount();
      setRuntimeConfigSnapshot({ channels: { sms: account } } as never);
      const replace = () =>
        setRuntimeConfigSnapshot({
          channels: { sms: { ...account, authToken: "replacement" } },
        } as never);
      effectGate.prepare = async () => {
        preparing.resolve();
        await prepared.promise;
      };
      const fetchImpl = mockTwilioFetch(() => {
        dispatched.resolve();
        return response.promise;
      });
      const sending = sendSmsViaTwilio(createTwilioSendInput(account)).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await waitForEffectPreparation(preparing.promise, dispatched.promise, sending);
        expect(fetchImpl).not.toHaveBeenCalled();
        if (replaced) {
          replace();
        }
        prepared.resolve();
        if (!replaced) {
          await dispatched.promise;
          replace();
        }
        response.resolve(Response.json({ sid: "SM456" }));
        const outcome = await sending;
        if (replaced) {
          expect(outcome).toMatchObject({
            error: {
              name: "PlatformMessageNotDispatchedError",
              cause: { message: "SMS credentials changed for default; retry the operation." },
            },
          });
          expect("error" in outcome && outcome.error).toBeInstanceOf(
            PlatformMessageNotDispatchedError,
          );
        } else {
          expect(outcome).toEqual({ value: { sid: "SM456", to: "+15551234567" } });
        }
        expect(fetchImpl).toHaveBeenCalledTimes(replaced ? 0 : 1);
      } finally {
        prepared.resolve();
        response.resolve(Response.json({ sid: "SM456" }));
        await sending;
        effectGate.prepare = undefined;
      }
    },
  );

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    clearRuntimeConfigSnapshot();
  });

  it("parses Twilio form bodies and inbound messages", async () => {
    const form = await readTestTwilioForm(
      "From=%2B15551234567&To=%2B15557654321&Body=hello+there&MessageSid=SM123",
    );

    expect(form).toEqual({
      From: "+15551234567",
      To: "+15557654321",
      Body: "hello there",
      MessageSid: "SM123",
    });
    expect(buildTwilioInboundMessage(form)).toEqual({
      from: "+15551234567",
      to: "+15557654321",
      body: "hello there",
      messageSid: "SM123",
      accountSid: "",
      media: [],
    });
  });

  it("parses media-only Twilio MMS callbacks in provider order", async () => {
    const form = await readTestTwilioForm(
      new URLSearchParams(
        inboundForm({
          Body: "",
          MessageSid: "MM123",
          NumMedia: "2",
          MediaUrl0: "https://api.twilio.com/media/first",
          MediaContentType0: "image/jpeg",
          MediaUrl1: "https://api.twilio.com/media/second",
          MediaContentType1: "video/mp4",
        }),
      ).toString(),
    );

    expect(buildTwilioInboundMessage(form)).toEqual({
      from: "+15551234567",
      to: "+15557654321",
      body: "",
      messageSid: "MM123",
      accountSid: "",
      media: [
        { url: "https://api.twilio.com/media/first", contentType: "image/jpeg" },
        { url: "https://api.twilio.com/media/second", contentType: "video/mp4" },
      ],
    });
  });

  it("preserves the signed Messaging Service identity on inbound messages", () => {
    expect(
      buildTwilioInboundMessage(inboundForm({ AccountSid: "AC123", MessagingServiceSid: "MG123" })),
    ).toMatchObject({
      accountSid: "AC123",
      messagingServiceSid: "MG123",
      messageSid: "SM123",
    });
  });

  it("rejects malformed counts and marks missing Twilio MMS media as unavailable", () => {
    const base = inboundForm({
      Body: "",
      MessageSid: "MM123",
      MediaUrl0: "https://api.twilio.com/media/first",
    });
    expect(buildTwilioInboundMessage({ ...base, NumMedia: "not-a-number" })).toBeNull();
    expect(buildTwilioInboundMessage({ ...base, NumMedia: "1", MediaUrl0: "" })).toMatchObject({
      media: [],
      unavailableMediaCount: 1,
    });
  });

  it("bounds inbound downloads without discarding a signed message with more media", () => {
    const mediaFields = Object.fromEntries(
      Array.from({ length: 11 }, (_value, index) => [
        `MediaUrl${index}`,
        `https://api.twilio.com/media/${index}`,
      ]),
    );

    expect(
      buildTwilioInboundMessage(
        inboundForm({ Body: "", MessageSid: "MM123", NumMedia: "11", ...mediaFields }),
      ),
    ).toMatchObject({
      media: Array.from({ length: 10 }, (_value, index) => ({
        url: `https://api.twilio.com/media/${index}`,
      })),
      unavailableMediaCount: 1,
    });
  });

  it.each([
    ["+1 (555) 123-4567", "+15551234567"],
    ["RcS:+1 (555) 123-4567", "+15551234567"],
    ["whatsapp:+15551234567", null],
    ["signal:+15551234567", null],
  ] as const)("accepts only supported Twilio inbound From address %s", (from, expected) => {
    const msg = buildTwilioInboundMessage(inboundForm({ From: from }));
    expect(msg?.from ?? null).toBe(expected);
  });

  it("verifies Twilio signatures over sorted form fields", () => {
    // Twilio's published vector independently checks the shared signer and verifier.
    // https://www.twilio.com/docs/usage/security#explore-the-algorithm-yourself
    const account = createAccount({
      publicWebhookUrl: "https://example.com/myapp.php?foo=1&bar=2",
      authToken: "12345",
    });
    const form = {
      To: "+18005551212",
      Digits: "1234",
      From: "+14158675310",
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
    };
    const input = {
      form,
      url: account.publicWebhookUrl,
      authToken: account.authToken,
      signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=",
    };
    expect(signSmsTestForm(form, account).signature).toBe(input.signature);
    expect(verifyTwilioSignature(input)).toBe(true);
    expect(verifyTwilioSignature({ ...input, url: `${input.url}&other=1` })).toBe(false);
    expect(verifyTwilioSignature({ ...input, authToken: "wrong-token" })).toBe(false);
    expect(verifyTwilioSignature({ ...input, form: { ...form, Digits: "4321" } })).toBe(false);
    expect(verifyTwilioSignature({ ...input, signature: input.signature.slice(0, -1) })).toBe(
      false,
    );
  });

  it("preserves signed form values before signature verification", async () => {
    const form = await readTestTwilioForm(
      "From=%2B15551234567&To=%2B15557654321&Body=+hello+&MessageSid=SM123&WaId=",
    );
    expect(form.Body).toBe(" hello ");
    expect(form.WaId).toBe("");
    expect(verifyTwilioSignature(signatureInput(form))).toBe(true);
    expect(buildTwilioInboundMessage(form)?.body).toBe(" hello ");
  });

  it("sends SMS through Twilio's Messages API", async () => {
    const fetchImpl = mockJson({
      sid: "SM456",
      to: "+15551234567",
      from: "+15557654321",
      status: "queued",
    });
    await expect(
      send(createAccount({ publicWebhookUrl: `${WEBHOOK}#rp=4xx`, messagingServiceSid: "MG123" })),
    ).resolves.toEqual({
      sid: "SM456",
      to: "+15551234567",
      from: "+15557654321",
      status: "queued",
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    });
    const body = readUrlEncodedRequestBody(init);
    expect(body.get("From")).toBe("+15557654321");
    expect(body.has("MessagingServiceSid")).toBe(false);
    expect(body.get("To")).toBe("+15551234567");
    expect(body.get("Body")).toBe("hello");
    expect(body.get("StatusCallback")).toBe(`${WEBHOOK}#rp=4xx,ct,rt,5xx&rt=5000&rc=1`);
  });

  it("opts delivery commits into bounded connection, timeout, and 5xx retries", () => {
    const callbackUrl = resolveTwilioStatusCallbackUrl("https://gateway.example.com/webhooks/sms");
    const overrides = new URLSearchParams(callbackUrl.split("#")[1]);

    expect(overrides.get("rp")?.split(",")).toEqual(["ct", "rt", "5xx"]);
    expect(overrides.get("rt")).toBe("5000");
    expect(overrides.get("rc")).toBe("1");
  });

  it.each([
    ["", `#${RETRIES}`, "http:"],
    ["?tenant=support#rp=4xx", "?tenant=support#rp=4xx,ct,rt,5xx&rt=5000&rc=1"],
    ["#rt=5000&rp=all&rc=3", "#rt=5000&rp=all&rc=3"],
    ["#rt=1200&rp=ct", "#rt=1200&rp=ct,rt,5xx&rc=1"],
    ["#rt=16000", "#rt=5000&rp=ct,rt,5xx&rc=1"],
    ["#e=singapore&rc=0", "#e=singapore&rc=1&rp=ct,rt,5xx&rt=5000"],
  ])("preserves or repairs callback overrides %s", (input, expected, protocol = "https:") => {
    const base = WEBHOOK.replace("https:", protocol);
    expect(resolveTwilioStatusCallbackUrl(`${base}${input}`)).toBe(`${base}${expected}`);
  });

  it("omits the delivery callback when no public webhook URL is configured", () => {
    expect(resolveTwilioStatusCallbackUrl("   ")).toBe("");
  });

  it("enforces OpenClaw's defensive 4,000-character status callback cap", () => {
    const prefix = "https://gateway.example.com/webhooks/sms?x=";
    const suffix = "#rp=ct,rt,5xx&rt=5000&rc=1";
    const paddingLength = 4_000 - prefix.length - suffix.length;
    const atLimit = `${prefix}${"a".repeat(paddingLength)}`;

    expect(resolveTwilioStatusCallbackUrl(atLimit)).toHaveLength(4_000);
    expect(resolveTwilioStatusCallbackUrl(`${atLimit}a`)).toBe("");
  });

  it.each([
    ["relative", "placeholder"],
    ["malformed", "https://"],
    ["missing authority slashes", "https:gateway.example.com/webhooks/sms"],
    ["single authority slash", "https:/gateway.example.com/webhooks/sms"],
    ["backslash", String.raw`https://gateway.example.com\webhooks\sms`],
    ["invalid percent escape", "https://gateway.example.com/webhooks/sms?x=%ZZ"],
    ["raw query pipe", "https://gateway.example.com/webhooks/sms?x=|"],
    ["raw query caret", "https://gateway.example.com/webhooks/sms?x=^"],
    ["raw query backtick", "https://gateway.example.com/webhooks/sms?x=`"],
    ["raw query braces", "https://gateway.example.com/webhooks/sms?x={}"],
    ["percent-encoded hostname", "https://%65xample.com/webhooks/sms"],
    ["invalid hostname", "https://sms_gateway.example.com/webhooks/sms"],
    ["single-label hostname", "http://gateway/webhooks/sms"],
    ["localhost", "http://localhost/webhooks/sms"],
    ["IPv4 loopback", "http://127.0.0.1/webhooks/sms"],
    ["legacy numeric IPv4 loopback", "http://2130706433/webhooks/sms"],
    ["unspecified IPv4", "http://0.0.0.0/webhooks/sms"],
    ["private IPv4", "http://10.0.0.1/webhooks/sms"],
    ["carrier-grade NAT IPv4", "http://100.64.0.1/webhooks/sms"],
    ["link-local IPv4", "http://169.254.169.254/webhooks/sms"],
    ["IPv6 loopback", "http://[::1]/webhooks/sms"],
    ["private IPv6", "http://[fd00::1]/webhooks/sms"],
  ])(
    "keeps text sending available with a %s public webhook URL",
    async (_name, publicWebhookUrl) => {
      const fetchImpl = mockJson({ sid: "SM-no-callback" });

      await expect(send(createAccount({ publicWebhookUrl }))).resolves.toMatchObject({
        sid: "SM-no-callback",
      });

      const body = readUrlEncodedRequestBody(fetchImpl.mock.calls[0]?.[1]);
      expect(body.has("StatusCallback")).toBe(false);
    },
  );

  it("marks dispatch immediately before the Twilio POST", async () => {
    const events: string[] = [];
    mockTwilioFetch(async () => {
      events.push("post");
      return Response.json({ sid: "SM-dispatched" }, { status: 201 });
    });
    const onPlatformSendDispatch = vi.fn(async () => {
      events.push("dispatch");
    });

    await sendSmsViaTwilio({ ...createTwilioSendInput(), onPlatformSendDispatch });

    expect(events).toEqual(["dispatch", "post"]);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("does not mark dispatch for an invalid Twilio send", async () => {
    const onPlatformSendDispatch = vi.fn(async () => {});

    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        onPlatformSendDispatch,
      }),
    ).rejects.toThrow("Twilio SMS/MMS send requires text or media.");

    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["before the first request", false, true],
    ["before a redirect hop", true, false],
  ] as const)("classifies credential replacement %s", async (_name, redirect, notDispatched) => {
    const account = createAccount();
    setRuntimeConfigSnapshot({ channels: { sms: account } } as never);
    const replacement = { ...account, authToken: "replacement" };
    const fetchImpl = mockTwilioFetch();
    if (redirect) {
      fetchWithSsrFGuardMock.mockImplementationOnce(async (params) => {
        expect(params.beforeRequest).toBeTypeOf("function");
        params.beforeRequest?.();
        setRuntimeConfigSnapshot({ channels: { sms: replacement } } as never);
        params.beforeRequest?.();
        throw new Error("expected credential rejection");
      });
    }

    const rejection = await sendSmsViaTwilio({
      account,
      to: "+15551234567",
      text: "hello",
      onPlatformSendDispatch: async () => {
        if (!redirect) {
          setRuntimeConfigSnapshot({ channels: { sms: replacement } } as never);
        }
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof PlatformMessageNotDispatchedError).toBe(notDispatched);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends MMS with repeated MediaUrl fields and no required text body", async () => {
    const fetchImpl = mockJson({ sid: "MM456" });

    await sendSmsViaTwilio({
      account: createAccount(),
      to: "+15551234567",
      mediaUrls: [
        "https://gateway.example.com/media/first",
        "https://gateway.example.com/media/second",
      ],
    });

    const body = readUrlEncodedRequestBody(fetchImpl.mock.calls[0]?.[1]);
    expect(body.get("Body")).toBeNull();
    expect(body.getAll("MediaUrl")).toEqual([
      "https://gateway.example.com/media/first",
      "https://gateway.example.com/media/second",
    ]);
  });

  it("rejects outbound MMS requests above Twilio's media count limit", async () => {
    await expect(
      sendSmsViaTwilio({
        account: createAccount(),
        to: "+15551234567",
        mediaUrls: Array.from({ length: 11 }, (_, index) => `https://example.com/${index}.jpg`),
      }),
    ).rejects.toThrow("Twilio MMS send supports at most 10 media URLs");
  });

  it("enforces Twilio's provider-owned Message Body limit", async () => {
    const fetchImpl = mockJson({ sid: "SM1600" });
    await expect(send(createAccount(), "x".repeat(1600))).resolves.toMatchObject({ sid: "SM1600" });
    await expect(send(createAccount(), "x".repeat(1601))).rejects.toThrow(
      "Twilio SMS/MMS Body supports at most 1600 characters",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "phone-number webhook settings",
      payload: {
        incoming_phone_numbers: [
          createSmsTestPhoneNumber({ voice_url: "https://gateway.example.com/voice/webhook" }),
        ],
      },
      request: () =>
        listTwilioIncomingPhoneNumbers({ account: createAccount(), phoneNumber: "+15557654321" }),
      expected: [
        {
          phoneNumber: "+15557654321",
          smsUrl: WEBHOOK,
          smsMethod: "POST",
          voiceUrl: "https://gateway.example.com/voice/webhook",
        },
      ],
      url: "https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json?PhoneNumber=%2B15557654321",
    },
    {
      name: "recent messages for diagnostics",
      payload: {
        messages: [
          createSmsTestMessage({
            error_code: 11200,
            body: "hello",
            date_created: "Sun, 31 May 2026 10:00:00 +0000",
            date_sent: null,
          }),
        ],
      },
      request: () => listTwilioMessages({ account: createAccount(), to: "+15557654321" }),
      expected: [
        {
          sid: "SM123",
          direction: "inbound",
          status: "received",
          errorCode: "11200",
          dateCreated: "Sun, 31 May 2026 10:00:00 +0000",
          dateSent: "",
        },
      ],
      url: "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json?To=%2B15557654321&PageSize=3",
    },
    {
      name: "Messaging Service webhook settings",
      payload: {
        sid: "MG123",
        inbound_request_url: WEBHOOK,
        inbound_method: "POST",
        use_inbound_webhook_on_number: false,
      },
      request: () =>
        retrieveTwilioMessagingService({
          account: createAccount({ messagingServiceSid: "MG123", fromNumber: "" }),
          serviceSid: "MG123",
        }),
      expected: {
        sid: "MG123",
        inboundRequestUrl: WEBHOOK,
        inboundMethod: "POST",
        useInboundWebhookOnNumber: false,
      },
      url: "https://messaging.twilio.com/v1/Services/MG123",
    },
  ])("reads $name", async ({ payload, request, expected, url: expectedUrl }) => {
    const fetchImpl = mockJson(payload, 200);
    await expect(request()).resolves.toEqual(expected);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(expectedUrl);
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
    });
  });

  it("can send through a Twilio Messaging Service SID", async () => {
    const fetchImpl = mockJson({ sid: "SM789" });
    await send(createAccount({ fromNumber: "", messagingServiceSid: "MG123" }));

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = readUrlEncodedRequestBody(init);
    expect(body.get("MessagingServiceSid")).toBe("MG123");
    expect(body.get("To")).toBe("+15551234567");
    expect(body.get("Body")).toBe("hello");
    expect(body.get("StatusCallback")).toBe(`${WEBHOOK}#${RETRIES}`);
  });

  it("reports actionable Twilio errors from JSON error bodies", async () => {
    mockJson({ code: 21610, message: "The message From/To pair violates a blacklist rule." }, 400);

    await expect(send()).rejects.toMatchObject({
      name: "TwilioSmsApiError",
      message: "Twilio SMS send failed (400): The message From/To pair violates a blacklist rule.",
    });
  });

  it("redacts credentials reflected in Twilio error text", async () => {
    const account = createAccount();
    const encodedCredential = Buffer.from(`${account.accountSid}:${account.authToken}`).toString(
      "base64",
    );
    mockTwilioFetch(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toBe(`Basic ${encodedCredential}`);
      return new Response(`upstream unavailable; Authorization: ${authorization}`, {
        status: 503,
      });
    });

    const caught = await send(account).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      message: "Twilio SMS send failed (503): upstream unavailable; Authorization: Basic ***",
    });
    expect(String(caught)).not.toContain(encodedCredential);
  });

  it("releases guarded Twilio egress on failed send responses", async () => {
    const release = mockResponse(new Response("upstream unavailable", { status: 503 }));

    await expect(send()).rejects.toThrow("Twilio SMS send failed (503): upstream unavailable");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "sms-twilio-api",
        policy: { allowedHostnames: ["api.twilio.com"] },
        requireHttps: true,
        timeoutMs: 30_000,
        url: "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json",
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds guarded Twilio errors on complete UTF-8 characters and cancels overflow", async () => {
    const tracked = cancelTrackedTextResponse(`${"x".repeat(8 * 1024 - 2)}😀tail`, {
      status: 503,
    });
    const release = mockResponse(tracked.response);
    const caught = await send().catch((error: unknown) => error);
    if (!(caught instanceof Error)) {
      throw new Error("expected Twilio send failure");
    }

    expect(caught.message).toContain("Twilio SMS send failed (503): ");
    expect(caught.message).toContain("... [truncated]");
    expect(caught.message).not.toContain("�");
    expect(caught.message).not.toContain("tail");
    expect(caught.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases guarded Twilio egress on malformed successful send responses", async () => {
    const release = mockResponse(new Response("not json", { status: 201 }));

    await expect(send()).rejects.toThrow("Twilio SMS send returned malformed JSON.");

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON from Twilio Messaging Service lookup", async () => {
    mockTwilioFetch(
      async () => new Response("NOT JSON {{{", { headers: { "content-type": "application/json" } }),
    );

    await expect(
      retrieveTwilioMessagingService({
        account: createAccount({ messagingServiceSid: "MG123", fromNumber: "" }),
        serviceSid: "MG123",
      }),
    ).rejects.toThrow("Twilio Messaging Service lookup returned malformed JSON.");
  });

  it("returns empty list on malformed JSON from Twilio incoming phone number list", async () => {
    mockTwilioFetch(
      async () => new Response("NOT JSON {{{", { headers: { "content-type": "application/json" } }),
    );

    const result = await listTwilioIncomingPhoneNumbers({
      account: createAccount(),
      phoneNumber: "+15557654321",
    });

    expect(result).toEqual([]);
  });

  it("bounds and cancels oversized guarded Twilio success bodies", async () => {
    const tracked = cancelTrackedTextResponse("x".repeat(1024 * 1024 + 1), { status: 201 });
    const release = mockResponse(tracked.response);

    await expect(send()).rejects.toThrow(
      "Twilio SMS API response body too large: 1048577 bytes (limit: 1048576 bytes)",
    );

    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("requires successful Twilio sends to include a Message SID", async () => {
    mockJson({ status: "queued" });

    await expect(send()).rejects.toThrow("Twilio SMS send response did not include a Message SID.");
  });

  it.each([
    ["adds request query", "/webhooks/sms?foo=bar", `${WEBHOOK}#rp=4xx`, `${WEBHOOK}?foo=bar`],
    [
      "preserves configured query",
      "/webhooks/sms?foo=request",
      `${WEBHOOK}?foo=configured#rp=all`,
      `${WEBHOOK}?foo=configured`,
    ],
    [
      "preserves explicit port",
      "/webhooks/sms",
      "https://gateway.example.com:443/webhooks/sms#rp=4xx",
      "https://gateway.example.com:443/webhooks/sms",
    ],
  ])("strips signature URL fragment and %s", (_name, url, publicWebhookUrl, expected) => {
    expect(resolveTwilioWebhookSignatureUrl({ req: { url } as never, publicWebhookUrl })).toBe(
      expected,
    );
  });
});
