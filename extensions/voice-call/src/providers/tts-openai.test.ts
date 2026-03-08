import { describe, expect, it } from "vitest";
import type { OpenAITTSConfig } from "./tts-openai.js";
import { OpenAITTSProvider } from "./tts-openai.js";

type ProviderInternals = OpenAITTSProvider & {
  speed: number;
};

function createProvider(config: OpenAITTSConfig): ProviderInternals {
  return new OpenAITTSProvider(config) as ProviderInternals;
}

describe("OpenAITTSProvider constructor defaults", () => {
  it("uses speed: 0 when explicitly configured", () => {
    const provider = createProvider({
      apiKey: "sk-test",
      speed: 0,
    });

    expect(provider.speed).toBe(0);
  });

  it("falls back to speed default when undefined", () => {
    const provider = createProvider({
      apiKey: "sk-test",
    });

    expect(provider.speed).toBe(1.0);
  });
});
