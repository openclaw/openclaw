import { describe, expect, it } from "vitest";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

describe("buildOpenAIRealtimeTranscriptionProvider", () => {
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

  it("accepts the legacy openai-realtime alias", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    expect(provider.aliases).toContain("openai-realtime");
  });
});
