import { describe, expect, it } from "vitest";
import {
  canonicalModelFamily,
  canonicalModelKey,
  compareModelRecency,
} from "./canonical-model-key.js";

describe("canonicalModelKey", () => {
  it.each([
    ["deepseek.r1-v1:0", "deepseek-r1"],
    ["qwen3.8:27b", "qwen3.8-27b"],
    ["openai/gpt-oss-120b:free", "gpt-oss-120b"],
  ])("maps %s to %s", (modelId, key) => {
    expect(canonicalModelKey(modelId)).toBe(key);
  });

  it("takes a dated alias's version from its display name in the same family", () => {
    expect(canonicalModelKey("mistral-medium-2604")).toBe("mistral-medium");
    expect(canonicalModelKey("mistral-medium-2604", "Mistral Medium 3.5")).toBe(
      "mistral-medium-3.5",
    );
    expect(canonicalModelKey("deepseek-chat", "DeepSeek V3.2")).toBe("deepseek-chat");
    expect(canonicalModelKey("glm-5.3", "GLM 5.2")).toBe("glm-5.3");
  });

  it("gives malformed oversized upstream strings no key", () => {
    expect(canonicalModelKey("(".repeat(1_000_000))).toBe("");
    expect(canonicalModelKey("mistral-medium-2604", "(".repeat(1_000_000))).toBe("mistral-medium");
  });
});

describe("canonicalModelFamily", () => {
  it.each([["solar-pro4", "solar-pro", [4]]])("splits %s into %s %j", (key, name, version) => {
    expect(canonicalModelFamily(key)).toEqual({ name, version });
  });
});

describe("compareModelRecency", () => {
  it("prefers release dates over version numbers", () => {
    const releasedAt = new Map([
      ["grok-4.20", Date.parse("2026-02-17")],
      ["grok-4.7", Date.parse("2026-08-12")],
    ]);
    expect(compareModelRecency("grok-4.7", "grok-4.20", releasedAt)).toBeGreaterThan(0);
  });

  it("falls back to versions when either release date is unknown", () => {
    const releasedAt = new Map([["grok-4.7", Date.parse("2026-08-12")]]);
    expect(compareModelRecency("grok-4.20", "grok-4.7", releasedAt)).toBeGreaterThan(0);
    expect(compareModelRecency("claude-opus-4.5", "claude-opus-4", new Map())).toBeGreaterThan(0);
    expect(compareModelRecency("glm-5.3", "glm-5.3", new Map())).toBe(0);
  });
});
