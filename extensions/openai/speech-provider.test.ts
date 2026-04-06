import { describe, expect, it } from "vitest";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

describe("buildOpenAISpeechProvider", () => {
  it("normalizes provider-owned speech config from raw provider config", () => {
    const provider = buildOpenAISpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          openai: {
            apiKey: "sk-test",
            baseUrl: "https://example.com/v1/",
            model: "tts-1",
            voice: "alloy",
            speed: 1.25,
            instructions: " Speak warmly ",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "tts-1",
      voice: "alloy",
      speed: 1.25,
      instructions: "Speak warmly",
    });
  });

  it("parses OpenAI directive tokens against the resolved base url", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.parseDirectiveToken?.({
        key: "voice",
        value: "alloy",
        policy: {
          allowVoice: true,
          allowModelId: true,
        },
        providerConfig: {
          baseUrl: "https://api.openai.com/v1/",
        },
      } as never),
    ).toEqual({
      handled: true,
      overrides: { voice: "alloy" },
    });

    expect(
      provider.parseDirectiveToken?.({
        key: "model",
        value: "kokoro-custom-model",
        policy: {
          allowVoice: true,
          allowModelId: true,
        },
        providerConfig: {
          baseUrl: "https://api.openai.com/v1/",
        },
      } as never),
    ).toEqual({
      handled: false,
    });
  });
});
