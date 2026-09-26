/**
 * Regression coverage for model ref auth-profile suffix parsing.
 * Ensures model version and local quantization `@` suffixes are preserved.
 */
import { describe, expect, it } from "vitest";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";

describe("splitTrailingAuthProfile", () => {
  it.each([
    [" openai/gpt-5 ", { model: "openai/gpt-5" }],
    ["openai/gpt-5@work", { model: "openai/gpt-5", profile: "work" }],
    ["openai/@cf/openai/gpt-oss-20b", { model: "openai/@cf/openai/gpt-oss-20b" }],
    [
      "openai/@cf/openai/gpt-oss-20b@cf:default",
      { model: "openai/@cf/openai/gpt-oss-20b", profile: "cf:default" },
    ],
    [
      "flash@google-gemini-cli:test@gmail.com",
      { model: "flash", profile: "google-gemini-cli:test@gmail.com" },
    ],
    [
      "custom/vertex-ai_claude-haiku-4-5@20251001",
      { model: "custom/vertex-ai_claude-haiku-4-5@20251001" },
    ],
    [
      "custom/vertex-ai_claude-haiku-4-5@20251001@work",
      { model: "custom/vertex-ai_claude-haiku-4-5@20251001", profile: "work" },
    ],
    ["lmstudio-mb-pro/gemma-4-31b-it@q8_0", { model: "lmstudio-mb-pro/gemma-4-31b-it@q8_0" }],
    [
      "lmstudio/qwen3.6-27b@iq3_xxs@work",
      { model: "lmstudio/qwen3.6-27b@iq3_xxs", profile: "work" },
    ],
  ] as const)("parses %s without losing model suffixes", (raw, expected) => {
    expect(splitTrailingAuthProfile(raw)).toEqual(expected);
  });

  it("keeps @iq* importance-quantization suffixes in model ids", () => {
    expect(splitTrailingAuthProfile("lmstudio/qwen3.6-27b@iq3_xxs")).toEqual({
      model: "lmstudio/qwen3.6-27b@iq3_xxs",
    });
    expect(splitTrailingAuthProfile("lmstudio/qwen3.6-27b@iq4_xs")).toEqual({
      model: "lmstudio/qwen3.6-27b@iq4_xs",
    });
  });

  it("keeps @4bit/@8bit quant suffixes in model ids", () => {
    expect(splitTrailingAuthProfile("lmstudio-mb-pro/gemma-4-31b@4bit")).toEqual({
      model: "lmstudio-mb-pro/gemma-4-31b@4bit",
    });
    expect(splitTrailingAuthProfile("lmstudio-mb-pro/gemma-4-31b@8bit")).toEqual({
      model: "lmstudio-mb-pro/gemma-4-31b@8bit",
    });
  });
});
