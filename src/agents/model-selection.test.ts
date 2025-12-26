import { describe, expect, it } from "vitest";

import type { ClawdisConfig } from "../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { resolveConfiguredModelRef } from "./model-selection.js";

describe("resolveConfiguredModelRef", () => {
  it("parses provider/model from agent.model", () => {
    const cfg = {
      agent: { model: "openai/gpt-4.1-mini" },
    } satisfies ClawdisConfig;

    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    expect(resolved).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
  });

  it("falls back to anthropic when agent.model omits provider", () => {
    const cfg = {
      agent: { model: "claude-opus-4-5" },
    } satisfies ClawdisConfig;

    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    expect(resolved).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
  });

  it("falls back to defaults when agent.model is missing", () => {
    const cfg = {} satisfies ClawdisConfig;

    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    expect(resolved).toEqual({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    });
  });
});
