import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  buildGradiumRealtimeTranscriptionProvider,
} from "./realtime-transcription-provider.js";

describe("buildGradiumRealtimeTranscriptionProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes nested provider config", () => {
    const provider = buildGradiumRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          gradium: {
            apiKey: "gsk_test",
            model_name: "default",
            input_format: "pcm",
            language: "en",
          },
        },
      },
    });

    expect(resolved).toMatchObject({
      apiKey: "gsk_test",
      modelName: "default",
      inputFormat: "pcm",
      language: "en",
    });
  });

  it("rejects unknown input formats", () => {
    const provider = buildGradiumRealtimeTranscriptionProvider();
    expect(() =>
      provider.resolveConfig?.({
        cfg: {} as OpenClawConfig,
        rawConfig: { providers: { gradium: { input_format: "mp3" } } },
      }),
    ).toThrow("Invalid Gradium realtime transcription input format: mp3");
  });

  it("builds a Gradium ASR websocket URL", () => {
    const url = __testing.toGradiumRealtimeWsUrl({
      apiKey: "gsk_test",
      baseUrl: "https://api.gradium.ai",
      providerConfig: {},
      modelName: "default",
      inputFormat: "ulaw_8000",
    });

    expect(url).toBe("wss://api.gradium.ai/api/speech/asr");
  });

  it("includes language in the setup payload when configured", () => {
    const setup = __testing.buildSetupPayload({
      apiKey: "gsk_test",
      baseUrl: "https://api.gradium.ai",
      providerConfig: {},
      modelName: "default",
      inputFormat: "pcm",
      language: "en",
    });

    expect(setup).toEqual({
      type: "setup",
      model_name: "default",
      input_format: "pcm",
      json_config: { language: "en" },
    });
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("GRADIUM_API_KEY", "");
    const provider = buildGradiumRealtimeTranscriptionProvider();
    expect(() => provider.createSession({ providerConfig: {} })).toThrow("Gradium API key missing");
  });
});
