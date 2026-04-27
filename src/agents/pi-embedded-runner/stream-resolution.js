import { streamSimple } from "@mariozechner/pi-ai";
import { createAnthropicVertexStreamFnForModel } from "../anthropic-vertex-stream.js";
import { createOpenAIWebSocketStreamFn } from "../openai-ws-stream.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import { createBoundaryAwareStreamFnForModel } from "../provider-transport-stream.js";
import { stripSystemPromptCacheBoundary } from "../system-prompt-cache-boundary.js";
let embeddedAgentBaseStreamFnCache = new WeakMap();
export function resolveEmbeddedAgentBaseStreamFn(params) {
    const cached = embeddedAgentBaseStreamFnCache.get(params.session);
    if (cached !== undefined || embeddedAgentBaseStreamFnCache.has(params.session)) {
        return cached;
    }
    const baseStreamFn = params.session.agent.streamFn;
    embeddedAgentBaseStreamFnCache.set(params.session, baseStreamFn);
    return baseStreamFn;
}
export function resetEmbeddedAgentBaseStreamFnCacheForTest() {
    embeddedAgentBaseStreamFnCache = new WeakMap();
}
export function describeEmbeddedAgentStreamStrategy(params) {
    if (params.providerStreamFn) {
        return "provider";
    }
    if (params.shouldUseWebSocketTransport) {
        return params.wsApiKey ? "openai-websocket" : "session-http-fallback";
    }
    if (params.model.provider === "anthropic-vertex") {
        return "anthropic-vertex";
    }
    if (params.currentStreamFn === undefined || params.currentStreamFn === streamSimple) {
        return createBoundaryAwareStreamFnForModel(params.model)
            ? `boundary-aware:${params.model.api}`
            : "stream-simple";
    }
    return "session-custom";
}
export async function resolveEmbeddedAgentApiKey(params) {
    const resolvedApiKey = params.resolvedApiKey?.trim();
    if (resolvedApiKey) {
        return resolvedApiKey;
    }
    return params.authStorage ? await params.authStorage.getApiKey(params.provider) : undefined;
}
export function resolveEmbeddedAgentStreamFn(params) {
    if (params.providerStreamFn) {
        const inner = params.providerStreamFn;
        const normalizeContext = (context) => context.systemPrompt
            ? {
                ...context,
                systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
            }
            : context;
        const mergeRunSignal = (options) => {
            const signal = options?.signal ?? params.signal;
            return signal ? { ...options, signal } : options;
        };
        // Provider-owned transports bypass pi-coding-agent's default auth lookup,
        // so keep injecting the resolved runtime apiKey for streamSimple-compatible
        // transports that still read credentials from options.apiKey.
        if (params.authStorage || params.resolvedApiKey) {
            const { authStorage, model, resolvedApiKey } = params;
            return async (m, context, options) => {
                const apiKey = await resolveEmbeddedAgentApiKey({
                    provider: model.provider,
                    resolvedApiKey,
                    authStorage,
                });
                return inner(m, normalizeContext(context), {
                    ...mergeRunSignal(options),
                    apiKey: apiKey ?? options?.apiKey,
                });
            };
        }
        return (m, context, options) => inner(m, normalizeContext(context), mergeRunSignal(options));
    }
    const currentStreamFn = params.currentStreamFn ?? streamSimple;
    if (params.shouldUseWebSocketTransport) {
        return params.wsApiKey
            ? createOpenAIWebSocketStreamFn(params.wsApiKey, params.sessionId, {
                signal: params.signal,
                managerOptions: {
                    request: getModelProviderRequestTransport(params.model),
                },
            })
            : currentStreamFn;
    }
    if (params.model.provider === "anthropic-vertex") {
        return createAnthropicVertexStreamFnForModel(params.model);
    }
    if (params.currentStreamFn === undefined || params.currentStreamFn === streamSimple) {
        const boundaryAwareStreamFn = createBoundaryAwareStreamFnForModel(params.model);
        if (boundaryAwareStreamFn) {
            return boundaryAwareStreamFn;
        }
    }
    return currentStreamFn;
}
