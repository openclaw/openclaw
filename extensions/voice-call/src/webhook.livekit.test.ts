import crypto from "node:crypto";
import { AccessToken, WebhookEvent } from "livekit-server-sdk";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { normalizeVoiceCallConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import { LiveKitProvider } from "./providers/livekit.js";
import { VoiceCallWebhookServer } from "./webhook.js";

async function postWebhook(url: string, body: string, headers: Record<string, string>) {
  return await fetch(url, { method: "POST", body, headers });
}

describe("LiveKit signed async webhook pipeline", () => {
  it("awaits signature and parse, retries failed persistence, and keeps replays idempotent", async () => {
    const config = normalizeVoiceCallConfig({
      serve: { port: 1, bind: "127.0.0.1", path: "/voice/webhook" },
      staleCallReaperSeconds: 0,
      provider: "livekit",
      livekit: {
        url: "wss://livekit.example.test",
        apiKey: "synthetic-key",
        apiSecret: "synthetic-offline-secret",
        outboundTrunkId: "ST_out",
        inboundTrunkIds: ["ST_in"],
      },
    });
    const carrier = new LiveKitProvider(config.livekit!);
    // Reserve port zero after validation, as in the shared HTTP fixture.
    config.serve.port = 0;
    const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
    // SAFETY: This terminal-event HTTP scenario uses only these manager methods;
    // the real server and carrier still own signature, retry and replay behavior.
    const manager = { getActiveCalls: () => [], processEvent } as unknown as CallManager;
    const server = new VoiceCallWebhookServer(
      createTestPluginServiceScheduler(),
      config,
      manager,
      carrier,
    );
    onTestFinished(async () => {
      await server.stop();
      await carrier.stop();
    });
    const url = await server.start();
    const body = new WebhookEvent({ id: "signed-event", event: "room_finished" }).toJsonString();
    const jwt = new AccessToken("synthetic-key", "synthetic-offline-secret", { ttl: 60 });
    jwt.sha256 = crypto.createHash("sha256").update(body).digest("base64");
    const headers = { authorization: await jwt.toJwt(), "content-type": "application/json" };
    const parse = vi.spyOn(carrier, "parseWebhookEvent").mockImplementation(async () => ({
      events: [
        {
          id: "signed-event",
          callId: "synthetic-call",
          providerCallId: "synthetic-room",
          type: "call.ended",
          reason: "completed",
          timestamp: 1,
        },
      ],
    }));
    expect((await postWebhook(url, body + " ", headers)).status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
    processEvent.mockRejectedValueOnce(new Error("Synthetic persistence failure"));
    expect((await postWebhook(url, body, headers)).status).toBe(500);
    expect((await postWebhook(url, body, headers)).status).toBe(200);
    expect((await postWebhook(url, body, headers)).status).toBe(200);
    expect(processEvent).toHaveBeenCalledTimes(2);
    expect(parse).toHaveBeenCalledTimes(2);
    await carrier.stop();
  });
});
