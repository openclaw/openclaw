import { describe, expect, it } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

describe("buildOpenAIRealtimeVoiceProvider", () => {
  it("normalizes provider-owned voice settings from raw provider config", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            model: "gpt-realtime",
            voice: "verse",
            temperature: 0.6,
            silenceDurationMs: 850,
            vadThreshold: 0.35,
          },
        },
      },
    });

    expect(resolved).toEqual({
      model: "gpt-realtime",
      voice: "verse",
      temperature: 0.6,
      silenceDurationMs: 850,
      vadThreshold: 0.35,
    });
  });

  it("exposes sendSystemContext on bridges for persistent call-intent injection", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        providers: { openai: { apiKey: "test-key" } },
      },
      onAudio: () => {},
      onClearAudio: () => {},
    });

    // Bridge must expose sendSystemContext so the voice-call realtime handler
    // can inject a persistent system turn for outbound call intent. Calling
    // it before connect() must be a no-op rather than throwing, because the
    // handler always registers callbacks before the WebSocket opens.
    expect(typeof bridge.sendSystemContext).toBe("function");
    expect(() => bridge.sendSystemContext?.("test context", { speakFirst: true })).not.toThrow();

    bridge.close();
  });
});
