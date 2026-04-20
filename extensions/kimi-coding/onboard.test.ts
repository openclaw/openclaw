import { describe, expect, it } from "vitest";
import { buildKimiCodingProvider } from "./provider-catalog.js";
import {
  applyKimiCodeConfig,
  applyKimiCodeProviderConfig,
  KIMI_CODING_MODEL_REF,
  KIMI_MODEL_REF,
} from "./onboard.js";

describe("kimi-coding onboard", () => {
  it("exports correct model references", () => {
    expect(KIMI_MODEL_REF).toBe("kimi/kimi-code");
    expect(KIMI_CODING_MODEL_REF).toBe("kimi/kimi-code");
  });

  it("applies kimi coding provider config correctly", () => {
    const result = applyKimiCodeProviderConfig({});
    expect(result).toBeDefined();
  });

  it("applies kimi coding config correctly", () => {
    const result = applyKimiCodeConfig({});
    expect(result).toBeDefined();
  });

  it("builds kimi coding provider with correct defaults", () => {
    const provider = buildKimiCodingProvider();
    expect(provider.api).toBe("anthropic-messages");
    expect(provider.baseUrl).toBe("https://api.kimi.com/coding/");
  });

  it("kimi-code model has correct properties", () => {
    const provider = buildKimiCodingProvider();
    const kimiModel = provider.models.find((m) => m.id === "kimi-code");
    expect(kimiModel).toBeDefined();
    expect(kimiModel?.reasoning).toBe(true);
    expect(kimiModel?.input).toEqual(["text", "image"]);
    expect(kimiModel?.contextWindow).toBe(262144);
  });
});