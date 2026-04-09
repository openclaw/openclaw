import { describe, expect, it, vi } from "vitest";
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
});
