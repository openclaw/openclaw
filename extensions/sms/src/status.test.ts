import { describe, expect, it, vi } from "vitest";
import type { SmsDeliveryRecord } from "./delivery-observations.js";
import { formatSmsProbeLines, probeSmsAccount } from "./status.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsTestAccount } from "./webhook.test-support.js";

function createWebhookResponse(overrides: Record<string, string> = {}) {
  return {
    incoming_phone_numbers: [
      {
        phone_number: "+15557654321",
        sms_url: "https://gateway.example.com/webhooks/sms",
        sms_method: "POST",
        ...overrides,
      },
    ],
  };
}

function createFetch(responses: Array<unknown>): typeof fetch {
  return vi.fn<typeof fetch>(async () => Response.json(responses.shift()));
}

function probe(
  responses: unknown[],
  account: Partial<ResolvedSmsAccount> = {},
  options: Parameters<typeof probeSmsAccount>[0]["options"] = {},
) {
  return probeSmsAccount({
    account: createSmsTestAccount({ accountId: "default", ...account }),
    timeoutMs: 1000,
    options: { fetchImpl: createFetch(responses), ...options },
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
  return {
    messages: [
      {
        sid,
        direction: "inbound",
        status: "received",
        to: "+15557654321",
        from: "+15551234567",
        ...extra,
      },
    ],
  };
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

describe("SMS status probe", () => {
  it("reports a healthy Twilio SMS webhook", async () => {
    const result = await probe([
      createWebhookResponse({ voice_url: "https://gateway.example.com/voice/webhook" }),
      inbound("SM123"),
    ]);
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

  it("formats probe details for channel capability output", () => {
    expect(
      formatSmsProbeLines({
        ok: false,
        error: "Recent inbound SMS SM11200 has Twilio error 11200.",
        webhook: { status: "matches", configuredUrl: "https://gateway.example.com/webhooks/sms" },
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

  it("preserves inbound and outbound facts when the webhook lookup fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (fetchInputUrl(input).includes("IncomingPhoneNumbers.json")) {
        throw new Error("number lookup unavailable");
      }
      return new Response(
        JSON.stringify({
          messages: [
            {
              sid: "SM-inbound",
              direction: "inbound",
              status: "received",
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await probeDelivery(
      { messageSid: "SM-delivered", status: "delivered", lastObservedAt: 2 },
      fetchImpl,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("number lookup unavailable"),
      webhook: { status: "unavailable" },
      recentInbound: { sid: "SM-inbound", status: "received" },
      recentOutbound: { messageSid: "SM-delivered", status: "delivered" },
    });
  });

  it("preserves a successful webhook check and outbound facts when history fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (fetchInputUrl(input).includes("/Messages.json")) {
        throw new Error("message history unavailable");
      }
      return new Response(JSON.stringify(createWebhookResponse()), { status: 200 });
    });

    const result = await probeDelivery(
      { messageSid: "SM-undelivered", status: "undelivered", lastObservedAt: 2 },
      fetchImpl,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("message history unavailable"),
      webhook: { status: "matches" },
      recentOutbound: { messageSid: "SM-undelivered", status: "undelivered" },
    });
  });

  it.each(["webhook", "history"] as const)(
    "preserves sibling and durable delivery facts when the %s request times out",
    async (lookup) => {
      const webhookTimedOut = lookup === "webhook";
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        if (fetchInputUrl(input).includes("IncomingPhoneNumbers.json") === webhookTimedOut) {
          throw Object.assign(new Error("request timed out"), { name: "TimeoutError" });
        }
        return Response.json(webhookTimedOut ? inbound("SM-inbound") : createWebhookResponse());
      });
      const outbound = { messageSid: "SM-timeout", status: "delivered", lastObservedAt: 2 };
      const result = await probeDelivery(outbound, fetchImpl);
      const error = `Twilio ${webhookTimedOut ? "webhook" : "message history"} check failed: timed out after 900ms`;

      expect(result).toMatchObject({
        ok: false,
        error,
        webhook: webhookTimedOut ? { status: "unavailable", reason: error } : { status: "matches" },
        recentOutbound: outbound,
      });
      if (webhookTimedOut) {
        expect(result.recentInbound).toMatchObject({ sid: "SM-inbound", status: "received" });
      }
    },
  );
});
