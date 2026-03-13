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
  async function initializeManager(params?: {
    callOverrides?: Parameters<typeof makePersistedCall>[0];
    providerResult?: FakeProvider["getCallStatusResult"];
    configureProvider?: (provider: FakeProvider) => void;
    configOverrides?: Partial<{ maxDurationSeconds: number }>;
  }) {
    const storePath = createTestStorePath();
    const call = makePersistedCall(params?.callOverrides);
    writeCallsToStore(storePath, [call]);

    const provider = new FakeProvider();
    if (params?.providerResult) {
      provider.getCallStatusResult = params.providerResult;
    }
    params?.configureProvider?.(provider);

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      ...params?.configOverrides,
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");

    return { call, manager };
  }

  it("skips stale calls reported terminal by provider", async () => {
    const { manager } = await initializeManager({
      providerResult: { status: "completed", isTerminal: true },
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("keeps calls reported active by provider", async () => {
    const { call, manager } = await initializeManager({
      providerResult: { status: "in-progress", isTerminal: false },
    });

    expect(manager.getActiveCalls()).toHaveLength(1);
    expect(manager.getActiveCalls()[0]?.callId).toBe(call.callId);
  });

  it("keeps calls when provider returns unknown (transient error)", async () => {
    const { manager } = await initializeManager({
      providerResult: { status: "error", isTerminal: false, isUnknown: true },
    });

    expect(manager.getActiveCalls()).toHaveLength(1);
  });

  it("skips calls older than maxDurationSeconds", async () => {
    const { manager } = await initializeManager({
      callOverrides: {
        startedAt: Date.now() - 600_000,
        answeredAt: Date.now() - 590_000,
      },
      configOverrides: { maxDurationSeconds: 300 },
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("skips calls without providerCallId", async () => {
    const { manager } = await initializeManager({
      callOverrides: { providerCallId: undefined, state: "initiated" },
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("keeps call when getCallStatus throws (verification failure)", async () => {
    const { manager } = await initializeManager({
      configureProvider: (provider) => {
        provider.getCallStatus = async () => {
          throw new Error("network failure");
        };
      },
    });

    expect(manager.getActiveCalls()).toHaveLength(1);
  });
});
