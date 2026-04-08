import { describe, expect, it, vi } from "vitest";
import type { ProviderPlugin } from "../../src/plugins/types.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import openrouterPlugin from "./index.js";

describe("openrouter provider hooks", () => {
  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "openrouter",
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

    expect(
      provider.buildReplayPolicy?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
    expect(
      provider.buildReplayPolicy?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
      } as never),
    ).not.toHaveProperty("sanitizeThoughtSignatures");
  });

  it("owns native reasoning output mode", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
      } as never),
    ).toBe("native");
  });

  it("injects provider routing into compat before applying stream wrappers", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const baseStreamFn = vi.fn(
      (..._args: Parameters<import("@mariozechner/pi-agent-core").StreamFn>) =>
        ({ async *[Symbol.asyncIterator]() {} }) as never,
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      extraParams: {
        provider: {
          order: ["moonshot"],
        },
      },
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openai/gpt-5.4",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const firstCall = baseStreamFn.mock.calls[0];
    const firstModel = firstCall?.[0];
    expect(firstModel).toMatchObject({
      compat: {
        openRouterRouting: {
          order: ["moonshot"],
        },
      },
    });
  });

  describe("GPT-5 prompt overlay", () => {
    function buildContributionContext(
      modelId: string,
    ): Parameters<NonNullable<ProviderPlugin["resolveSystemPromptContribution"]>>[0] {
      return {
        config: undefined,
        agentDir: undefined,
        workspaceDir: undefined,
        provider: "openrouter",
        modelId,
        promptMode: "full",
        runtimeChannel: undefined,
        runtimeCapabilities: undefined,
        agentId: undefined,
      };
    }

    it("applies GPT-5 prompt overlay for openai/gpt-5.4 model ID", async () => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      const result = provider.resolveSystemPromptContribution?.(
        buildContributionContext("openai/gpt-5.4"),
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

    it("applies GPT-5 prompt overlay for openrouter-native gpt-5 model ID", async () => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      const result = provider.resolveSystemPromptContribution?.(
        buildContributionContext("openrouter/gpt-5.4"),
      );

      expect(result).toBeDefined();
      expect(result?.sectionOverrides?.interaction_style).toContain(
        "Be warm, collaborative, and quietly supportive.",
      );
    });

    it("returns undefined for non-GPT-5 models", async () => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);

      expect(
        provider.resolveSystemPromptContribution?.(
          buildContributionContext("anthropic/claude-sonnet-4-6"),
        ),
      ).toBeUndefined();

      expect(
        provider.resolveSystemPromptContribution?.(buildContributionContext("gemini-2.5-pro")),
      ).toBeUndefined();
    });
  });
});
