import { describe, expect, it } from "vitest";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildRuntimeLine } from "../../system-prompt.js";

/**
 * Test for issue #10404: Runtime metadata shows stale model
 *
 * This test verifies that the Runtime line in the system prompt
 * correctly shows the current turn's model, not a stale value
 * from session state.
 */
describe("runtime model in system prompt", () => {
  describe("buildSystemPromptParams", () => {
    it("uses the model passed in runtime params, not any cached value", () => {
      // Scenario: Primary model was changed from Sonnet to Codex in config.
      // The current turn should use Codex, regardless of what was persisted
      // in session state from a previous turn.
      const result = buildSystemPromptParams({
        runtime: {
          host: "test-host",
          os: "test-os",
          arch: "x64",
          node: "v22",
          // This is the model for the CURRENT turn - should be used as-is
          model: "openai-codex/gpt-5.3-codex",
          defaultModel: "openai-codex/gpt-5.3-codex",
        },
      });

      expect(result.runtimeInfo.model).toBe("openai-codex/gpt-5.3-codex");
      expect(result.runtimeInfo.defaultModel).toBe("openai-codex/gpt-5.3-codex");
    });

    it("model and defaultModel can differ when fallback is used", () => {
      // Scenario: Primary model (Codex) is in cooldown, falling back to Sonnet
      // for this turn. Model should show the fallback, defaultModel shows config.
      const result = buildSystemPromptParams({
        runtime: {
          host: "test-host",
          os: "test-os",
          arch: "x64",
          node: "v22",
          model: "anthropic/claude-sonnet-4-5", // Fallback model for this turn
          defaultModel: "openai-codex/gpt-5.3-codex", // Config default
        },
      });

      expect(result.runtimeInfo.model).toBe("anthropic/claude-sonnet-4-5");
      expect(result.runtimeInfo.defaultModel).toBe("openai-codex/gpt-5.3-codex");
    });
  });

  describe("buildRuntimeLine", () => {
    it("includes the model passed to it in the output", () => {
      const line = buildRuntimeLine(
        {
          agentId: "main",
          host: "test-host",
          model: "openai-codex/gpt-5.3-codex",
          defaultModel: "openai-codex/gpt-5.3-codex",
        },
        "whatsapp",
        [],
        "off",
      );

      expect(line).toContain("model=openai-codex/gpt-5.3-codex");
      expect(line).toContain("default_model=openai-codex/gpt-5.3-codex");
    });

    it("shows different model vs defaultModel when fallback is active", () => {
      // Verify the Runtime line correctly shows when model differs from default
      const line = buildRuntimeLine(
        {
          agentId: "main",
          host: "test-host",
          model: "anthropic/claude-sonnet-4-5", // Currently using fallback
          defaultModel: "openai-codex/gpt-5.3-codex", // Config default
        },
        "whatsapp",
        [],
        "off",
      );

      expect(line).toContain("model=anthropic/claude-sonnet-4-5");
      expect(line).toContain("default_model=openai-codex/gpt-5.3-codex");
      // The agent greeting prompt checks if model != defaultModel
      // This verifies both values are preserved
    });
  });
});
