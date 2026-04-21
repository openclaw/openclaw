import { describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { expectPassthroughReplayPolicy } from "../../test/helpers/provider-replay-policy.ts";
import openrouterPlugin from "./index.js";

describe("openrouter provider hooks", () => {
  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "openai/gpt-5.4",
    });
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

  it("canonicalizes stale OpenRouter /v1 config and runtime metadata", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.normalizeConfig?.({
        provider: "openrouter",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/v1/",
          models: [],
        },
      } as never),
    ).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
    });

    expect(
      provider.normalizeResolvedModel?.({
        provider: "openrouter",
        model: {
          provider: "openrouter",
          id: "openai/gpt-5.4",
          name: "openai/gpt-5.4",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      } as never),
    ).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
    });

    expect(
      provider.normalizeTransport?.({
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
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

    void wrapped?.(
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

  it("resolveDynamicModel returns id=auto for openrouter/auto sentinel (#69527)", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "openrouter",
      modelId: "openrouter/auto",
      modelRegistry: { find: vi.fn(() => null) } as never,
    } as never);

    expect(resolved).toMatchObject({
      provider: "openrouter",
      id: "auto",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("resolveDynamicModel preserves prefixed id for normal OpenRouter model ids", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      modelRegistry: { find: vi.fn(() => null) } as never,
    } as never);

    expect(resolved).toMatchObject({
      provider: "openrouter",
      id: "openai/gpt-5.4",
    });
  });

  it("prepareDynamicModel is called with auto model id for openrouter/auto sentinel", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    // We verify the apiModelId normalization via isCacheTtlEligible
    // which also uses the apiModelId normalization
    expect(
      provider.isCacheTtlEligible?.({
        provider: "openrouter",
        modelId: "openrouter/auto",
      } as never),
    ).toBe(false);

    expect(
      provider.isCacheTtlEligible?.({
        provider: "openrouter",
        modelId: "anthropic/claude-3-5-sonnet",
      } as never),
    ).toBe(true);
  });
});
