// Openai tests cover GPT-Live (quicksilver) realtime voice gating.
import { describe, expect, it, vi } from "vitest";
import { isOpenAIGptLiveModel, isSupportedOpenAIGptLiveModel } from "./realtime-quicksilver.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

describe("openai gpt-live model detection", () => {
  it("matches the gpt-live model family", () => {
    expect(isOpenAIGptLiveModel("gpt-live-1")).toBe(true);
    expect(isOpenAIGptLiveModel("gpt-live-1-mini")).toBe(true);
    expect(isOpenAIGptLiveModel(" GPT-Live-1 ")).toBe(true);
    expect(isOpenAIGptLiveModel("gpt-live")).toBe(true);
  });

  it("rejects non-live models and prefix lookalikes", () => {
    expect(isOpenAIGptLiveModel(undefined)).toBe(false);
    expect(isOpenAIGptLiveModel("gpt-realtime-2.1")).toBe(false);
    expect(isOpenAIGptLiveModel("gpt-liveish")).toBe(false);
  });

  it("distinguishes released routes from unlisted family members", () => {
    expect(isSupportedOpenAIGptLiveModel("gpt-live-1")).toBe(true);
    expect(isSupportedOpenAIGptLiveModel(" GPT-Live-1 ")).toBe(true);
    expect(isSupportedOpenAIGptLiveModel("gpt-live-1-codex")).toBe(true);
    expect(isSupportedOpenAIGptLiveModel(" GPT-Live-1-Codex ")).toBe(true);
    expect(isSupportedOpenAIGptLiveModel("gpt-live-test-canary")).toBe(false);
  });
});

describe("openai realtime voice provider gpt-live transport routing", () => {
  it("routes gpt-live by the host-owned delegation seam", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const callbacks = {
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    };
    expect(
      provider.createBridge({
        ...callbacks,
        providerConfig: { apiKey: "test-key", model: "gpt-live-test-canary" },
      }),
    ).toMatchObject({
      supportsToolResultContinuation: true,
      handlesInputAudioBargeIn: true,
      outputAudioMode: "continuous",
    });
    expect(
      provider.createBridge({
        ...callbacks,
        providerConfig: { apiKey: "test-key", model: "gpt-live-1" },
        runAgentConsult: vi.fn(async () => ({ text: "done" })),
      }),
    ).toMatchObject({
      supportsToolResultContinuation: false,
      handlesInputAudioBargeIn: true,
      outputAudioMode: "continuous",
    });
    expect(() =>
      provider.createBridge({
        ...callbacks,
        providerConfig: { apiKey: "test-key", model: "gpt-realtime-2.1" },
      }),
    ).not.toThrow();
  });

  it("rejects Azure credentials before creating a Platform GPT-Live bridge", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    expect(() =>
      provider.createBridge({
        providerConfig: {
          apiKey: "azure-test-key",
          model: "gpt-live-test-canary",
          azureEndpoint: "https://example.openai.azure.com",
          azureDeployment: "realtime",
        },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      }),
    ).toThrow("GPT-Live backend WebSocket sessions do not support Azure");
  });
});
