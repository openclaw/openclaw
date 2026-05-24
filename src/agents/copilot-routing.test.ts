import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelSelectionShouldEnsureCopilotSdk } from "./copilot-routing.js";

const emptyCfg = {} as OpenClawConfig;

describe("modelSelectionShouldEnsureCopilotSdk", () => {
  it("returns true for github-copilot/*", () => {
    expect(
      modelSelectionShouldEnsureCopilotSdk({
        model: "github-copilot/gpt-4o",
        config: emptyCfg,
      }),
    ).toBe(true);
  });

  it("returns false for other providers", () => {
    expect(modelSelectionShouldEnsureCopilotSdk({ model: "openai/gpt-4o", config: emptyCfg })).toBe(
      false,
    );
    expect(
      modelSelectionShouldEnsureCopilotSdk({
        model: "anthropic/claude-3",
        config: emptyCfg,
      }),
    ).toBe(false);
    expect(
      modelSelectionShouldEnsureCopilotSdk({
        model: "openai-codex/gpt-4o",
        config: emptyCfg,
      }),
    ).toBe(false);
  });

  it("returns false for undefined or empty model", () => {
    expect(modelSelectionShouldEnsureCopilotSdk({ config: emptyCfg })).toBe(false);
    expect(modelSelectionShouldEnsureCopilotSdk({ model: "", config: emptyCfg })).toBe(false);
  });

  it("returns false for model without a provider prefix", () => {
    expect(modelSelectionShouldEnsureCopilotSdk({ model: "gpt-4o", config: emptyCfg })).toBe(false);
  });
});
