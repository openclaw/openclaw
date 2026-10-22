import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import type { SmsDeliveryRecord } from "./delivery-observations.js";
import { resolveTwilioStatusCallbackUrl } from "./public-webhook-url.js";
import { formatSmsProbeLines, probeSmsAccount } from "./status.js";
import {
  buildTwilioInboundMessage,
  listTwilioIncomingPhoneNumbers,
  readTwilioWebhookForm,
  resolveTwilioWebhookSignatureUrl,
  retrieveTwilioMessagingService,
  sendSmsViaTwilio,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";
import {
  createSmsTestAccount,
  signSmsTestForm,
  createSmsTestPhoneNumber,
  createSmsTestMessage,
} from "./webhook.test-support.js";

const WEBHOOK = "https://gateway.example.com/webhooks/sms";
const TO = "+15551234567";
const FROM = "+15557654321";
const SIGNATURE_BASE = "https://gateway.example.com/base";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

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

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  clearRuntimeConfigSnapshot();
});

function createAccount(overrides: Partial<ResolvedSmsAccount> = {}): ResolvedSmsAccount {
  return createSmsTestAccount({ accountId: "default", ...overrides });
}

function send(overrides: Partial<Parameters<typeof sendSmsViaTwilio>[0]> = {}) {
  return sendSmsViaTwilio({ account: createAccount(), to: TO, text: "hello", ...overrides });
}

function inboundForm(overrides: Record<string, string> = {}) {
  return { From: TO, To: FROM, Body: "hello", MessageSid: "SM123", ...overrides };
}

function guardedResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValue({ response, release });
  return release;
}

function jsonResponse(payload: unknown, status = 201) {
  return mockTwilioFetch(async () => Response.json(payload, { status }));
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
      const sending = send({ account }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          preparing.promise,
          dispatched.promise.then(() => {
            throw new Error("dispatched before preparation");
          }),
          sending.then(() => {
            throw new Error("settled before preparation");
          }),
        ]);
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
          expect(outcome).toEqual({ value: { sid: "SM456", to: TO } });
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
      from: TO,
      to: FROM,
      body: "",
      messageSid: "MM123",
      accountSid: "",
      media: [
        { url: "https://api.twilio.com/media/first", contentType: "image/jpeg" },
        { url: "https://api.twilio.com/media/second", contentType: "video/mp4" },
      ],
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
    ["+1 (555) 123-4567", TO],
    ["RcS:+1 (555) 123-4567", TO],
    ["whatsapp:+15551234567", null],
    ["signal:+15551234567", null],
  ] as const)("accepts only supported Twilio inbound From address %s", (from, expected) => {
    const msg = buildTwilioInboundMessage(inboundForm({ From: from }));

    expect(msg?.from ?? null).toBe(expected);
  });

  it("verifies Twilio signatures over sorted form fields", () => {
    const params = { url: WEBHOOK, authToken: "secret", form: inboundForm() };
    const { signature } = signSmsTestForm(params.form, createAccount());
    expect(verifyTwilioSignature({ ...params, signature })).toBe(true);
    expect(verifyTwilioSignature({ ...params, signature, url: `${params.url}/other` })).toBe(false);
    expect(verifyTwilioSignature({ ...params, signature: signature.slice(0, -1) })).toBe(false);
  });

  it("preserves signed form values before signature verification", async () => {
    const form = await readTestTwilioForm(
      "From=%2B15551234567&To=%2B15557654321&Body=+hello+&MessageSid=SM123&WaId=",
    );
    const { signature } = signSmsTestForm(form, createAccount());

    expect(form.Body).toBe(" hello ");
    expect(form.WaId).toBe("");
    expect(verifyTwilioSignature({ signature, url: WEBHOOK, authToken: "secret", form })).toBe(
      true,
    );
    expect(buildTwilioInboundMessage(form)?.body).toBe(" hello ");
  });

  it("sends SMS through Twilio's Messages API", async () => {
    const fetchImpl = mockTwilioFetch(async () =>
      Response.json({ sid: "SM456", to: TO, from: FROM, status: "queued" }, { status: 201 }),
    );

    await expect(
      send({ account: createAccount({ publicWebhookUrl: `${WEBHOOK}#rp=4xx` }) }),
    ).resolves.toEqual({ sid: "SM456", to: TO, from: FROM, status: "queued" });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    });
    const body = readUrlEncodedRequestBody(init);
    expect(Object.fromEntries(body)).toMatchObject({
      From: FROM,
      To: TO,
      Body: "hello",
      StatusCallback: `${WEBHOOK}#rp=4xx,ct,rt,5xx&rt=5000&rc=1`,
    });
  });

  it.each([
    [
      "http://gateway.example.com/webhooks/sms",
      "http://gateway.example.com/webhooks/sms#rp=ct,rt,5xx&rt=5000&rc=1",
    ],
    [`${WEBHOOK}?tenant=support#rp=4xx`, `${WEBHOOK}?tenant=support#rp=4xx,ct,rt,5xx&rt=5000&rc=1`],
    [`${WEBHOOK}#rt=5000&rp=all&rc=3`, `${WEBHOOK}#rt=5000&rp=all&rc=3`],
    [`${WEBHOOK}#rt=1200&rp=ct`, `${WEBHOOK}#rt=1200&rp=ct,rt,5xx&rc=1`],
    [`${WEBHOOK}#rt=16000`, `${WEBHOOK}#rt=5000&rp=ct,rt,5xx&rc=1`],
    [`${WEBHOOK}#e=singapore&rc=0`, `${WEBHOOK}#e=singapore&rc=1&rp=ct,rt,5xx&rt=5000`],
  ])("repairs callback overrides for %s", (input, expected) => {
    expect(resolveTwilioStatusCallbackUrl(input)).toBe(expected);
  });

  it("enforces OpenClaw's defensive 4,000-character status callback cap", () => {
    const prefix = `${WEBHOOK}?x=`;
    const suffix = "#rp=ct,rt,5xx&rt=5000&rc=1";
    const paddingLength = 4_000 - prefix.length - suffix.length;
    const atLimit = `${prefix}${"a".repeat(paddingLength)}`;

    expect(resolveTwilioStatusCallbackUrl(atLimit)).toHaveLength(4_000);
    expect(resolveTwilioStatusCallbackUrl(`${atLimit}a`)).toBe("");
  });

  it.each([
    ["empty", "   "],
    ["relative", "placeholder"],
    ["malformed", "https://"],
    ["missing authority slashes", "https:gateway.example.com/webhooks/sms"],
    ["single authority slash", "https:/gateway.example.com/webhooks/sms"],
    ["backslash", String.raw`https://gateway.example.com\webhooks\sms`],
    ["invalid percent escape", `${WEBHOOK}?x=%ZZ`],
    ["raw query pipe", `${WEBHOOK}?x=|`],
    ["raw query caret", `${WEBHOOK}?x=^`],
    ["raw query backtick", `${WEBHOOK}?x=\``],
    ["raw query braces", `${WEBHOOK}?x={}`],
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
      const fetchImpl = jsonResponse({ sid: "SM-no-callback" });

      await expect(send({ account: createAccount({ publicWebhookUrl }) })).resolves.toMatchObject({
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

    await send({ text: "hello", onPlatformSendDispatch });

    expect(events).toEqual(["dispatch", "post"]);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("does not mark dispatch for an invalid Twilio send", async () => {
    const onPlatformSendDispatch = vi.fn(async () => {});

    await expect(send({ text: undefined, onPlatformSendDispatch })).rejects.toThrow(
      "Twilio SMS/MMS send requires text or media.",
    );

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

    const rejection = await send({
      account,
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
    const fetchImpl = jsonResponse({ sid: "MM456" });

    await send({
      text: undefined,
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
      send({
        text: undefined,
        mediaUrls: Array.from({ length: 11 }, (_, index) => `https://example.com/${index}.jpg`),
      }),
    ).rejects.toThrow("Twilio MMS send supports at most 10 media URLs");
  });

  it("enforces Twilio's provider-owned Message Body limit", async () => {
    const fetchImpl = jsonResponse({ sid: "SM1600" });

    await expect(send({ text: "x".repeat(1600) })).resolves.toMatchObject({ sid: "SM1600" });
    await expect(send({ text: "x".repeat(1601) })).rejects.toThrow(
      "Twilio SMS/MMS Body supports at most 1600 characters",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["", FROM])("selects the Twilio sender with fromNumber=%s", async (fromNumber) => {
    const fetchImpl = jsonResponse({ sid: "SM789" });
    await send({ account: createAccount({ fromNumber, messagingServiceSid: "MG123" }) });
    expect(Object.fromEntries(readUrlEncodedRequestBody(fetchImpl.mock.calls[0]?.[1]))).toEqual({
      To: TO,
      Body: "hello",
      StatusCallback: `${WEBHOOK}#rp=ct,rt,5xx&rt=5000&rc=1`,
      ...(fromNumber ? { From: FROM } : { MessagingServiceSid: "MG123" }),
    });
  });

  it("throws structured Twilio errors from JSON error bodies", async () => {
    mockTwilioFetch(async () =>
      Response.json(
        { code: 21610, message: "The message From/To pair violates a blacklist rule." },
        { status: 400 },
      ),
    );

    await expect(send()).rejects.toMatchObject({
      name: "TwilioSmsApiError",
      message: "Twilio SMS send failed (400): The message From/To pair violates a blacklist rule.",
      httpStatus: 400,
      twilioCode: 21610,
      responseText: JSON.stringify({
        code: 21610,
        message: "The message From/To pair violates a blacklist rule.",
      }),
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
      return new Response(`upstream unavailable; Authorization: ${authorization}`, { status: 503 });
    });

    let caught: (Error & { responseText: string }) | undefined;
    try {
      await send({ account });
    } catch (error) {
      caught = error as Error & { responseText: string };
    }

    expect(caught).toMatchObject({
      message: "Twilio SMS send failed (503): upstream unavailable; Authorization: Basic ***",
      responseText: "upstream unavailable; Authorization: Basic ***",
    });
    expect(caught?.message).not.toContain(encodedCredential);
    expect(caught?.responseText).not.toContain(encodedCredential);
  });

  it("releases guarded Twilio egress on failed send responses", async () => {
    const release = guardedResponse(new Response("upstream unavailable", { status: 503 }));

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
    const tracked = cancelTrackedTextResponse(`${"x".repeat(8 * 1024 - 2)}😀tail`, { status: 503 });
    const release = guardedResponse(tracked.response);

    let caught: Error | undefined;
    try {
      await send();
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("Twilio SMS send failed (503): ");
    expect(caught?.message).toContain("... [truncated]");
    expect(caught?.message).not.toContain("�");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases guarded Twilio egress on malformed successful send responses", async () => {
    const release = guardedResponse(new Response("not json", { status: 201 }));

    await expect(send()).rejects.toThrow("Twilio SMS send returned malformed JSON.");

    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["service", "numbers"] as const)(
    "handles malformed JSON from %s lookup",
    async (kind) => {
      mockTwilioFetch(
        async () =>
          new Response("NOT JSON {{{", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      if (kind === "service") {
        await expect(
          retrieveTwilioMessagingService({
            account: createAccount({ messagingServiceSid: "MG123", fromNumber: "" }),
            serviceSid: "MG123",
          }),
        ).rejects.toThrow("Twilio Messaging Service lookup returned malformed JSON.");
      } else {
        await expect(
          listTwilioIncomingPhoneNumbers({ account: createAccount(), phoneNumber: FROM }),
        ).resolves.toEqual([]);
      }
    },
  );

  it("bounds and cancels oversized guarded Twilio success bodies", async () => {
    const tracked = cancelTrackedTextResponse("x".repeat(1024 * 1024 + 1), { status: 201 });
    const release = guardedResponse(tracked.response);

    await expect(send()).rejects.toThrow(
      "Twilio SMS API response body too large: 1048577 bytes (limit: 1048576 bytes)",
    );

    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("requires successful Twilio sends to include a Message SID", async () => {
    jsonResponse({ status: "queued" });

    await expect(send()).rejects.toThrow("Twilio SMS send response did not include a Message SID.");
  });

  it.each([
    ["/webhooks/sms?foo=bar", `${SIGNATURE_BASE}#rp=4xx`, `${SIGNATURE_BASE}?foo=bar`],
    [
      "/webhooks/sms?foo=request",
      `${SIGNATURE_BASE}?foo=configured#rp=all`,
      `${SIGNATURE_BASE}?foo=configured`,
    ],
    [
      "/webhooks/sms",
      "https://gateway.example.com:443/webhooks/sms#rp=4xx",
      "https://gateway.example.com:443/webhooks/sms",
    ],
  ])("preserves signature URL bytes for %s against %s", (url, publicWebhookUrl, expected) => {
    expect(resolveTwilioWebhookSignatureUrl({ req: { url } as never, publicWebhookUrl })).toBe(
      expected,
    );
  });
});

function createWebhookResponse(overrides: Record<string, string> = {}) {
  return { incoming_phone_numbers: [createSmsTestPhoneNumber(overrides)] };
}

function createFetch(responses: Array<unknown>): typeof fetch {
  return vi.fn<typeof fetch>(async () => Response.json(responses.shift()));
}

function probe(
  responses: unknown[],
  account: Partial<ResolvedSmsAccount> = {},
  options: NonNullable<Parameters<typeof probeSmsAccount>[0]["options"]> & {
    fetchImpl?: typeof fetch;
  } = {},
) {
  const { fetchImpl = createFetch(responses), ...probeOptions } = options;
  mockTwilioFetch(fetchImpl);
  return probeSmsAccount({
    account: createAccount(account),
    timeoutMs: 1000,
    options: probeOptions,
  });
}

function probeDelivery(
  outbound: Pick<SmsDeliveryRecord, "messageSid" | "status" | "lastObservedAt" | "errorCode">,
  fetchImpl = createFetch([createWebhookResponse(), { messages: [] }]),
) {
  const record: SmsDeliveryRecord = {
    accountId: "default",
    accountSidHash: "account-sid-hash",
    firstObservedAt: 1,
    observations: [],
    ...outbound,
  };
  return probe([], {}, { fetchImpl, deliveryRecords: [record] });
}

function expectUnavailable(result: Awaited<ReturnType<typeof probe>>, error: string) {
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining(error),
    webhook: { status: "unavailable" },
  });
}

function inbound(sid: string, extra: Record<string, unknown> = {}) {
  return { messages: [createSmsTestMessage({ sid, ...extra })] };
}

function probeService(use_inbound_webhook_on_number: boolean) {
  return probe(
    [
      {
        sid: "MG123",
        inbound_request_url: WEBHOOK,
        inbound_method: "POST",
        use_inbound_webhook_on_number,
      },
    ],
    { fromNumber: "", messagingServiceSid: "MG123" },
  );
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("SMS status probe", () => {
  it("reports a healthy Twilio SMS webhook", async () => {
    const result = await probe([
      createWebhookResponse({ voice_url: "https://gateway.example.com/voice/webhook" }),
      inbound("SM123", { date_created: "Sun, 31 May 2026 10:00:00 +0000", date_sent: null }),
    ]);
    expect(result).toMatchObject({
      ok: true,
      webhook: {
        status: "matches",
        phoneNumber: FROM,
        configuredMethod: "POST",
        configuredUrl: WEBHOOK,
        voiceUrl: "https://gateway.example.com/voice/webhook",
      },
      recentInbound: {
        sid: "SM123",
        direction: "inbound",
        status: "received",
        errorCode: "",
        dateCreated: "Sun, 31 May 2026 10:00:00 +0000",
        dateSent: "",
      },
    });
    expect(fetchWithSsrFGuardMock.mock.calls.map(([request]) => request.url)).toEqual([
      "https://api.twilio.com/2010-04-01/Accounts/AC123/IncomingPhoneNumbers.json?PhoneNumber=%2B15557654321",
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json?To=%2B15557654321&PageSize=3",
    ]);
    for (const [request] of fetchWithSsrFGuardMock.mock.calls) {
      expect(request.init.headers).toMatchObject({
        authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
      });
    }
    expect(result.recentInbound).not.toHaveProperty("from");
    expect(result.recentInbound).not.toHaveProperty("to");
  });

  it("detects a Twilio SMS webhook URL mismatch", async () => {
    await expect(
      probe([
        createWebhookResponse({ sms_url: "https://old.example.com/webhooks/sms" }),
        { messages: [] },
      ]),
    ).resolves.toMatchObject({
      ok: false,
      error:
        "Twilio number +15557654321 points SMS webhooks at https://old.example.com/webhooks/sms; expected https://gateway.example.com/webhooks/sms.",
      webhook: { status: "url-mismatch" },
    });
  });

  it("surfaces Twilio 11200 recent inbound failures and Funnel hints", async () => {
    const result = await probe(
      [
        createWebhookResponse({ sms_url: "https://mac-studio.example.ts.net/webhooks/sms" }),
        inbound("SM11200", { error_code: 11200 }),
      ],
      { publicWebhookUrl: "https://mac-studio.example.ts.net/webhooks/sms" },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Recent inbound SMS SM11200 has Twilio error 11200.",
      recentInbound: { sid: "SM11200", errorCode: "11200" },
    });
    expect(result.hints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Tailscale Funnel must expose the exact SMS path"),
        expect.stringContaining("Twilio error 11200 means Twilio could not reach"),
      ]),
    );
  });

  it("validates Twilio Messaging Service webhook settings", async () => {
    await expect(probeService(false)).resolves.toMatchObject({
      ok: true,
      webhook: {
        status: "messaging-service-matches",
        serviceSid: "MG123",
        configuredUrl: WEBHOOK,
        configuredMethod: "POST",
      },
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://messaging.twilio.com/v1/Services/MG123",
        init: expect.objectContaining({
          headers: expect.objectContaining({
            authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
          }),
        }),
      }),
    );
  });

  it("does not report Messaging Service defer-to-number probes as healthy", async () => {
    await expect(probeService(true)).resolves.toMatchObject({
      ok: false,
      error:
        "Twilio Messaging Service defers inbound webhooks to sender phone numbers; configure fromNumber or disable defer-to-sender before checking.",
      webhook: { status: "unavailable" },
    });
  });

  it("formats probe details for channel capability output", () => {
    expect(
      formatSmsProbeLines({
        ok: false,
        error: "Recent inbound SMS SM11200 has Twilio error 11200.",
        webhook: { status: "matches", configuredUrl: WEBHOOK },
        recentInbound: { sid: "SM11200", status: "received", errorCode: "11200" },
        recentOutbound: { messageSid: "SM-outbound", status: "undelivered", errorCode: "30005" },
        hints: ["Check the public route."],
      }),
    ).toEqual([
      {
        text: "Check: failed (Recent inbound SMS SM11200 has Twilio error 11200.)",
        tone: "error",
      },
      { text: "Twilio SMS webhook: https://gateway.example.com/webhooks/sms" },
      { text: "Recent inbound: received error=11200", tone: "warn" },
      { text: "Recent outbound: undelivered error=30005", tone: "error" },
      { text: "Check the public route.", tone: "warn" },
    ]);
  });

  it("formats canceled outbound delivery as an error", () => {
    expect(
      formatSmsProbeLines({
        ok: true,
        recentOutbound: { messageSid: "SM-canceled", status: "canceled" },
        hints: [],
      }),
    ).toContainEqual({ text: "Recent outbound: canceled", tone: "error" });
  });

  it("projects recent durable delivery state without message addresses", async () => {
    const outbound = { messageSid: "SM-delivered", status: "delivered", lastObservedAt: 2 };
    const result = await probeDelivery(outbound);
    expect(result.recentOutbound).toEqual(outbound);
    expect(result.recentOutbound).not.toHaveProperty("accountId");
    expect(result.recentOutbound).not.toHaveProperty("observations");
  });

  it("preserves recent durable delivery state when Twilio probes fail", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("Twilio unavailable");
    });

    const outbound = {
      messageSid: "SM-failed",
      status: "failed",
      errorCode: "30005",
      lastObservedAt: 2,
    };
    const result = await probeDelivery(outbound, fetchImpl);
    expectUnavailable(result, "Twilio unavailable");
    expect(result.recentOutbound).toMatchObject(outbound);
    expect(formatSmsProbeLines(result)).toContainEqual({
      text: "Recent outbound: failed error=30005",
      tone: "error",
    });
  });

  it.each([
    ["webhook", false],
    ["history", false],
    ["webhook", true],
    ["history", true],
  ] as const)(
    "preserves sibling and durable facts when %s fails (timeout: %s)",
    async (lookup, timeout) => {
      const webhookFailed = lookup === "webhook";
      const failure = webhookFailed ? "number lookup unavailable" : "message history unavailable";
      const error = timeout
        ? `Twilio ${webhookFailed ? "webhook" : "message history"} check failed: timed out after 900ms`
        : failure;
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        if (fetchInputUrl(input).includes("IncomingPhoneNumbers.json") === webhookFailed) {
          throw timeout
            ? Object.assign(new Error("request timed out"), { name: "TimeoutError" })
            : new Error(failure);
        }
        return Response.json(webhookFailed ? inbound("SM-inbound") : createWebhookResponse());
      });
      const outbound = webhookFailed
        ? { messageSid: "SM-delivered", status: "delivered", lastObservedAt: 2 }
        : { messageSid: "SM-undelivered", status: "undelivered", lastObservedAt: 2 };
      const result = await probeDelivery(outbound, fetchImpl);
      expect(result).toMatchObject({
        ok: false,
        error: timeout ? error : expect.stringContaining(error),
        webhook: {
          status: webhookFailed ? "unavailable" : "matches",
          ...(timeout && webhookFailed ? { reason: error } : {}),
        },
        recentOutbound: outbound,
        ...(webhookFailed ? { recentInbound: { sid: "SM-inbound", status: "received" } } : {}),
      });
    },
  );
});
