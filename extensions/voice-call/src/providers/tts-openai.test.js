import { describe, expect, it } from "vitest";
import { OpenAITTSProvider } from "./tts-openai.js";
function readProviderInternals(config) {
  return new OpenAITTSProvider(config);
}
describe("OpenAITTSProvider constructor defaults", () => {
  it("uses speed: 0 when explicitly configured", () => {
    const provider = readProviderInternals({
      apiKey: "sk-test",
      // pragma: allowlist secret
      speed: 0
    });
    expect(provider.speed).toBe(0);
  });
  it("falls back to speed default when undefined", () => {
    const provider = readProviderInternals({
      apiKey: "sk-test"
      // pragma: allowlist secret
    });
    expect(provider.speed).toBe(1);
  });
  it("treats blank model and voice overrides as unset", () => {
    const provider = readProviderInternals({
      apiKey: "sk-test",
      // pragma: allowlist secret
      model: "   ",
      voice: ""
    });
    expect(provider.model).toBe("gpt-4o-mini-tts");
    expect(provider.voice).toBe("coral");
  });
});
