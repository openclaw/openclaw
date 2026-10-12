import { describe, expect, it } from "vitest";
import {
  canonicalModelFamily,
  canonicalModelKey,
  compareModelRecency,
} from "./canonical-model-key.js";

describe("canonicalModelKey", () => {
  it.each([
    ["us.anthropic.claude-opus-4-5-20251101-v1:0", "claude-opus-4.5"],
    ["anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4.5"],
    ["deepseek.r1-v1:0", "deepseek-r1"],
    ["claude-fable-5-1@20260801", "claude-fable-5.1"],
    ["claude-4.6-sonnet", "claude-sonnet-4.6"],
    ["accounts/fireworks/models/glm-5p3", "glm-5.3"],
    ["z-ai/glm-5.3", "glm-5.3"],
    ["qwen3.8:27b", "qwen3.8-27b"],
    ["mistralai/mistral-large-4-0", "mistral-large-4"],
    ["qwen3.8:latest", "qwen3.8"],
    ["gemma4:e4b", "gemma-4-e4b"],
    ["gemma-4-26b-a4b-it", "gemma-4-26b-a4b"],
    ["openai-gpt-56-luna", "gpt-5.6-luna"],
    ["openai/gpt-5.6-luna-20260709", "gpt-5.6-luna"],
    ["GPT 5.6 Sol (xHigh)", "gpt-5.6-sol"],
    ["Solar Pro 4", "solar-pro4"],
    ["solar-pro4", "solar-pro4"],
    ["minimax-m27", "minimax-m2.7"],
    ["MiniMax-M2.7", "minimax-m2.7"],
    ["deepseek-ai/DeepSeek-V4-Pro-TEE", "deepseek-v4-pro"],
    ["openai/gpt-oss-120b:free", "gpt-oss-120b"],
  ])("maps %s to %s", (modelId, key) => {
    expect(canonicalModelKey(modelId)).toBe(key);
  });

  it("folds fast serving variants into the base model", () => {
    expect(canonicalModelKey("grok-4.20-fast")).toBe("grok-4.20");
    expect(canonicalModelKey("kimi-k3-fast-api")).toBe("kimi-k3");
    expect(canonicalModelKey("MiniMax-M2.7-highspeed")).toBe("minimax-m2.7");
    // A fast suffix inside the model name is part of a different model.
    expect(canonicalModelKey("grok-code-fast-1")).toBe("grok-code-fast-1");
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
  it.each([
    ["gpt-5.6-luna", "gpt-luna", [5, 6]],
    ["claude-opus-4.5", "claude-opus", [4, 5]],
    ["qwen3.8-27b", "qwen-27b", [3, 8]],
    ["minimax-m2.7", "minimax-m", [2, 7]],
    ["solar-pro4", "solar-pro", [4]],
    ["gpt-oss-120b", "gpt-oss-120b", []],
  ])("splits %s into %s %j", (key, name, version) => {
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
