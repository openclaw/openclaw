import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { LMSTUDIO_PROVIDER_ID } from "./defaults.js";
import { ensureLmstudioModelLoaded, resolveLmstudioInferenceBase } from "./models.js";
import { resolveLmstudioProviderHeaders, resolveLmstudioRuntimeApiKey } from "./runtime.js";

const log = createSubsystemLogger("extensions/lmstudio/stream");

type StreamOptions = Parameters<StreamFn>[2];
type StreamModel = Parameters<StreamFn>[0];

const preloadInFlight = new Map<string, Promise<void>>();

function normalizeLmstudioModelKey(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.toLowerCase().startsWith("lmstudio/")) {
    return trimmed.slice("lmstudio/".length).trim();
  }
  return trimmed;
}

function resolveRequestedContextLength(model: StreamModel): number | undefined {
  const contextWindow =
    typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
      ? Math.floor(model.contextWindow)
      : undefined;
  if (contextWindow && contextWindow > 0) {
    return contextWindow;
  }
  const maxTokens =
    typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens)
      ? Math.floor(model.maxTokens)
      : undefined;
  if (maxTokens && maxTokens > 0) {
    return maxTokens;
  }
  return undefined;
}

function resolveModelHeaders(model: StreamModel): Record<string, string> | undefined {
  if (!model.headers || typeof model.headers !== "object" || Array.isArray(model.headers)) {
    return undefined;
  }
  return model.headers;
}

function createPreloadKey(params: {
  baseUrl: string;
  modelKey: string;
  requestedContextLength?: number;
}) {
  return `${params.baseUrl}::${params.modelKey}::${params.requestedContextLength ?? "default"}`;
}

async function ensureLmstudioModelLoadedBestEffort(params: {
  baseUrl: string;
  modelKey: string;
  requestedContextLength?: number;
  options: StreamOptions;
  ctx: ProviderWrapStreamFnContext;
  modelHeaders?: Record<string, string>;
}): Promise<void> {
  const providerConfig = params.ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID];
  const headersInput: Record<string, unknown> = {
    ...providerConfig?.headers,
    ...params.modelHeaders,
  };
  const headers = await resolveLmstudioProviderHeaders({
    config: params.ctx.config,
    headers: headersInput,
  });
  const runtimeApiKey =
    typeof params.options?.apiKey === "string" && params.options.apiKey.trim().length > 0
      ? params.options.apiKey
      : await resolveLmstudioRuntimeApiKey({
          config: params.ctx.config,
          agentDir: params.ctx.agentDir,
          allowMissingAuth: true,
        });

  await ensureLmstudioModelLoaded({
    baseUrl: params.baseUrl,
    apiKey: runtimeApiKey,
    headers,
    modelKey: params.modelKey,
    requestedContextLength: params.requestedContextLength,
  });
}

export function wrapLmstudioInferencePreload(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== LMSTUDIO_PROVIDER_ID) {
      return underlying(model, context, options);
    }
    const modelKey = normalizeLmstudioModelKey(model.id);
    if (!modelKey) {
      return underlying(model, context, options);
    }
    const providerBaseUrl = ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID]?.baseUrl;
    const resolvedBaseUrl = resolveLmstudioInferenceBase(
      typeof model.baseUrl === "string" ? model.baseUrl : providerBaseUrl,
    );
    const requestedContextLength = resolveRequestedContextLength(model);
    const preloadKey = createPreloadKey({
      baseUrl: resolvedBaseUrl,
      modelKey,
      requestedContextLength,
    });
    const existing = preloadInFlight.get(preloadKey);
    const preloadPromise =
      existing ??
      ensureLmstudioModelLoadedBestEffort({
        baseUrl: resolvedBaseUrl,
        modelKey,
        requestedContextLength,
        options,
        ctx,
        modelHeaders: resolveModelHeaders(model),
      }).finally(() => {
        preloadInFlight.delete(preloadKey);
      });
    if (!existing) {
      preloadInFlight.set(preloadKey, preloadPromise);
    }

    return (async () => {
      try {
        await preloadPromise;
      } catch (error) {
        log.warn(
          `LM Studio inference preload failed for "${modelKey}"; continuing without preload: ${String(error)}`,
        );
      }
      const stream = underlying(model, context, options);
      return stream instanceof Promise ? await stream : stream;
    })();
  };
}
