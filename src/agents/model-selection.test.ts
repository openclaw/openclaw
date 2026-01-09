import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import {
  buildAllowedModelSet,
  modelKey,
  parseModelRef,
} from "./model-selection.js";

const catalog = [
  {
    provider: "openai",
    id: "gpt-4",
    name: "GPT-4",
  },
];

describe("buildAllowedModelSet", () => {
  it("always allows the configured default model", () => {
    const cfg = {
      agent: {
        models: {
          "openai/gpt-4": { alias: "gpt4" },
        },
      },
    } as ClawdbotConfig;

    const allowed = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "claude-cli",
      defaultModel: "opus-4.5",
    });

    expect(allowed.allowAny).toBe(false);
    expect(allowed.allowedKeys.has(modelKey("openai", "gpt-4"))).toBe(true);
    expect(allowed.allowedKeys.has(modelKey("claude-cli", "opus-4.5"))).toBe(
      true,
    );
  });

  it("includes the default model when no allowlist is set", () => {
    const cfg = {
      agent: {},
    } as ClawdbotConfig;

    const allowed = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "claude-cli",
      defaultModel: "opus-4.5",
    });

    expect(allowed.allowAny).toBe(true);
    expect(allowed.allowedKeys.has(modelKey("openai", "gpt-4"))).toBe(true);
    expect(allowed.allowedKeys.has(modelKey("claude-cli", "opus-4.5"))).toBe(
      true,
    );
  });
});

describe("parseModelRef", () => {
  it("normalizes anthropic/opus-4.5 to claude-opus-4-5", () => {
    const ref = parseModelRef("anthropic/opus-4.5", "anthropic");
    expect(ref).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
  });
});
