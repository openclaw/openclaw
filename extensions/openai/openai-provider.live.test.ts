// Openai tests cover openai provider plugin behavior.
import OpenAI from "openai";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const DEFAULT_LIVE_MODEL_IDS = [
  "gpt-5.6-luna",
  "chat-latest",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
] as const;
const liveEnabled = OPENAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

type LiveModelCase = {
  modelId: string;
  templateId: string;
  templateName: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  textVerbosity: "low" | "medium";
};

function resolveLiveModelCase(modelId: string): LiveModelCase {
  const buildCase = (
    [templateId, templateName]: [id: string, name: string],
    [input, output, cacheRead, cacheWrite]: [
      input: number,
      output: number,
      cacheRead: number,
      cacheWrite: number,
    ],
    [contextWindow, maxTokens, reasoning, textVerbosity]: [
      contextWindow: number,
      maxTokens: number,
      reasoning: boolean,
      textVerbosity: LiveModelCase["textVerbosity"],
    ],
  ): LiveModelCase => ({
    modelId,
    templateId,
    templateName,
    cost: { input, output, cacheRead, cacheWrite },
    contextWindow,
    maxTokens,
    reasoning,
    textVerbosity,
  });
  switch (modelId) {
    case "gpt-6.1-sol":
      return buildCase(
        ["gpt-5.6-sol", "GPT-5.6 Sol"],
        [2, 10, 0.1, 2.5],
        [1_050_000, 128_000, true, "low"],
      );
    case "gpt-6-astra":
      return buildCase(
        ["gpt-5.6-sol", "GPT-5.6 Sol"],
        [10, 50, 1, 12.5],
        [1_050_000, 128_000, true, "low"],
      );
    case "gpt-6-sol":
    case "gpt-6-luna":
      return buildCase(
        ["gpt-5.6-sol", "GPT-5.6 Sol"],
        modelId === "gpt-6-sol" ? [2, 10, 0.2, 2.5] : [0.1, 0.5, 0.01, 0.125],
        [1_050_000, 128_000, true, "low"],
      );
    case "gpt-5.6":
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-5.6-luna":
      return buildCase(
        ["gpt-5.5", "GPT-5.5"],
        modelId === "gpt-5.6-terra"
          ? [2.5, 15, 0.25, 3.125]
          : modelId === "gpt-5.6-luna"
            ? [1, 6, 0.1, 1.25]
            : [5, 30, 0.5, 6.25],
        [1_050_000, 128_000, true, "low"],
      );
    case "chat-latest":
      return buildCase(
        ["gpt-5.5", "GPT-5.5"],
        [5, 30, 0.5, 0],
        [400_000, 128_000, false, "medium"],
      );
    case "gpt-5.5":
      return buildCase(["gpt-5.5", "GPT-5.5"], [5, 30, 0.5, 0], [1_050_000, 128_000, true, "low"]);
    case "gpt-5.5-pro":
      return buildCase(
        ["gpt-5.4-pro", "GPT-5.4 Pro"],
        [30, 180, 0, 0],
        [1_050_000, 128_000, true, "low"],
      );
    case "gpt-5.4":
      return buildCase(
        ["gpt-5.2", "GPT-5.2"],
        [2.5, 15, 0.25, 0],
        [1_050_000, 128_000, true, "low"],
      );
    case "gpt-5.4-pro":
      return buildCase(
        ["gpt-5.2-pro", "GPT-5.2 Pro"],
        [30, 180, 0, 0],
        [1_050_000, 128_000, true, "low"],
      );
    case "gpt-5.4-mini":
      return buildCase(
        ["gpt-5-mini", "GPT-5 mini"],
        [0.75, 4.5, 0.075, 0],
        [400_000, 128_000, true, "low"],
      );
    case "gpt-5.4-nano":
      return buildCase(
        ["gpt-5-nano", "GPT-5 nano"],
        [0.2, 1.25, 0.02, 0],
        [400_000, 128_000, true, "low"],
      );
    default:
      throw new Error(`Unsupported live OpenAI model: ${modelId}`);
  }
}

function resolveLiveModelCases(raw?: string): LiveModelCase[] {
  const requested: string[] = [];
  for (const value of raw?.split(",") ?? []) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      requested.push(trimmed);
    }
  }
  const modelIds = requested.length ? requested : [...DEFAULT_LIVE_MODEL_IDS];
  return [...new Set(modelIds)].map((modelId) => resolveLiveModelCase(modelId));
}

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
              reasoning: liveCase.reasoning,
              input: ["text", "image"],
              cost: liveCase.cost,
              contextWindow: liveCase.contextWindow,
              maxTokens: liveCase.maxTokens,
            } satisfies ProviderRuntimeModel;
          }
          return null;
        },
      };

      const resolved =
        registry.find("openai", liveCase.modelId) ??
        provider.resolveDynamicModel?.({
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

      expect(normalized?.provider).toBe("openai");
      expect(normalized?.id).toBe(liveCase.modelId);
      expect(normalized?.api).toBe("openai-responses");
      expect(normalized?.baseUrl).toBe("https://api.openai.com/v1");
      expect(normalized?.reasoning).toEqual(liveCase.reasoning);

      const client = new OpenAI({
        apiKey: OPENAI_API_KEY,
        baseURL: normalized?.baseUrl,
      });

      const requiresReasoning = normalized?.thinkingLevelMap?.off === null;
      const response = await client.responses.create({
        model: normalized?.id ?? liveCase.modelId,
        instructions: "Return exactly OK and no other text.",
        input: "Return exactly OK.",
        max_output_tokens: requiresReasoning ? 256 : 64,
        ...(liveCase.reasoning
          ? {
              reasoning: {
                effort: requiresReasoning ? ("low" as const) : ("none" as const),
              },
            }
          : {}),
        text: { verbosity: liveCase.textVerbosity },
      });

      expect(response.output_text.trim()).toMatch(/^OK[.!]?$/);
    },
    180_000,
  );
});
