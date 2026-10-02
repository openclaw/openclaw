import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import type { OpenClawConfig } from "../config/config.js";
import type { LiveResolvedModel } from "./live-cache-test-support.js";
import { buildUsageWithNoCost } from "./stream-message-shared.js";

function resolveProviderBaseUrl(model: LiveResolvedModel["model"]): string | undefined {
  const candidate = model.baseUrl;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function resolveDefaultProviderBaseUrl(model: LiveResolvedModel["model"]): string {
  if (model.provider === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  if (model.provider === "openai") {
    return "https://api.openai.com/v1";
  }
  return "https://example.invalid/v1";
}

function buildEmbeddedModelDefinition(model: LiveResolvedModel["model"]) {
  // Live model discovery can return partial metadata; embedded runner tests need
  // a complete config model definition.
  const contextWindowCandidate = model.contextWindow;
  const maxTokensCandidate = model.maxTokens;
  const reasoningCandidate = model.reasoning;
  const inputCandidate = model.input;
  const contextWindow =
    typeof contextWindowCandidate === "number" && Number.isFinite(contextWindowCandidate)
      ? Math.max(1, Math.trunc(contextWindowCandidate))
      : 128_000;
  const maxTokens =
    typeof maxTokensCandidate === "number" && Number.isFinite(maxTokensCandidate)
      ? Math.max(1, Math.trunc(maxTokensCandidate))
      : 8_192;
  const input: Array<"text" | "image"> =
    Array.isArray(inputCandidate) &&
    inputCandidate.every((value) => value === "text" || value === "image")
      ? [...inputCandidate]
      : ["text", "image"];
  return {
    id: model.id,
    name: model.id,
    api: resolveEmbeddedModelApi(model),
    reasoning: typeof reasoningCandidate === "boolean" ? reasoningCandidate : false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

function resolveEmbeddedModelApi(
  model: LiveResolvedModel["model"],
): "anthropic-messages" | "openai-responses" {
  return model.provider === "anthropic" ? "anthropic-messages" : "openai-responses";
}

export function normalizeLiveUsage(
  usage:
    | AssistantMessage["usage"]
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined,
): AssistantMessage["usage"] {
  if (!usage) {
    return buildUsageWithNoCost({});
  }
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const totalTokens =
    "totalTokens" in usage && typeof usage.totalTokens === "number"
      ? usage.totalTokens
      : "total" in usage && typeof usage.total === "number"
        ? usage.total
        : input + output;
  const cost =
    "cost" in usage && usage.cost
      ? usage.cost
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
  };
}

export function buildEmbeddedRunnerConfig(
  params: LiveResolvedModel & {
    agentDir: string;
    cacheRetention: "none" | "short" | "long";
    compactionModel?: string;
    modelAlias?: string;
    transport?: "sse" | "websocket";
  },
): OpenClawConfig {
  const provider = params.model.provider;
  const modelKey = `${provider}/${params.model.id}`;
  const providerBaseUrl =
    resolveProviderBaseUrl(params.model) ?? resolveDefaultProviderBaseUrl(params.model);
  return {
    models: {
      providers: {
        [provider]: {
          api: resolveEmbeddedModelApi(params.model),
          auth: "api-key",
          apiKey: params.apiKey,
          baseUrl: providerBaseUrl,
          models: [buildEmbeddedModelDefinition(params.model)],
        },
      },
    },
    agents: {
      entries: { main: { agentDir: params.agentDir } },
      defaults: {
        models: {
          [modelKey]: {
            ...(params.modelAlias ? { alias: params.modelAlias } : {}),
            params: {
              cacheRetention: params.cacheRetention,
              ...(params.transport ? { transport: params.transport } : {}),
            },
          },
        },
        ...(params.compactionModel ? { compaction: { model: params.compactionModel } } : {}),
      },
    },
  };
}
