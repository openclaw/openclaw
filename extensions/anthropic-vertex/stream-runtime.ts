/**
 * Anthropic Vertex stream runtime. It constructs Vertex SDK clients and adapts
 * OpenClaw stream options for the shared Anthropic Messages transport.
 */
import { AnthropicVertex as AnthropicVertexSdk } from "@anthropic-ai/vertex-sdk";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  clampThinkingLevel,
  stream as streamDefault,
  type Model,
  type ModelThinkingLevel,
  type ProviderStreamOptions,
} from "openclaw/plugin-sdk/llm";
import {
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "openclaw/plugin-sdk/provider-model-shared";
import { resolveAnthropicVertexClientRegion, resolveAnthropicVertexProjectId } from "./region.js";

type AnthropicVertexTransportOptions = ProviderStreamOptions & {
  client?: unknown;
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};

type AnthropicVertexEffort = NonNullable<AnthropicVertexTransportOptions["effort"]>;
type AnthropicVertexAdaptiveEffort = AnthropicVertexEffort | "xhigh";
type AnthropicVertexClientOptions = {
  baseURL?: string;
  projectId?: string;
  region: string;
};

/** Injectable dependencies for Anthropic Vertex stream tests. */
export type AnthropicVertexStreamDeps = {
  AnthropicVertex: new (options: AnthropicVertexClientOptions) => unknown;
  streamAnthropic: typeof streamDefault;
};

const defaultAnthropicVertexStreamDeps: AnthropicVertexStreamDeps = {
  AnthropicVertex: AnthropicVertexSdk as AnthropicVertexStreamDeps["AnthropicVertex"],
  streamAnthropic: streamDefault,
};

function isClaudeOpus47OrNewerModel(modelId: string): boolean {
  return supportsClaudeNativeXhighEffort({ id: modelId });
}

function isClaudeFable5Model(modelId: string): boolean {
  return resolveClaudeFable5ModelIdentity({ id: modelId }) !== undefined;
}

function isClaudeMythos5Model(modelId: string): boolean {
  return /(?:^|-)claude-mythos-5(?=$|[^a-z0-9])/.test(resolveClaudeModelIdentity({ id: modelId }));
}

function supportsAdaptiveThinking(modelId: string): boolean {
  return supportsClaudeAdaptiveThinking({ id: modelId }) || isClaudeMythos5Model(modelId);
}

function mapAnthropicAdaptiveEffort(
  reasoning: ModelThinkingLevel,
  model: Model<"anthropic-messages">,
  modelId: string,
): AnthropicVertexAdaptiveEffort {
  const clampModel =
    typeof model.params?.canonicalModelId === "string" ? { ...model, reasoning: true } : model;
  const resolvedReasoning = clampThinkingLevel(clampModel, reasoning);
  const mapped = model.thinkingLevelMap?.[resolvedReasoning];
  if (typeof mapped === "string") {
    return mapped as AnthropicVertexAdaptiveEffort;
  }
  const effortMap: Record<string, AnthropicVertexAdaptiveEffort> = {
    off: "low",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: isClaudeFable5Model(modelId)
      ? "xhigh"
      : isClaudeOpus47OrNewerModel(modelId) || isClaudeMythos5Model(modelId)
        ? "xhigh"
        : "high",
    max:
      supportsClaudeNativeMaxEffort({ id: modelId }) || isClaudeMythos5Model(modelId)
        ? "max"
        : "high",
  };
  return effortMap[resolvedReasoning] ?? "high";
}

function resolveAnthropicVertexMaxTokens(params: {
  modelMaxTokens: number | undefined;
  requestedMaxTokens: number | undefined;
}): number | undefined {
  const modelMax =
    typeof params.modelMaxTokens === "number" &&
    Number.isFinite(params.modelMaxTokens) &&
    params.modelMaxTokens > 0
      ? Math.floor(params.modelMaxTokens)
      : undefined;
  const requested =
    typeof params.requestedMaxTokens === "number" &&
    Number.isFinite(params.requestedMaxTokens) &&
    params.requestedMaxTokens > 0
      ? Math.floor(params.requestedMaxTokens)
      : undefined;

  if (modelMax !== undefined && requested !== undefined) {
    return Math.min(requested, modelMax);
  }
  return requested ?? modelMax;
}

/**
 * Create a StreamFn that routes through OpenClaw's generic model stream with an
 * injected `AnthropicVertex` client.  All streaming, message conversion, and
 * event handling is handled by the shared model runtime - we only supply the GCP-authenticated
 * client and provider transport options.
 */
export function createAnthropicVertexStreamFn(
  projectId: string | undefined,
  region: string,
  baseURL?: string,
  deps: AnthropicVertexStreamDeps = defaultAnthropicVertexStreamDeps,
): StreamFn {
  const client = new deps.AnthropicVertex({
    region,
    ...(baseURL ? { baseURL } : {}),
    ...(projectId ? { projectId } : {}),
  });

  return (model, context, options) => {
    // Simple completions use a synthetic registry API to select this plugin.
    // The shared Anthropic transport must receive its canonical API or it recurses.
    const transportModel = (
      model.api === "anthropic-messages" ? model : { ...model, api: "anthropic-messages" as const }
    ) as Model<"anthropic-messages"> & {
      baseUrl?: string;
      provider: string;
    };
    const maxTokens = resolveAnthropicVertexMaxTokens({
      modelMaxTokens: transportModel.maxTokens,
      requestedMaxTokens: options?.maxTokens,
    });
    const contractModelId = resolveClaudeModelIdentity(model);
    const fable5 = isClaudeFable5Model(contractModelId);
    const mandatoryAdaptiveThinking = fable5 || isClaudeMythos5Model(contractModelId);
    const reasoning =
      (options?.reasoning as ModelThinkingLevel | undefined) ??
      (mandatoryAdaptiveThinking ? "high" : undefined);
    const adaptiveThinking =
      mandatoryAdaptiveThinking || Boolean(reasoning && supportsAdaptiveThinking(contractModelId));
    const temperature =
      adaptiveThinking ||
      isClaudeOpus47OrNewerModel(contractModelId) ||
      isClaudeMythos5Model(contractModelId)
        ? undefined
        : options?.temperature;
    const opts: AnthropicVertexTransportOptions = {
      client,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      signal: options?.signal,
      cacheRetention: options?.cacheRetention,
      sessionId: options?.sessionId,
      headers: options?.headers,
      // The shared anthropic-messages transport already splits the system prompt
      // cache boundary and budgets all cache_control markers; re-applying the
      // payload policy here marked the uncached suffix and breached the 4-marker cap.
      onPayload: options?.onPayload,
      maxRetryDelayMs: options?.maxRetryDelayMs,
      metadata: options?.metadata,
    };

    if (reasoning) {
      if (supportsAdaptiveThinking(contractModelId)) {
        opts.thinkingEnabled = true;
        opts.effort = mapAnthropicAdaptiveEffort(
          reasoning,
          transportModel,
          contractModelId,
        ) as AnthropicVertexEffort;
      } else {
        opts.thinkingEnabled = true;
        const budgets = options?.thinkingBudgets;
        opts.thinkingBudgetTokens =
          (budgets && reasoning in budgets
            ? budgets[reasoning as keyof typeof budgets]
            : undefined) ?? 10000;
      }
    } else if (fable5) {
      opts.thinkingEnabled = true;
      opts.effort = "high";
    } else {
      opts.thinkingEnabled = false;
    }

    return deps.streamAnthropic(transportModel, context, opts);
  };
}

function resolveAnthropicVertexSdkBaseUrl(baseUrl?: string): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (!normalizedPath || normalizedPath === "") {
      url.pathname = "/v1";
      return url.toString().replace(/\/$/, "");
    }
    if (!normalizedPath.endsWith("/v1")) {
      url.pathname = `${normalizedPath}/v1`;
      return url.toString().replace(/\/$/, "");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

/** Create an Anthropic Vertex stream function from model metadata and env. */
export function createAnthropicVertexStreamFnForModel(
  model: { baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
  deps?: AnthropicVertexStreamDeps,
): StreamFn {
  return createAnthropicVertexStreamFn(
    resolveAnthropicVertexProjectId(env),
    resolveAnthropicVertexClientRegion({
      baseUrl: model.baseUrl,
      env,
    }),
    resolveAnthropicVertexSdkBaseUrl(model.baseUrl),
    deps,
  );
}
