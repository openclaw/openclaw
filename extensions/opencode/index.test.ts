import { describe, expect, it } from "vitest";
import type { ProviderPlugin } from "../../src/plugins/types.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("opencode provider plugin", () => {
  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "opencode",
        modelApi: "openai-completions",
        modelId: "gemini-2.5-pro",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
    });
  });

  it("keeps non-Gemini replay policy minimal on passthrough routes", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "opencode",
        modelApi: "openai-completions",
        modelId: "claude-opus-4.6",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
    expect(
      provider.buildReplayPolicy?.({
        provider: "opencode",
        modelApi: "openai-completions",
        modelId: "claude-opus-4.6",
      } as never),
    ).not.toHaveProperty("sanitizeThoughtSignatures");
  });

  describe("GPT-5 prompt overlay", () => {
    function buildContributionContext(
      modelId: string,
    ): Parameters<NonNullable<ProviderPlugin["resolveSystemPromptContribution"]>>[0] {
      return {
        config: undefined,
        agentDir: undefined,
        workspaceDir: undefined,
        provider: "opencode",
        modelId,
        promptMode: "full",
        runtimeChannel: undefined,
        runtimeCapabilities: undefined,
        agentId: undefined,
      };
    }

    it("applies GPT-5 prompt overlay for gpt-5.4 model ID", async () => {
      const provider = await registerSingleProviderPlugin(plugin);
      const result = provider.resolveSystemPromptContribution?.(
        buildContributionContext("gpt-5.4"),
      );

      expect(result).toBeDefined();
      expect(result?.stablePrefix).toContain("GPT-5 Output Contract");
      expect(result?.sectionOverrides?.interaction_style).toContain(
        "Be warm, collaborative, and quietly supportive.",
      );
      expect(result?.sectionOverrides?.execution_bias).toContain(
        "Start the real work in the same turn when the next step is clear.",
      );
    });

    it("applies GPT-5 prompt overlay for slash-prefixed gpt-5 model ID", async () => {
      const provider = await registerSingleProviderPlugin(plugin);
      const result = provider.resolveSystemPromptContribution?.(
        buildContributionContext("opencode/gpt-5.4"),
      );

      expect(result).toBeDefined();
      expect(result?.sectionOverrides?.interaction_style).toContain(
        "Be warm, collaborative, and quietly supportive.",
      );
    });

    it("returns undefined for non-GPT-5 models", async () => {
      const provider = await registerSingleProviderPlugin(plugin);

      expect(
        provider.resolveSystemPromptContribution?.(buildContributionContext("claude-sonnet-4-6")),
      ).toBeUndefined();

      expect(
        provider.resolveSystemPromptContribution?.(buildContributionContext("gemini-2.5-pro")),
      ).toBeUndefined();
    });
  });
});
