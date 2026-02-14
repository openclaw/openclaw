import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { VoiceCallProvider } from "./providers/base.js";
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
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";

class FakeProvider implements VoiceCallProvider {
  readonly name = "plivo" as const;
  readonly playTtsCalls: PlayTtsInput[] = [];
  readonly hangupCalls: HangupCallInput[] = [];

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }
  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return { events: [], statusCode: 200 };
  }
  async initiateCall(_input: InitiateCallInput): Promise<InitiateCallResult> {
    return { providerCallId: "request-uuid", status: "initiated" };
  }
  async hangupCall(input: HangupCallInput): Promise<void> {
    this.hangupCalls.push(input);
  }
  async playTts(input: PlayTtsInput): Promise<void> {
    this.playTtsCalls.push(input);
  }
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

    const storePath = path.join(os.tmpdir(), `openclaw-voice-call-test-${Date.now()}`);
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

  it("speaks initial message on answered for notify mode (non-Twilio)", async () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });

    const storePath = path.join(os.tmpdir(), `openclaw-voice-call-test-${Date.now()}`);
    const provider = new FakeProvider();
    const manager = new CallManager(config, storePath);
    manager.initialize(provider, "https://example.com/voice/webhook");

    const { callId, success } = await manager.initiateCall("+15550000002", undefined, {
      message: "Hello there",
      mode: "notify",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-2",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.playTtsCalls).toHaveLength(1);
    expect(provider.playTtsCalls[0]?.text).toBe("Hello there");
  });

  it("rejects inbound calls with missing caller ID when allowlist enabled", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });

    const storePath = path.join(os.tmpdir(), `openclaw-voice-call-test-${Date.now()}`);
    const provider = new FakeProvider();
    const manager = new CallManager(config, storePath);
    manager.initialize(provider, "https://example.com/voice/webhook");

    manager.processEvent({
      id: "evt-allowlist-missing",
      type: "call.initiated",
      callId: "call-missing",
      providerCallId: "provider-missing",
      timestamp: Date.now(),
      direction: "inbound",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-missing")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-missing");
  });

  it("rejects inbound calls with anonymous caller ID when allowlist enabled", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });

    const storePath = path.join(os.tmpdir(), `openclaw-voice-call-test-${Date.now()}`);
    const provider = new FakeProvider();
    const manager = new CallManager(config, storePath);
    manager.initialize(provider, "https://example.com/voice/webhook");

    manager.processEvent({
      id: "evt-allowlist-anon",
      type: "call.initiated",
      callId: "call-anon",
      providerCallId: "provider-anon",
      timestamp: Date.now(),
      direction: "inbound",
      from: "anonymous",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-anon")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-anon");
  });

  it("rejects inbound calls that only match allowlist suffixes", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });

    const storePath = path.join(os.tmpdir(), `openclaw-voice-call-test-${Date.now()}`);
    const provider = new FakeProvider();
    const manager = new CallManager(config, storePath);
    manager.initialize(provider, "https://example.com/voice/webhook");

    manager.processEvent({
      id: "evt-allowlist-suffix",
      type: "call.initiated",
      callId: "call-suffix",
      providerCallId: "provider-suffix",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+99915550001234",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-suffix")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-suffix");
  });

  it("rejects duplicate inbound events with a single hangup call", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      inboundPolicy: "disabled",
    });

    const storePath = path.join(os.tmpdir(), `openclaw-voice-call-test-${Date.now()}`);
    const provider = new FakeProvider();
    const manager = new CallManager(config, storePath);
    manager.initialize(provider, "https://example.com/voice/webhook");

    manager.processEvent({
      id: "evt-reject-init",
      type: "call.initiated",
      callId: "provider-dup",
      providerCallId: "provider-dup",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15552222222",
      to: "+15550000000",
    });

    manager.processEvent({
      id: "evt-reject-ring",
      type: "call.ringing",
      callId: "provider-dup",
      providerCallId: "provider-dup",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15552222222",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-dup")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-dup");
  });

  it("accepts inbound calls that exactly match the allowlist", () => {
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });

    const storePath = path.join(os.tmpdir(), `openclaw-voice-call-test-${Date.now()}`);
    const manager = new CallManager(config, storePath);
    manager.initialize(new FakeProvider(), "https://example.com/voice/webhook");

    manager.processEvent({
      id: "evt-allowlist-exact",
      type: "call.initiated",
      callId: "call-exact",
      providerCallId: "provider-exact",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15550001234",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-exact")).toBeDefined();
  });
});
