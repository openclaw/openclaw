import { afterEach, describe, expect, it } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

describe("buildOpenAIRealtimeVoiceProvider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("normalizes provider-owned env fallbacks", () => {
    process.env.REALTIME_VOICE_MODEL = "gpt-realtime";
    process.env.REALTIME_VOICE_VOICE = "verse";
    process.env.REALTIME_VOICE_TEMPERATURE = "0.6";
    process.env.SILENCE_DURATION_MS = "850";
    process.env.VAD_THRESHOLD = "0.35";

    const provider = buildOpenAIRealtimeVoiceProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {},
    });

    expect(resolved).toEqual({
      model: "gpt-realtime",
      voice: "verse",
      temperature: 0.6,
      silenceDurationMs: 850,
      vadThreshold: 0.35,
    });
  });
});
