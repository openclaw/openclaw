import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePreservedSessionContextTokens } from "./session-context-tokens.js";

describe("resolvePreservedSessionContextTokens", () => {
  it("preserves an existing larger session context over smaller runtime metadata", () => {
    expect(
      resolvePreservedSessionContextTokens({
        cfg: { agents: { defaults: { contextTokens: 1_050_000 } } } as OpenClawConfig,
        provider: "openai-codex",
        model: "gpt-5.5",
        runtimeContextTokens: 272_000,
        existingEntry: {
          sessionId: "s1",
          modelProvider: "openai-codex",
          model: "gpt-5.5",
          contextTokens: 1_050_000,
          updatedAt: 1,
        },
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      }),
    ).toBe(1_050_000);
  });

  it("uses the largest explicit candidate instead of blindly trusting runtime", () => {
    expect(
      resolvePreservedSessionContextTokens({
        cfg: {} as OpenClawConfig,
        runtimeContextTokens: 272_000,
        contextTokensOverride: 1_050_000,
        existingContextTokens: 200_000,
        fallbackContextTokens: 128_000,
        allowAsyncLoad: false,
      }),
    ).toBe(1_050_000);
  });
});
