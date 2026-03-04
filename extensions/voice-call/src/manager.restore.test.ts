import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createTestStorePath,
  FakeProvider,
  makePersistedCall,
  writeCallsToStore,
} from "./manager.test-harness.js";

describe("CallManager verification on restore", () => {
  it("skips stale calls reported terminal by provider", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall();
    writeCallsToStore(storePath, [call]);

    const provider = new FakeProvider();
    provider.getCallStatusResult = { status: "completed", isTerminal: true };

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("keeps calls reported active by provider", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall();
    writeCallsToStore(storePath, [call]);

    const provider = new FakeProvider();
    provider.getCallStatusResult = { status: "in-progress", isTerminal: false };

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");

    expect(manager.getActiveCalls()).toHaveLength(1);
    expect(manager.getActiveCalls()[0]?.callId).toBe(call.callId);
  });

  it("keeps calls when provider returns unknown (transient error)", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall();
    writeCallsToStore(storePath, [call]);

    const provider = new FakeProvider();
    provider.getCallStatusResult = { status: "error", isTerminal: false, isUnknown: true };

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");

    expect(manager.getActiveCalls()).toHaveLength(1);
  });

  it("skips calls older than maxDurationSeconds", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall({
      startedAt: Date.now() - 600_000,
      answeredAt: Date.now() - 590_000,
    });
    writeCallsToStore(storePath, [call]);

    const provider = new FakeProvider();

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      maxDurationSeconds: 300,
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("skips calls without providerCallId", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall({ providerCallId: undefined, state: "initiated" });
    writeCallsToStore(storePath, [call]);

    const provider = new FakeProvider();

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("keeps call when getCallStatus throws (verification failure)", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall();
    writeCallsToStore(storePath, [call]);

    const provider = new FakeProvider();
    provider.getCallStatus = async () => {
      throw new Error("network failure");
    };

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");

    expect(manager.getActiveCalls()).toHaveLength(1);
  });
});
