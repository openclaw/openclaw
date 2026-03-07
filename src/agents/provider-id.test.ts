import { describe, expect, it } from "vitest";
import {
  findNormalizedProviderKey,
  findNormalizedProviderValue,
  normalizeProviderId,
  normalizeProviderIdForAuth,
} from "./provider-id.js";

describe("normalizeProviderId", () => {
  it("trims and lowercases provider IDs", () => {
    expect(normalizeProviderId(" OpenAI ")).toBe("openai");
    expect(normalizeProviderId("ANTHROPIC")).toBe("anthropic");
    expect(normalizeProviderId("  Google  ")).toBe("google");
  });

  it("normalizes z.ai aliases to zai", () => {
    expect(normalizeProviderId("z.ai")).toBe("zai");
    expect(normalizeProviderId("Z.AI")).toBe("zai");
    expect(normalizeProviderId("z-ai")).toBe("zai");
    expect(normalizeProviderId("Z-AI")).toBe("zai");
    expect(normalizeProviderId(" Z.ai ")).toBe("zai");
  });

  it("normalizes qwen to qwen-portal", () => {
    expect(normalizeProviderId("qwen")).toBe("qwen-portal");
    expect(normalizeProviderId("QWEN")).toBe("qwen-portal");
    expect(normalizeProviderId(" Qwen ")).toBe("qwen-portal");
  });

  it("normalizes opencode variants", () => {
    expect(normalizeProviderId("opencode-zen")).toBe("opencode");
    expect(normalizeProviderId("OPENCODE-ZEN")).toBe("opencode");
    expect(normalizeProviderId("opencode-go-auth")).toBe("opencode-go");
    expect(normalizeProviderId("OPENCODE-GO-AUTH")).toBe("opencode-go");
  });

  it("normalizes kimi variants", () => {
    expect(normalizeProviderId("kimi")).toBe("kimi");
    expect(normalizeProviderId("KIMI")).toBe("kimi");
    expect(normalizeProviderId("kimi-code")).toBe("kimi");
    expect(normalizeProviderId("kimi-coding")).toBe("kimi");
    expect(normalizeProviderId("KIMI-CODING")).toBe("kimi");
  });

  it("normalizes bedrock variants", () => {
    expect(normalizeProviderId("bedrock")).toBe("amazon-bedrock");
    expect(normalizeProviderId("aws-bedrock")).toBe("amazon-bedrock");
    expect(normalizeProviderId("BEDROCK")).toBe("amazon-bedrock");
    expect(normalizeProviderId("AWS-BEDROCK")).toBe("amazon-bedrock");
  });

  it("normalizes bytedance/doubao to volcengine", () => {
    expect(normalizeProviderId("bytedance")).toBe("volcengine");
    expect(normalizeProviderId("doubao")).toBe("volcengine");
    expect(normalizeProviderId("BYTEDANCE")).toBe("volcengine");
    expect(normalizeProviderId("DOUBAO")).toBe("volcengine");
  });
});

describe("normalizeProviderIdForAuth", () => {
  it("normalizes plan variants to base provider", () => {
    expect(normalizeProviderIdForAuth("volcengine-plan")).toBe("volcengine");
    expect(normalizeProviderIdForAuth("VOLCENGINE-PLAN")).toBe("volcengine");
    expect(normalizeProviderIdForAuth("byteplus-plan")).toBe("byteplus");
    expect(normalizeProviderIdForAuth("BYTEPLUS-PLAN")).toBe("byteplus");
  });

  it("applies base normalization after auth-specific normalization", () => {
    expect(normalizeProviderIdForAuth("volcengine-plan")).toBe("volcengine");
    expect(normalizeProviderIdForAuth("  volcengine-plan ")).toBe("volcengine");
  });
});

describe("findNormalizedProviderValue", () => {
  const entries = {
    openai: { apiKey: "sk-openai" },
    anthropic: { apiKey: "sk-ant" },
    zai: { apiKey: "zai-key" },
    "qwen-portal": { apiKey: "qwen-key" },
  };

  it("finds value with exact match", () => {
    expect(findNormalizedProviderValue(entries, "openai")).toEqual({ apiKey: "sk-openai" });
    expect(findNormalizedProviderValue(entries, "anthropic")).toEqual({ apiKey: "sk-ant" });
  });

  it("finds value regardless of casing", () => {
    expect(findNormalizedProviderValue(entries, "OPENAI")).toEqual({ apiKey: "sk-openai" });
    expect(findNormalizedProviderValue(entries, "OpenAI")).toEqual({ apiKey: "sk-openai" });
    expect(findNormalizedProviderValue(entries, "Anthropic")).toEqual({ apiKey: "sk-ant" });
  });

  it("finds value with aliases", () => {
    expect(findNormalizedProviderValue(entries, "z.ai")).toEqual({ apiKey: "zai-key" });
    expect(findNormalizedProviderValue(entries, "Z.AI")).toEqual({ apiKey: "zai-key" });
    expect(findNormalizedProviderValue(entries, "z-ai")).toEqual({ apiKey: "zai-key" });
    expect(findNormalizedProviderValue(entries, "qwen")).toEqual({ apiKey: "qwen-key" });
  });

  it("returns undefined for unknown provider", () => {
    expect(findNormalizedProviderValue(entries, "unknown")).toBeUndefined();
    expect(findNormalizedProviderValue(entries, "")).toBeUndefined();
    expect(findNormalizedProviderValue(entries, "   ")).toBeUndefined();
  });

  it("returns undefined for undefined entries", () => {
    expect(findNormalizedProviderValue(undefined, "openai")).toBeUndefined();
  });
});

describe("findNormalizedProviderKey", () => {
  const entries = {
    OpenAI: { models: [] },
    "z.ai": { models: [] },
    Qwen: { models: [] },
  };

  it("finds key with exact match", () => {
    expect(findNormalizedProviderKey(entries, "openai")).toBe("OpenAI");
    expect(findNormalizedProviderKey(entries, "zai")).toBe("z.ai");
    expect(findNormalizedProviderKey(entries, "qwen-portal")).toBe("Qwen");
  });

  it("finds key regardless of casing", () => {
    expect(findNormalizedProviderKey(entries, "OPENAI")).toBe("OpenAI");
    expect(findNormalizedProviderKey(entries, "Z.AI")).toBe("z.ai");
  });

  it("returns undefined for unknown provider", () => {
    expect(findNormalizedProviderKey(entries, "unknown")).toBeUndefined();
  });

  it("returns undefined for undefined entries", () => {
    expect(findNormalizedProviderKey(undefined, "openai")).toBeUndefined();
  });
});
