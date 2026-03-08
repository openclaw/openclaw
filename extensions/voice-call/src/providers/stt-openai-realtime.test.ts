import { describe, expect, it } from "vitest";
import type { RealtimeSTTConfig } from "./stt-openai-realtime.js";
import { OpenAIRealtimeSTTProvider } from "./stt-openai-realtime.js";

type ProviderInternals = OpenAIRealtimeSTTProvider & {
  vadThreshold: number;
  silenceDurationMs: number;
};

function createProvider(config: RealtimeSTTConfig): ProviderInternals {
  return new OpenAIRealtimeSTTProvider(config) as ProviderInternals;
}

describe("OpenAIRealtimeSTTProvider constructor defaults", () => {
  it("uses vadThreshold: 0 when explicitly configured (max sensitivity)", () => {
    const provider = createProvider({
      apiKey: "sk-test",
      vadThreshold: 0,
    });
    expect(provider.vadThreshold).toBe(0);
  });

  it("uses silenceDurationMs: 0 when explicitly configured", () => {
    const provider = createProvider({
      apiKey: "sk-test",
      silenceDurationMs: 0,
    });
    expect(provider.silenceDurationMs).toBe(0);
  });

  it("falls back to defaults when values are undefined", () => {
    const provider = createProvider({
      apiKey: "sk-test",
    });
    expect(provider.vadThreshold).toBe(0.5);
    expect(provider.silenceDurationMs).toBe(800);
  });
});
