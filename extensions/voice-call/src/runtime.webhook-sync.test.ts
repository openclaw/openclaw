import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { TwilioProvider } from "./providers/twilio.js";
import { createVoiceCallRuntime } from "./runtime.js";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to get ephemeral port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

describe("createVoiceCallRuntime Twilio webhook auto-sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and continues when required=false and sync fails", async () => {
    const port = await getFreePort();

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "twilio",
      fromNumber: "+15550001234",
      inboundPolicy: "disabled",
      twilio: {
        accountSid: "AC123",
        authToken: "secret",
        incomingPhoneNumberSid: "PN123",
      },
      serve: { port, bind: "127.0.0.1", path: "/voice/webhook" },
      publicUrl: "https://example.ngrok.app/voice/webhook",
    });

    vi.spyOn(TwilioProvider.prototype, "syncIncomingNumberVoiceWebhook").mockResolvedValue({
      ok: false,
      reason: "boom",
    });

    const rt = await createVoiceCallRuntime({
      config,
      coreConfig: {} as any,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });

    expect(rt.webhookSync).toBeTruthy();
    expect(rt.webhookSync?.attempted).toBe(true);
    expect(rt.webhookSync?.ok).toBe(false);
    expect(rt.webhookSync?.error).toContain("boom");

    await rt.stop();
  });

  it("throws when required=true and sync fails", async () => {
    const port = await getFreePort();

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "twilio",
      fromNumber: "+15550001234",
      inboundPolicy: "disabled",
      twilio: {
        accountSid: "AC123",
        authToken: "secret",
        incomingPhoneNumberSid: "PN123",
        webhookSync: { required: true },
      },
      serve: { port, bind: "127.0.0.1", path: "/voice/webhook" },
      publicUrl: "https://example.ngrok.app/voice/webhook",
    });

    vi.spyOn(TwilioProvider.prototype, "syncIncomingNumberVoiceWebhook").mockResolvedValue({
      ok: false,
      reason: "boom",
    });

    await expect(
      createVoiceCallRuntime({
        config,
        coreConfig: {} as any,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      }),
    ).rejects.toThrow(/Twilio webhook auto-sync failed/i);
  });
});
