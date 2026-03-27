import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";

const getCodexOAuthApiKeyMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-codex-provider.runtime.js", () => ({
  getOAuthApiKey: getCodexOAuthApiKeyMock,
}));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const DEFAULT_LIVE_MODEL_IDS = ["gpt-5.4-mini", "gpt-5.4-nano"] as const;
const liveEnabled = OPENAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

type LiveModelCase = {
  modelId: string;
  templateId: string;
  templateName: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

function resolveLiveModelCase(modelId: string): LiveModelCase {
  switch (modelId) {
    case "gpt-5.4":
      return {
        modelId,
        templateId: "gpt-5.2",
        templateName: "GPT-5.2",
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-pro":
      return {
        modelId,
        templateId: "gpt-5.2-pro",
        templateName: "GPT-5.2 Pro",
        cost: { input: 15, output: 60, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-mini":
      return {
        modelId,
        templateId: "gpt-5-mini",
        templateName: "GPT-5 mini",
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-nano":
      return {
        modelId,
        templateId: "gpt-5-nano",
        templateName: "GPT-5 nano",
        cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      };
    default:
      throw new Error(`Unsupported live OpenAI model: ${modelId}`);
  }
}

function resolveLiveModelCases(raw?: string): LiveModelCase[] {
  const requested = raw
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const modelIds = requested?.length ? requested : [...DEFAULT_LIVE_MODEL_IDS];
  return [...new Set(modelIds)].map((modelId) => resolveLiveModelCase(modelId));
}

describe("buildOpenAIProvider", () => {
  it("resolves gpt-5.4 mini and nano from GPT-5 small-model templates", () => {
    const provider = buildOpenAIProvider();
    const registry = {
      find(providerId: string, id: string) {
        if (providerId !== "openai") {
          return null;
        }
        if (id === "gpt-5-mini") {
          return {
            id,
            name: "GPT-5 mini",
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 400_000,
            maxTokens: 128_000,
          };
        }
        if (id === "gpt-5-nano") {
          return {
            id,
            name: "GPT-5 nano",
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
          };
        }
        return null;
      },
    };

    const mini = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-mini",
      modelRegistry: registry as never,
    });
    const nano = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      modelRegistry: registry as never,
    });

    expect(mini).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(nano).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  });

  it("surfaces gpt-5.4 mini and nano in xhigh and augmented catalog metadata", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.supportsXHighThinking?.({
        provider: "openai",
        modelId: "gpt-5.4-mini",
      } as never),
    ).toBe(true);
    expect(
      provider.supportsXHighThinking?.({
        provider: "openai",
        modelId: "gpt-5.4-nano",
      } as never),
    ).toBe(true);

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
        { provider: "openai", id: "gpt-5-nano", name: "GPT-5 nano" },
      ],
    } as never);

    expect(entries).toContainEqual({
      provider: "openai",
      id: "gpt-5.4-mini",
      name: "gpt-5.4-mini",
    });
    expect(entries).toContainEqual({
      provider: "openai",
      id: "gpt-5.4-nano",
      name: "gpt-5.4-nano",
    });
  });

  it("keeps modern live selection on OpenAI 5.2+ and Codex 5.2+", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAICodexProviderPlugin();

    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.0",
      } as never),
    ).toBe(false);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.2",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.4",
      } as never),
    ).toBe(true);

    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.1-codex",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.1-codex-max",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.2-codex",
      } as never),
    ).toBe(true);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai-codex",
        modelId: "gpt-5.4",
      } as never),
    ).toBe(true);
  });

  it("falls back to cached codex oauth credentials on accountId extraction failures", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    };

    getCodexOAuthApiKeyMock.mockReset();
    getCodexOAuthApiKeyMock.mockRejectedValueOnce(
      new Error("Failed to extract accountId from token"),
    );

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
  });
});

describeLive("buildOpenAIProvider live", () => {
  it.each(resolveLiveModelCases(process.env.OPENCLAW_LIVE_OPENAI_MODELS))(
    "resolves %s and completes through the OpenAI responses API",
    async (liveCase) => {
      const provider = buildOpenAIProvider();
      const registry = {
        find(providerId: string, id: string) {
          if (providerId !== "openai") {
            return null;
          }
          if (id === liveCase.templateId) {
            return {
              id: liveCase.templateId,
              name: liveCase.templateName,
              provider: "openai",
              api: "openai-completions",
              baseUrl: "https://api.openai.com/v1",
              reasoning: true,
              input: ["text", "image"],
              cost: liveCase.cost,
              contextWindow: liveCase.contextWindow,
              maxTokens: liveCase.maxTokens,
            };
          }
          return null;
        },
      };

      const resolved = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: liveCase.modelId,
        modelRegistry: registry as never,
      });
      if (!resolved) {
        throw new Error(`openai provider did not resolve ${liveCase.modelId}`);
      }

      const normalized = provider.normalizeResolvedModel?.({
        provider: "openai",
        modelId: resolved.id,
        model: resolved,
      });

      expect(normalized).toMatchObject({
        provider: "openai",
        id: liveCase.modelId,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });

      const client = new OpenAI({
        apiKey: OPENAI_API_KEY,
        baseURL: normalized?.baseUrl,
      });

      const response = await client.responses.create({
        model: normalized?.id ?? liveCase.modelId,
        input: "Reply with exactly OK.",
        max_output_tokens: 16,
      });

      expect(response.output_text.trim()).toMatch(/^OK[.!]?$/);
    },
    30_000,
  );
});
