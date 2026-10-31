import { randomUUID } from "node:crypto";
import type { Api, Model, ModelRequestHeaders, StreamFn, StreamOptions } from "@openclaw/llm-core";
import type { ApiRegistry } from "../api-registry.js";
import {
  getAiTransportHost,
  resolveAiTransportHeaderSentinels,
  type AiProviderStreamHookContext,
} from "../host.js";
import {
  buildTransportAwareSimpleStreamFn,
  createOpenClawTransportStreamFnForModel,
  createTransportAwareStreamFnForModel,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";
import { resolveOpencodeSessionHeaders } from "./session-affinity.js";

/** Standalone completions have no durable session, but may require routing identity. */
export function prepareHeadersForSimpleCompletion(
  model: Pick<Model, "baseUrl" | "headers">,
  options?: Pick<StreamOptions, "sessionId" | "headers">,
): ModelRequestHeaders | undefined {
  // Keep the synthetic identity in the required header only: a stream sessionId
  // would also enable unrelated cache and WebSocket session ownership.
  return resolveOpencodeSessionHeaders(model, {
    ...options,
    sessionId: options?.sessionId || randomUUID(),
  });
}

const PROVIDER_SIMPLE_COMPLETION_API_PREFIX = "openclaw-provider-simple:";
const PROVIDER_STREAM_API_PREFIX = "openclaw-provider-stream:";
const INVALID_CODEX_BASE_URL_MESSAGE =
  "OpenAI Codex Responses baseUrl must not include query parameters or fragments";

function registerCustomApi(registry: ApiRegistry, api: Api, streamFn: StreamFn): boolean {
  getAiTransportHost().registerCustomApi(registry, api, streamFn);
  return registry.getApiProvider(api) !== undefined;
}

function projectModel(model: Model, patch: Partial<Model>): Model {
  return getAiTransportHost().inheritManagedTransport(model, { ...model, ...patch });
}

function resolveAnthropicVertexSimpleApi(baseUrl?: string): Api {
  const suffix = baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default";
  return `openclaw-anthropic-vertex-simple:${suffix}`;
}

export function normalizeCodexResponsesBaseUrlForOpenAISdk(baseUrl?: string): string {
  const normalized = baseUrl?.trim() || "https://chatgpt.com/backend-api";
  const parsed = URL.parse(normalized);
  const pathname = parsed?.pathname.replace(/\/+$/u, "") ?? "";
  const path = pathname.toLowerCase();
  if (
    parsed?.hostname.toLowerCase() === "chatgpt.com" &&
    [
      "/backend-api",
      "/backend-api/v1",
      "/backend-api/codex",
      "/backend-api/codex/v1",
      "/backend-api/codex/responses",
    ].includes(path)
  ) {
    parsed.pathname = "/backend-api/codex";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  }
  if (normalized.includes("?") || normalized.includes("#")) {
    throw new Error(INVALID_CODEX_BASE_URL_MESSAGE);
  }
  if (parsed) {
    parsed.pathname = path.endsWith("/codex/responses")
      ? pathname.slice(0, -"/responses".length)
      : path.endsWith("/codex")
        ? pathname
        : `${pathname}/codex`;
    return parsed.toString();
  }
  // Keep non-URL custom values on the same suffix contract transport callers accept.
  const customPath = normalized.replace(/\/+$/u, "");
  if (customPath.endsWith("/codex/responses")) {
    return customPath.slice(0, -"/responses".length);
  }
  return customPath.endsWith("/codex") ? customPath : `${customPath}/codex`;
}

function resolveProviderStreamApi(model: Model): Api {
  const parts = [model.provider, model.id, model.api, model.baseUrl || "default"];
  return `${PROVIDER_STREAM_API_PREFIX}${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

function resolveModelTransportSentinels<TApi extends Api>(
  model: Model<TApi>,
  boundary: string,
): Model<TApi> {
  const host = getAiTransportHost();
  if (host.unwrapModelTransportSentinels) {
    return host.unwrapModelTransportSentinels(model, boundary);
  }
  // Partial embedding hosts still own visible headers through the original port.
  const headers = resolveAiTransportHeaderSentinels(model.headers);
  return headers === model.headers ? model : (projectModel(model, { headers }) as Model<TApi>);
}

function wrapPluginProviderStream(streamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const host = getAiTransportHost();
    const apiKey = options?.apiKey ? host.resolveSecretSentinel(options.apiKey) : options?.apiKey;
    const headers = resolveAiTransportHeaderSentinels(options?.headers);
    return streamFn(
      resolveModelTransportSentinels(model, "plugin simple-completion stream egress"),
      context,
      apiKey === options?.apiKey && headers === options?.headers
        ? options
        : { ...options, apiKey, headers },
    );
  };
}

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  apiRegistry: ApiRegistry;
  model: Model<TApi>;
  cfg?: unknown;
  auth?: AiProviderStreamHookContext["auth"];
  agentId?: string;
}): Model {
  const { apiRegistry, model, cfg, auth, agentId } = params;
  const wrap = (prepared: Model): Model => {
    const hookSourceApi = model.api;
    if (prepared.api.startsWith(PROVIDER_SIMPLE_COMPLETION_API_PREFIX)) {
      return prepared;
    }
    const sourceProvider = apiRegistry.getApiProvider(prepared.api);
    if (!sourceProvider) {
      return prepared;
    }

    const dispatchApi = prepared.api;
    const sourceStreamFn: StreamFn = (runtimeModel, context, options) =>
      sourceProvider.streamSimple(
        projectModel(runtimeModel, { api: dispatchApi }),
        context,
        options,
      );
    const streamFn = getAiTransportHost().plugin.wrapSimpleCompletionStream({
      provider: prepared.provider,
      config: cfg,
      context: {
        config: cfg,
        provider: prepared.provider,
        modelId: prepared.id,
        model: prepared,
        sourceApi: hookSourceApi,
        auth,
        agentId,
        streamFn: sourceStreamFn,
      },
    });
    if (!streamFn) {
      return prepared;
    }

    // The registered simple-completion alias is only a dispatch key. Keep the
    // original wire API visible while the wrapped stream applies request-body
    // policy; the source stream projects back to dispatchApi before calling the
    // provider, so provider routing still uses its registered alias.
    const registeredStreamFn: StreamFn = (runtimeModel, context, options) =>
      streamFn(projectModel(runtimeModel, { api: hookSourceApi }), context, options);
    const parts = [prepared.provider, prepared.id, prepared.api, prepared.baseUrl || "default"];
    // Registered wrappers retain their preparation context. A credential switch
    // must select its own policy instead of reusing another grant's wrapper.
    if (auth) {
      parts.push(auth.mode, auth.authFlow ?? "");
    }
    if (agentId) {
      parts.push("agent", agentId);
    }
    const api = `${PROVIDER_SIMPLE_COMPLETION_API_PREFIX}${parts
      .map((part) => encodeURIComponent(part))
      .join(":")}`;
    return registerCustomApi(apiRegistry, api, registeredStreamFn)
      ? projectModel(prepared, { api })
      : prepared;
  };

  const pluginModel = resolveModelTransportSentinels(
    model,
    "plugin simple-completion stream construction",
  );
  const providerStreamFn = getAiTransportHost().plugin.resolveProviderStream({
    provider: model.provider,
    config: cfg,
    context: {
      config: cfg,
      provider: model.provider,
      modelId: model.id,
      model: pluginModel,
    },
  });
  const transportFallback = providerStreamFn
    ? undefined
    : createTransportAwareStreamFnForModel(
        model.api === "google-generative-ai" ? pluginModel : model,
        { cfg },
      );
  const streamFn = providerStreamFn
    ? wrapPluginProviderStream(providerStreamFn)
    : transportFallback && model.api === "google-generative-ai"
      ? wrapPluginProviderStream(transportFallback)
      : transportFallback;
  if (streamFn) {
    // A plugin can own one model while reusing a built-in wire-format id. Keep
    // that stream on a model-specific alias instead of replacing the shared API.
    const api = apiRegistry.getApiProvider(model.api) ? resolveProviderStreamApi(model) : model.api;
    // The alias selects this stream; wire policy still needs the original API.
    const sourceApi = model.api;
    const sourceStreamFn: StreamFn = (runtimeModel, context, options) =>
      streamFn(projectModel(runtimeModel, { api: sourceApi }), context, options);
    if (registerCustomApi(apiRegistry, api, sourceStreamFn)) {
      return wrap(api === model.api ? model : projectModel(model, { api }));
    }
  }

  if (model.provider === "openai" && model.api === "openai-chatgpt-responses") {
    // Static Codex provider catalogs intentionally omit credentials; the simple
    // completion path must use OpenClaw's transport so resolved request auth is applied.
    const transportModel = projectModel(model, {
      baseUrl: normalizeCodexResponsesBaseUrlForOpenAISdk(model.baseUrl),
    });
    const api = resolveTransportAwareSimpleApi(model.api);
    const codexStreamFn = createOpenClawTransportStreamFnForModel(transportModel, { cfg });
    if (api && codexStreamFn && registerCustomApi(apiRegistry, api, codexStreamFn)) {
      return wrap(projectModel(transportModel, { api }));
    }
  }

  const transportAwareModel = prepareTransportAwareSimpleModel(model, { cfg });
  if (transportAwareModel !== model) {
    const transportStreamFn = buildTransportAwareSimpleStreamFn(model, { cfg });
    if (
      transportStreamFn &&
      registerCustomApi(apiRegistry, transportAwareModel.api, transportStreamFn)
    ) {
      return wrap(transportAwareModel);
    }
  }

  if (model.provider === "anthropic-vertex") {
    const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
    const host = getAiTransportHost();
    const vertexStreamFn = host.plugin.createAnthropicVertexStream(model);
    if (registerCustomApi(apiRegistry, api, vertexStreamFn)) {
      return wrap(projectModel(model, { api }));
    }
  }

  return wrap(model);
}
