import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import type {
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "./types.js";
import type { VoiceCallProvider } from "./providers/base.js";

class FakeProvider implements VoiceCallProvider {
  readonly name = "plivo" as const;

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }
  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return { events: [], statusCode: 200 };
  }
  async initiateCall(_input: InitiateCallInput): Promise<InitiateCallResult> {
    return { providerCallId: "request-uuid", status: "initiated" };
  }
  async hangupCall(_input: HangupCallInput): Promise<void> {}
  async playTts(_input: PlayTtsInput): Promise<void> {}
  async startListening(_input: StartListeningInput): Promise<void> {}
  async stopListening(_input: StopListeningInput): Promise<void> {}
}

describe("CallManager", () => {
  it("upgrades providerCallId mapping when provider ID changes", async () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });

    const storePath = path.join(os.tmpdir(), `clawdbot-voice-call-test-${Date.now()}`);
    const manager = new CallManager(config, storePath);
    manager.initialize(new FakeProvider(), "https://example.com/voice/webhook");

    const { callId, success, error } = await manager.initiateCall("+15550000001");
    expect(success).toBe(true);
    expect(error).toBeUndefined();

    // The provider returned a request UUID as the initial providerCallId.
    expect(manager.getCall(callId)?.providerCallId).toBe("request-uuid");
    expect(manager.getCallByProviderCallId("request-uuid")?.callId).toBe(callId);

    // Provider later reports the actual call UUID.
    manager.processEvent({
      id: "evt-1",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    expect(manager.getCall(callId)?.providerCallId).toBe("call-uuid");
    expect(manager.getCallByProviderCallId("call-uuid")?.callId).toBe(callId);
    expect(manager.getCallByProviderCallId("request-uuid")).toBeUndefined();
  });
});

