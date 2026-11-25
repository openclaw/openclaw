import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmsDeliveryRecord } from "./delivery-observations.js";
import { formatSmsProbeLines, probeSmsAccount } from "./status.js";
import type { ResolvedSmsAccount } from "./types.js";
import {
  createSmsTestAccount,
  createSmsTestMessage,
  createSmsTestPhoneNumber,
} from "./webhook.test-support.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

function mockTwilioFetch(fetchImpl: typeof fetch) {
  fetchWithSsrFGuardMock.mockImplementation(async ({ url, init, beforeRequest }) => {
    beforeRequest?.();
    return { response: await fetchImpl(url, init), release: async () => {} };
  });
}

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
    account: createSmsTestAccount({ accountId: "default", ...account }),
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

function inbound(sid: string, extra: Record<string, unknown> = {}) {
  return { messages: [createSmsTestMessage({ sid, ...extra })] };
}

function probeService(use_inbound_webhook_on_number: boolean) {
  return probe(
    [
      {
        sid: "MG123",
        inbound_request_url: "https://gateway.example.com/webhooks/sms",
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

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

describe("SMS status probe", () => {
  it("reports a healthy Twilio SMS webhook", async () => {
    const outbound = { messageSid: "SM-delivered", status: "delivered", lastObservedAt: 2 };
    const result = await probeDelivery(
      outbound,
      createFetch([
        createWebhookResponse({ voice_url: "https://gateway.example.com/voice/webhook" }),
        inbound("SM123"),
      ]),
    );
    expect(result).toMatchObject({
      ok: true,
      webhook: {
        status: "matches",
        configuredUrl: "https://gateway.example.com/webhooks/sms",
        voiceUrl: "https://gateway.example.com/voice/webhook",
      },
      recentInbound: { sid: "SM123", status: "received" },
    });
    expect(result.recentInbound).not.toHaveProperty("from");
    expect(result.recentInbound).not.toHaveProperty("to");
    expect(result.recentOutbound).toEqual(outbound);
    expect(result.recentOutbound).not.toHaveProperty("accountId");
    expect(result.recentOutbound).not.toHaveProperty("observations");
    expect(formatSmsProbeLines(result)).toEqual(
      expect.arrayContaining([
        { text: "Check: ok", tone: "success" },
        { text: "Recent outbound: delivered", tone: "success" },
      ]),
    );
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
    expect(formatSmsProbeLines(result)).toEqual(
      expect.arrayContaining([
        {
          text: "Check: failed (Recent inbound SMS SM11200 has Twilio error 11200.)",
          tone: "error",
        },
        { text: "Twilio SMS webhook: https://mac-studio.example.ts.net/webhooks/sms" },
        { text: "Recent inbound: received error=11200", tone: "warn" },
        ...result.hints.map((text) => ({ text, tone: "warn" })),
      ]),
    );
  });

  it("validates Twilio Messaging Service webhook settings", async () => {
    await expect(probeService(false)).resolves.toMatchObject({
      ok: true,
      webhook: {
        status: "messaging-service-matches",
        serviceSid: "MG123",
        configuredUrl: "https://gateway.example.com/webhooks/sms",
      },
    });
  });

  it("does not report Messaging Service defer-to-number probes as healthy", async () => {
    await expect(probeService(true)).resolves.toMatchObject({
      ok: false,
      error:
        "Twilio Messaging Service defers inbound webhooks to sender phone numbers; configure fromNumber or disable defer-to-sender before checking.",
      webhook: { status: "unavailable" },
    });
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
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Twilio unavailable"),
      webhook: { status: "unavailable" },
    });
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
    "preserves sibling and durable facts when %s fails (timeout=%s)",
    async (lookup, timeout) => {
      const webhookFailed = lookup === "webhook";
      const label = webhookFailed ? "webhook" : "message history";
      const failure = timeout
        ? Object.assign(new Error("request timed out"), { name: "TimeoutError" })
        : new Error(`${label} unavailable`);
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        if (fetchInputUrl(input).includes("IncomingPhoneNumbers.json") === webhookFailed) {
          throw failure;
        }
        return Response.json(webhookFailed ? inbound("SM-inbound") : createWebhookResponse());
      });
      const outbound = { messageSid: "SM-timeout", status: "delivered", lastObservedAt: 2 };
      const result = await probeDelivery(outbound, fetchImpl);
      const error = `Twilio ${label} check failed: ${timeout ? "timed out after 900ms" : failure.message}`;
      expect(result).toMatchObject({
        ok: false,
        error,
        webhook: webhookFailed ? { status: "unavailable", reason: error } : { status: "matches" },
        recentOutbound: outbound,
      });
      if (webhookFailed) {
        expect(result.recentInbound).toMatchObject({ sid: "SM-inbound", status: "received" });
      }
    },
  );
});
