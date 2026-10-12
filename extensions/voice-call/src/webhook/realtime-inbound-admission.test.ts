import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import type { NormalizedEvent, WebhookContext } from "../types.js";
import { acceptRealtimeInboundRequest } from "./realtime-inbound-admission.js";

describe("acceptRealtimeInboundRequest", () => {
  it("admits an outsider only after callback event processing registers its provider call", async () => {
    const form = new URLSearchParams(
      "CallSid=CA-callback&Direction=inbound&CallStatus=ringing&From=%2B15550003333",
    );
    const request = {
      headers: {},
      rawBody: form.toString(),
      url: "https://voice.example.test/webhook",
      method: "POST",
    } satisfies WebhookContext;
    const event = {
      id: "evt-CA-callback",
      type: "call.initiated",
      callId: "CA-callback",
      providerCallId: "CA-callback",
      direction: "inbound",
      from: "+15550003333",
      to: "+15550009999",
      timestamp: Date.now(),
    } satisfies NormalizedEvent;
    const provider = {
      parseWebhookEvent: () => ({ events: [event] }),
    };
    const registered = new Set<string>();
    const manager = {
      getCallByProviderCallId: (providerCallId: string) =>
        registered.has(providerCallId) ? { callId: providerCallId } : undefined,
    };
    const processEvents = vi.fn(async (events: NormalizedEvent[]) => {
      registered.add(events[0]?.providerCallId ?? "");
    });

    await expect(
      acceptRealtimeInboundRequest({
        request,
        form,
        verifiedRequestKey: "twilio:req:test",
        config: VoiceCallConfigSchema.parse({
          provider: "twilio",
          inboundPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          realtime: { enabled: true },
          callbacks: { enabled: true, windowMinutes: 60 },
        }),
        manager,
        provider,
        processEvents,
      }),
    ).resolves.toBe(true);
    expect(processEvents).toHaveBeenCalledWith([event]);
  });
});
