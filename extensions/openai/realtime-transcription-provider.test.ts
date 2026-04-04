import { afterEach, describe, expect, it } from "vitest";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

describe("buildOpenAIRealtimeTranscriptionProvider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("normalizes OpenAI config defaults", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            apiKey: "sk-test", // pragma: allowlist secret
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
    });
  });

  it("reads provider-owned env fallbacks", () => {
    process.env.REALTIME_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
    process.env.SILENCE_DURATION_MS = "900";
    process.env.VAD_THRESHOLD = "0.45";

    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {},
    });

    expect(resolved).toEqual({
      model: "gpt-4o-transcribe",
      silenceDurationMs: 900,
      vadThreshold: 0.45,
    });
  });

  it("accepts the legacy openai-realtime alias", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    expect(provider.aliases).toContain("openai-realtime");
  });
});
