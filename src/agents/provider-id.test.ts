import { describe, expect, it } from "vitest";
import {
  normalizeProviderId,
  normalizeProviderIdForAuth,
  findNormalizedProviderValue,
  findNormalizedProviderKey,
} from "./provider-id.js";

describe("normalizeProviderId", () => {
  it("normalizes whitespace and lowercase", () => {
    expect(normalizeProviderId("  Anthropic  ")).toBe("anthropic");
    expect(normalizeProviderId("OPENAI")).toBe("openai");
  });

  it("normalizes z.ai variants", () => {
    expect(normalizeProviderId("z.ai")).toBe("zai");
    expect(normalizeProviderId("z-ai")).toBe("zai");
    expect(normalizeProviderId("Z.AI")).toBe("zai");
  });

  it("normalizes opencode variants", () => {
    expect(normalizeProviderId("opencode-zen")).toBe("opencode");
    expect(normalizeProviderId("opencode-go-auth")).toBe("opencode-go");
  });

  it("normalizes kimi variants", () => {
    expect(normalizeProviderId("kimi")).toBe("kimi");
    expect(normalizeProviderId("kimi-code")).toBe("kimi");
    expect(normalizeProviderId("kimi-coding")).toBe("kimi");
    expect(normalizeProviderId("KIMI")).toBe("kimi");
  });

  it("normalizes bedrock to amazon-bedrock", () => {
    expect(normalizeProviderId("bedrock")).toBe("amazon-bedrock");
    expect(normalizeProviderId("aws-bedrock")).toBe("amazon-bedrock");
  });

  it("normalizes bytedance/doubao to volcengine", () => {
    expect(normalizeProviderId("bytedance")).toBe("volcengine");
    expect(normalizeProviderId("doubao")).toBe("volcengine");
  });

  it("passes through standard provider names", () => {
    expect(normalizeProviderId("openai")).toBe("openai");
    expect(normalizeProviderId("google")).toBe("google");
    expect(normalizeProviderId("anthropic")).toBe("anthropic");
  });
});

describe("normalizeProviderIdForAuth", () => {
  it("normalizes plan variants for auth lookup", () => {
    expect(normalizeProviderIdForAuth("volcengine-plan")).toBe("volcengine");
    expect(normalizeProviderIdForAuth("byteplus-plan")).toBe("byteplus");
  });

  it("passes through non-plan providers", () => {
    expect(normalizeProviderIdForAuth("openai")).toBe("openai");
    expect(normalizeProviderIdForAuth("volcengine")).toBe("volcengine");
  });

  it("normalizes provider name first", () => {
    expect(normalizeProviderIdForAuth("volcengine-plan")).toBe("volcengine");
  });
});

describe("findNormalizedProviderValue", () => {
  const entries = {
    "openai": { apiKey: "sk-test" },
    "Anthropic": { apiKey: "anthropic-key" },
    "google/gemini-2.0-flash": { apiKey: "google-key" },
  };

  it("finds exact match", () => {
    expect(findNormalizedProviderValue(entries, "openai")).toEqual({ apiKey: "sk-test" });
  });

  it("finds case-insensitive match", () => {
    expect(findNormalizedProviderValue(entries, "OPENAI")).toEqual({ apiKey: "sk-test" });
    expect(findNormalizedProviderValue(entries, "anthropic")).toEqual({ apiKey: "anthropic-key" });
  });

  it("finds model variant match", () => {
    const result = findNormalizedProviderValue(entries, "google/gemini-2.0-flash");
    expect(result).toEqual({ apiKey: "google-key" });
  });

  it("returns undefined for non-existent provider", () => {
    expect(findNormalizedProviderValue(entries, "nonexistent")).toBeUndefined();
  });

  it("returns undefined for undefined entries", () => {
    expect(findNormalizedProviderValue(undefined, "openai")).toBeUndefined();
  });
});

describe("findNormalizedProviderKey", () => {
  const entries = {
    "openai": {},
    "Anthropic": {},
    "google": {},
  };

  it("finds exact match", () => {
    expect(findNormalizedProviderKey(entries, "openai")).toBe("openai");
  });

  it("finds case-insensitive match", () => {
    expect(findNormalizedProviderKey(entries, "OPENAI")).toBe("openai");
    expect(findNormalizedProviderKey(entries, "anthropic")).toBe("Anthropic");
  });

  it("returns undefined for non-existent provider", () => {
    expect(findNormalizedProviderKey(entries, "nonexistent")).toBeUndefined();
  });

  it("returns undefined for undefined entries", () => {
    expect(findNormalizedProviderKey(undefined, "openai")).toBeUndefined();
  });
});
