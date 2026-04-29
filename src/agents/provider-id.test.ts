import { describe, expect, it } from "vitest";
import { findNormalizedProviderValue, normalizeProviderId } from "./provider-id.js";

describe("normalizeProviderId", () => {
  it("returns lowercased input for unknown providers", () => {
    expect(normalizeProviderId("openai")).toBe("openai");
    expect(normalizeProviderId("OpenAI")).toBe("openai");
    expect(normalizeProviderId("ANTHROPIC")).toBe("anthropic");
  });

  it("aliases qwen variants to qwen", () => {
    expect(normalizeProviderId("modelstudio")).toBe("qwen");
    expect(normalizeProviderId("qwencloud")).toBe("qwen");
  });

  it("aliases zai variants to zai", () => {
    expect(normalizeProviderId("z.ai")).toBe("zai");
    expect(normalizeProviderId("z-ai")).toBe("zai");
    expect(normalizeProviderId("Z.AI")).toBe("zai");
  });

  it("aliases kimi variants to kimi", () => {
    expect(normalizeProviderId("kimi-code")).toBe("kimi");
    expect(normalizeProviderId("kimi-coding")).toBe("kimi");
  });

  it("aliases moonshotai to moonshot (regression for #73876)", () => {
    expect(normalizeProviderId("moonshotai")).toBe("moonshot");
    expect(normalizeProviderId("MoonshotAI")).toBe("moonshot");
    expect(normalizeProviderId("MOONSHOTAI")).toBe("moonshot");
  });

  it("aliases moonshot-ai to moonshot (regression for #73876)", () => {
    expect(normalizeProviderId("moonshot-ai")).toBe("moonshot");
    expect(normalizeProviderId("Moonshot-AI")).toBe("moonshot");
  });

  it("preserves canonical moonshot id (no double-aliasing, regression for #73876)", () => {
    expect(normalizeProviderId("moonshot")).toBe("moonshot");
  });

  it("aliases bedrock variants to amazon-bedrock", () => {
    expect(normalizeProviderId("bedrock")).toBe("amazon-bedrock");
    expect(normalizeProviderId("aws-bedrock")).toBe("amazon-bedrock");
  });

  it("aliases volcengine legacy names", () => {
    expect(normalizeProviderId("bytedance")).toBe("volcengine");
    expect(normalizeProviderId("doubao")).toBe("volcengine");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(normalizeProviderId("")).toBe("");
    expect(normalizeProviderId("   ")).toBe("");
  });
});

describe("findNormalizedProviderValue", () => {
  it("returns undefined for missing entries", () => {
    expect(findNormalizedProviderValue(undefined, "moonshot")).toBeUndefined();
    expect(findNormalizedProviderValue({}, "moonshot")).toBeUndefined();
  });

  it("matches via canonical key when caller passes alias (regression for #73876)", () => {
    const entries = { moonshot: { apiKey: "k" } };
    expect(findNormalizedProviderValue(entries, "moonshotai")).toEqual({ apiKey: "k" });
    expect(findNormalizedProviderValue(entries, "moonshot-ai")).toEqual({ apiKey: "k" });
  });

  it("matches via alias key when caller passes canonical (regression for #73876)", () => {
    const entries = { moonshotai: { apiKey: "k" } };
    expect(findNormalizedProviderValue(entries, "moonshot")).toEqual({ apiKey: "k" });
  });

  it("preserves existing kimi alias matching", () => {
    const entries = { kimi: { apiKey: "k" } };
    expect(findNormalizedProviderValue(entries, "kimi-code")).toEqual({ apiKey: "k" });
  });
});
