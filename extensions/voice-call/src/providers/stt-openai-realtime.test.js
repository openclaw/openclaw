import { describe, expect, it } from "vitest";
import { OpenAIRealtimeSTTProvider } from "./stt-openai-realtime.js";
function readProviderInternals(config) {
  const provider = new OpenAIRealtimeSTTProvider(config);
  return {
    vadThreshold: provider["vadThreshold"],
    silenceDurationMs: provider["silenceDurationMs"]
  };
}
describe("OpenAIRealtimeSTTProvider constructor defaults", () => {
  it("uses vadThreshold: 0 when explicitly configured (max sensitivity)", () => {
    const provider = readProviderInternals({
      apiKey: "sk-test",
      // pragma: allowlist secret
      vadThreshold: 0
    });
    expect(provider.vadThreshold).toBe(0);
  });
  it("uses silenceDurationMs: 0 when explicitly configured", () => {
    const provider = readProviderInternals({
      apiKey: "sk-test",
      // pragma: allowlist secret
      silenceDurationMs: 0
    });
    expect(provider.silenceDurationMs).toBe(0);
  });
  it("falls back to defaults when values are undefined", () => {
    const provider = readProviderInternals({
      apiKey: "sk-test"
      // pragma: allowlist secret
    });
    expect(provider.vadThreshold).toBe(0.5);
    expect(provider.silenceDurationMs).toBe(800);
  });
});
