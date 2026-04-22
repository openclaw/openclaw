import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamAnthropic, type AnthropicOptions, type Model } from "@mariozechner/pi-ai";
import {
  resolveAnthropicVertexClientRegion,
  resolveAnthropicVertexProjectId,
} from "../plugin-sdk/anthropic-vertex.js";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "./anthropic-payload-policy.js";

type AnthropicVertexEffort = NonNullable<AnthropicOptions["effort"]>;

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

function createAnthropicVertexOnPayload(params: {
  model: { api: string; baseUrl?: string; provider: string };
  cacheRetention: AnthropicOptions["cacheRetention"] | undefined;
  onPayload: AnthropicOptions["onPayload"] | undefined;
}): NonNullable<AnthropicOptions["onPayload"]> {
  const policy = resolveAnthropicPayloadPolicy({
    provider: params.model.provider,
    api: params.model.api,
    baseUrl: params.model.baseUrl,
    cacheRetention: params.cacheRetention,
    enableCacheControl: true,
  });

  function applyPolicy(payload: unknown): unknown {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      applyAnthropicPayloadPolicyToParams(payload as Record<string, unknown>, policy);
    }
    return payload;
  }

  return async (payload, model) => {
    const shapedPayload = applyPolicy(payload);
    const nextPayload = await params.onPayload?.(shapedPayload, model);
    if (nextPayload === undefined || nextPayload === shapedPayload) {
      return shapedPayload;
    }
    return applyPolicy(nextPayload);
  };
}

/**
 * Create a StreamFn that routes through pi-ai's `streamAnthropic` with an
 * injected `AnthropicVertex` client.  All streaming, message conversion, and
 * event handling is handled by pi-ai — we only supply the GCP-authenticated
 * client and map SimpleStreamOptions → AnthropicOptions.
 */
export function createAnthropicVertexStreamFn(
  projectId: string | undefined,
  region: string,
  baseURL?: string,
): StreamFn {
  const client = new AnthropicVertex({
    region,
    ...(baseURL ? { baseURL } : {}),
    ...(projectId ? { projectId } : {}),
  });

  return (model, context, options) => {
    const transportModel = model as Model<"anthropic-messages"> & {
      api: string;
      baseUrl?: string;
      provider: string;
    };
    const maxTokens = resolveAnthropicVertexMaxTokens({
      modelMaxTokens: transportModel.maxTokens,
      requestedMaxTokens: options?.maxTokens,
    });
    // Strip user_id from metadata for Vertex AI — it validates and rejects user_ids that
    // look like email addresses (contain "@"), even when the user_id is a valid non-email string.
    const metadata = options?.metadata
      ? (Object.fromEntries(
          Object.entries(options.metadata).filter(([k]) => k !== "user_id"),
        ) as Record<string, string>)
      : undefined;

    const opts: AnthropicOptions = {
      client: client as unknown as AnthropicOptions["client"],
      temperature: options?.temperature,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      signal: options?.signal,
      cacheRetention: options?.cacheRetention,
      sessionId: options?.sessionId,
      headers: options?.headers,
      onPayload: createAnthropicVertexOnPayload({
        model: transportModel,
        cacheRetention: options?.cacheRetention,
        onPayload: options?.onPayload,
      }),
      maxRetryDelayMs: options?.maxRetryDelayMs,
      metadata,
    };

    if (options?.reasoning) {
      const isAdaptive =
        model.id.includes("opus-4-6") ||
        model.id.includes("opus-4.6") ||
        model.id.includes("sonnet-4-6") ||
        model.id.includes("sonnet-4.6");

      if (isAdaptive) {
        opts.thinkingEnabled = true;
        const effortMap: Record<string, AnthropicVertexEffort> = {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: model.id.includes("opus-4-6") || model.id.includes("opus-4.6") ? "max" : "high",
        };
        opts.effort = effortMap[options.reasoning] ?? "high";
      } else {
        opts.thinkingEnabled = true;
        const budgets = options.thinkingBudgets;
        opts.thinkingBudgetTokens =
          (budgets && options.reasoning in budgets
            ? budgets[options.reasoning as keyof typeof budgets]
            : undefined) ?? 10000;
      }
    } else {
      opts.thinkingEnabled = false;
    }

    return streamAnthropic(transportModel, context, opts);
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

export function createAnthropicVertexStreamFnForModel(
  model: { baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): StreamFn {
  return createAnthropicVertexStreamFn(
    resolveAnthropicVertexProjectId(env),
    resolveAnthropicVertexClientRegion({
      baseUrl: model.baseUrl,
      env,
    }),
    resolveAnthropicVertexSdkBaseUrl(model.baseUrl),
  );
}
