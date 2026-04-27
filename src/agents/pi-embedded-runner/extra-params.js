import { streamSimple } from "@mariozechner/pi-ai";
import { prepareProviderExtraParams as prepareProviderExtraParamsRuntime, resolveProviderExtraParamsForTransport as resolveProviderExtraParamsForTransportRuntime, wrapProviderStreamFn as wrapProviderStreamFnRuntime, } from "../../plugins/provider-hook-runtime.js";
import { supportsGptParallelToolCallsPayload } from "../provider-api-families.js";
import { resolveProviderRequestPolicyConfig } from "../provider-request-config.js";
import { createGoogleThinkingPayloadWrapper } from "./google-stream-wrappers.js";
import { log } from "./logger.js";
import { createMinimaxThinkingDisabledWrapper } from "./minimax-stream-wrappers.js";
import { createSiliconFlowThinkingWrapper, shouldApplySiliconFlowThinkingOffCompat, } from "./moonshot-stream-wrappers.js";
import { createOpenAIResponsesContextManagementWrapper, createOpenAIStringContentWrapper, } from "./openai-stream-wrappers.js";
import { resolveCacheRetention } from "./prompt-cache-retention.js";
import { createOpenRouterSystemCacheWrapper } from "./proxy-stream-wrappers.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";
const defaultProviderRuntimeDeps = {
    prepareProviderExtraParams: prepareProviderExtraParamsRuntime,
    resolveProviderExtraParamsForTransport: resolveProviderExtraParamsForTransportRuntime,
    wrapProviderStreamFn: wrapProviderStreamFnRuntime,
};
const providerRuntimeDeps = {
    ...defaultProviderRuntimeDeps,
};
export const __testing = {
    setProviderRuntimeDepsForTest(deps) {
        providerRuntimeDeps.prepareProviderExtraParams =
            deps?.prepareProviderExtraParams ?? defaultProviderRuntimeDeps.prepareProviderExtraParams;
        providerRuntimeDeps.resolveProviderExtraParamsForTransport =
            deps?.resolveProviderExtraParamsForTransport ??
                defaultProviderRuntimeDeps.resolveProviderExtraParamsForTransport;
        providerRuntimeDeps.wrapProviderStreamFn =
            deps?.wrapProviderStreamFn ?? defaultProviderRuntimeDeps.wrapProviderStreamFn;
    },
    resetProviderRuntimeDepsForTest() {
        providerRuntimeDeps.prepareProviderExtraParams =
            defaultProviderRuntimeDeps.prepareProviderExtraParams;
        providerRuntimeDeps.resolveProviderExtraParamsForTransport =
            defaultProviderRuntimeDeps.resolveProviderExtraParamsForTransport;
        providerRuntimeDeps.wrapProviderStreamFn = defaultProviderRuntimeDeps.wrapProviderStreamFn;
    },
};
/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export function resolveExtraParams(params) {
    const defaultParams = params.cfg?.agents?.defaults?.params ?? undefined;
    const modelKey = `${params.provider}/${params.modelId}`;
    const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
    const globalParams = modelConfig?.params ? { ...modelConfig.params } : undefined;
    const agentParams = params.agentId && params.cfg?.agents?.list
        ? params.cfg.agents.list.find((agent) => agent.id === params.agentId)?.params
        : undefined;
    const merged = Object.assign({}, defaultParams, globalParams, agentParams);
    const resolvedParallelToolCalls = resolveAliasedParamValue([defaultParams, globalParams, agentParams], "parallel_tool_calls", "parallelToolCalls");
    if (resolvedParallelToolCalls !== undefined) {
        merged.parallel_tool_calls = resolvedParallelToolCalls;
        delete merged.parallelToolCalls;
    }
    const resolvedTextVerbosity = resolveAliasedParamValue([globalParams, agentParams], "text_verbosity", "textVerbosity");
    if (resolvedTextVerbosity !== undefined) {
        merged.text_verbosity = resolvedTextVerbosity;
        delete merged.textVerbosity;
    }
    const resolvedCachedContent = resolveAliasedParamValue([defaultParams, globalParams, agentParams], "cached_content", "cachedContent");
    if (resolvedCachedContent !== undefined) {
        merged.cachedContent = resolvedCachedContent;
        delete merged.cached_content;
    }
    applyDefaultOpenAIGptRuntimeParams(params, merged);
    return Object.keys(merged).length > 0 ? merged : undefined;
}
function resolveSupportedTransport(value) {
    return value === "sse" || value === "websocket" || value === "auto" ? value : undefined;
}
function hasExplicitTransportSetting(settings) {
    return Object.hasOwn(settings, "transport");
}
export function resolvePreparedExtraParams(params) {
    const resolvedExtraParams = params.resolvedExtraParams ??
        resolveExtraParams({
            cfg: params.cfg,
            provider: params.provider,
            modelId: params.modelId,
            agentId: params.agentId,
        });
    const override = params.extraParamsOverride && Object.keys(params.extraParamsOverride).length > 0
        ? sanitizeExtraParamsRecord(Object.fromEntries(Object.entries(params.extraParamsOverride).filter(([, value]) => value !== undefined)))
        : undefined;
    const merged = {
        ...sanitizeExtraParamsRecord(resolvedExtraParams),
        ...override,
    };
    const resolvedCachedContent = resolveAliasedParamValue([resolvedExtraParams, override], "cached_content", "cachedContent");
    if (resolvedCachedContent !== undefined) {
        merged.cachedContent = resolvedCachedContent;
        delete merged.cached_content;
    }
    const prepared = providerRuntimeDeps.prepareProviderExtraParams({
        provider: params.provider,
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        context: {
            config: params.cfg,
            agentDir: params.agentDir,
            workspaceDir: params.workspaceDir,
            provider: params.provider,
            modelId: params.modelId,
            extraParams: merged,
            thinkingLevel: params.thinkingLevel,
        },
    }) ?? merged;
    const transportPatch = providerRuntimeDeps.resolveProviderExtraParamsForTransport({
        provider: params.provider,
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        context: {
            config: params.cfg,
            agentDir: params.agentDir,
            workspaceDir: params.workspaceDir,
            provider: params.provider,
            modelId: params.modelId,
            extraParams: prepared,
            thinkingLevel: params.thinkingLevel,
            model: params.model,
            transport: params.resolvedTransport ?? resolveSupportedTransport(prepared.transport),
        },
    })?.patch;
    return transportPatch ? { ...prepared, ...transportPatch } : prepared;
}
function sanitizeExtraParamsRecord(value) {
    if (!value) {
        return undefined;
    }
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "__proto__" && key !== "prototype" && key !== "constructor"));
}
function shouldApplyDefaultOpenAIGptRuntimeParams(params) {
    if (params.provider !== "openai" && params.provider !== "openai-codex") {
        return false;
    }
    return /^gpt-5(?:[.-]|$)/i.test(params.modelId);
}
function applyDefaultOpenAIGptRuntimeParams(params, merged) {
    if (!shouldApplyDefaultOpenAIGptRuntimeParams(params)) {
        return;
    }
    if (!Object.hasOwn(merged, "parallel_tool_calls") &&
        !Object.hasOwn(merged, "parallelToolCalls")) {
        merged.parallel_tool_calls = true;
    }
    if (!Object.hasOwn(merged, "text_verbosity") && !Object.hasOwn(merged, "textVerbosity")) {
        merged.text_verbosity = "low";
    }
    if (!Object.hasOwn(merged, "openaiWsWarmup")) {
        merged.openaiWsWarmup = false;
    }
}
export function resolveAgentTransportOverride(params) {
    const globalSettings = params.settingsManager.getGlobalSettings();
    const projectSettings = params.settingsManager.getProjectSettings();
    if (hasExplicitTransportSetting(globalSettings) || hasExplicitTransportSetting(projectSettings)) {
        return undefined;
    }
    return resolveSupportedTransport(params.effectiveExtraParams?.transport);
}
export function resolveExplicitSettingsTransport(params) {
    const globalSettings = params.settingsManager.getGlobalSettings();
    const projectSettings = params.settingsManager.getProjectSettings();
    if (!hasExplicitTransportSetting(globalSettings) &&
        !hasExplicitTransportSetting(projectSettings)) {
        return undefined;
    }
    return resolveSupportedTransport(params.sessionTransport);
}
function createStreamFnWithExtraParams(baseStreamFn, extraParams, provider, model) {
    if (!extraParams || Object.keys(extraParams).length === 0) {
        return undefined;
    }
    const streamParams = {};
    if (typeof extraParams.temperature === "number") {
        streamParams.temperature = extraParams.temperature;
    }
    if (typeof extraParams.maxTokens === "number") {
        streamParams.maxTokens = extraParams.maxTokens;
    }
    const transport = resolveSupportedTransport(extraParams.transport);
    if (transport) {
        streamParams.transport = transport;
    }
    else if (extraParams.transport != null) {
        const transportSummary = typeof extraParams.transport === "string"
            ? extraParams.transport
            : typeof extraParams.transport;
        log.warn(`ignoring invalid transport param: ${transportSummary}`);
    }
    if (typeof extraParams.openaiWsWarmup === "boolean") {
        streamParams.openaiWsWarmup = extraParams.openaiWsWarmup;
    }
    const cachedContent = typeof extraParams.cachedContent === "string"
        ? extraParams.cachedContent
        : typeof extraParams.cached_content === "string"
            ? extraParams.cached_content
            : undefined;
    if (typeof cachedContent === "string" && cachedContent.trim()) {
        streamParams.cachedContent = cachedContent.trim();
    }
    const initialCacheRetention = resolveCacheRetention(extraParams, provider, typeof model?.api === "string" ? model.api : undefined, typeof model?.id === "string" ? model.id : undefined);
    if (Object.keys(streamParams).length > 0 || initialCacheRetention) {
        const debugParams = initialCacheRetention
            ? { ...streamParams, cacheRetention: initialCacheRetention }
            : streamParams;
        log.debug(`creating streamFn wrapper with params: ${JSON.stringify(debugParams)}`);
    }
    const underlying = baseStreamFn ?? streamSimple;
    const wrappedStreamFn = (callModel, context, options) => {
        const cacheRetention = resolveCacheRetention(extraParams, provider, typeof callModel.api === "string" ? callModel.api : undefined, typeof callModel.id === "string" ? callModel.id : undefined);
        if (Object.keys(streamParams).length === 0 && !cacheRetention) {
            return underlying(callModel, context, options);
        }
        return underlying(callModel, context, {
            ...streamParams,
            ...(cacheRetention ? { cacheRetention } : {}),
            ...options,
        });
    };
    return wrappedStreamFn;
}
function resolveAliasedParamValue(sources, snakeCaseKey, camelCaseKey) {
    let resolved = undefined;
    let seen = false;
    for (const source of sources) {
        if (!source) {
            continue;
        }
        const hasSnakeCaseKey = Object.hasOwn(source, snakeCaseKey);
        const hasCamelCaseKey = Object.hasOwn(source, camelCaseKey);
        if (!hasSnakeCaseKey && !hasCamelCaseKey) {
            continue;
        }
        resolved = hasSnakeCaseKey ? source[snakeCaseKey] : source[camelCaseKey];
        seen = true;
    }
    return seen ? resolved : undefined;
}
function createParallelToolCallsWrapper(baseStreamFn, enabled) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        if (!supportsGptParallelToolCallsPayload(model.api)) {
            return underlying(model, context, options);
        }
        log.debug(`applying parallel_tool_calls=${enabled} for ${model.provider ?? "unknown"}/${model.id ?? "unknown"} api=${model.api}`);
        return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
            payloadObj.parallel_tool_calls = enabled;
        });
    };
}
function shouldStripOpenAICompletionsStore(model) {
    if (model.api !== "openai-completions") {
        return false;
    }
    const compat = model.compat && typeof model.compat === "object"
        ? model.compat
        : undefined;
    const capabilities = resolveProviderRequestPolicyConfig({
        provider: typeof model.provider === "string" ? model.provider : undefined,
        api: model.api,
        baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
        compat,
        capability: "llm",
        transport: "stream",
    }).capabilities;
    return !capabilities.usesKnownNativeOpenAIRoute;
}
function createOpenAICompletionsStoreCompatWrapper(baseStreamFn) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        if (!shouldStripOpenAICompletionsStore(model)) {
            return underlying(model, context, options);
        }
        return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
            delete payloadObj.store;
        });
    };
}
function sanitizeExtraBodyRecord(value) {
    return Object.fromEntries(Object.entries(sanitizeExtraParamsRecord(value) ?? {}).filter(([, entry]) => entry !== undefined));
}
function resolveExtraBodyParam(rawExtraBody) {
    if (rawExtraBody === undefined || rawExtraBody === null) {
        return undefined;
    }
    if (typeof rawExtraBody !== "object" || Array.isArray(rawExtraBody)) {
        const summary = typeof rawExtraBody === "string" ? rawExtraBody : typeof rawExtraBody;
        log.warn(`ignoring invalid extra_body param: ${summary}`);
        return undefined;
    }
    const extraBody = sanitizeExtraBodyRecord(rawExtraBody);
    return Object.keys(extraBody).length > 0 ? extraBody : undefined;
}
function createOpenAICompletionsExtraBodyWrapper(baseStreamFn, extraBody) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        if (model.api !== "openai-completions") {
            return underlying(model, context, options);
        }
        return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
            const collisions = Object.keys(extraBody).filter((key) => Object.hasOwn(payloadObj, key));
            if (collisions.length > 0) {
                log.warn(`extra_body overwriting request payload keys: ${collisions.join(", ")}`);
            }
            Object.assign(payloadObj, extraBody);
        });
    };
}
function applyPrePluginStreamWrappers(ctx) {
    const wrappedStreamFn = createStreamFnWithExtraParams(ctx.agent.streamFn, ctx.effectiveExtraParams, ctx.provider, ctx.model);
    if (wrappedStreamFn) {
        log.debug(`applying extraParams to agent streamFn for ${ctx.provider}/${ctx.modelId}`);
        ctx.agent.streamFn = wrappedStreamFn;
    }
    if (shouldApplySiliconFlowThinkingOffCompat({
        provider: ctx.provider,
        modelId: ctx.modelId,
        thinkingLevel: ctx.thinkingLevel,
    })) {
        log.debug(`normalizing thinking=off to thinking=null for SiliconFlow compatibility (${ctx.provider}/${ctx.modelId})`);
        ctx.agent.streamFn = createSiliconFlowThinkingWrapper(ctx.agent.streamFn);
    }
}
function applyPostPluginStreamWrappers(ctx) {
    ctx.agent.streamFn = createOpenRouterSystemCacheWrapper(ctx.agent.streamFn);
    ctx.agent.streamFn = createOpenAIStringContentWrapper(ctx.agent.streamFn);
    if (!ctx.providerWrapperHandled) {
        // Guard Google-family payloads against invalid negative thinking budgets
        // emitted by upstream model-ID heuristics for Gemini 3.1 variants.
        ctx.agent.streamFn = createGoogleThinkingPayloadWrapper(ctx.agent.streamFn, ctx.thinkingLevel);
        // Work around upstream pi-ai hardcoding `store: false` for Responses API.
        // Force `store=true` for direct OpenAI Responses models and auto-enable
        // server-side compaction for compatible Responses payloads.
        ctx.agent.streamFn = createOpenAIResponsesContextManagementWrapper(ctx.agent.streamFn, ctx.effectiveExtraParams);
    }
    // MiniMax's Anthropic-compatible stream can leak reasoning_content into the
    // visible reply path because it does not emit native Anthropic thinking
    // blocks. Disable thinking unless an earlier wrapper already set it.
    ctx.agent.streamFn = createMinimaxThinkingDisabledWrapper(ctx.agent.streamFn);
    const rawExtraBody = resolveAliasedParamValue([ctx.effectiveExtraParams, ctx.override], "extra_body", "extraBody");
    const extraBody = resolveExtraBodyParam(rawExtraBody);
    if (extraBody) {
        ctx.agent.streamFn = createOpenAICompletionsExtraBodyWrapper(ctx.agent.streamFn, extraBody);
    }
    ctx.agent.streamFn = createOpenAICompletionsStoreCompatWrapper(ctx.agent.streamFn);
    const rawParallelToolCalls = resolveAliasedParamValue([ctx.effectiveExtraParams, ctx.override], "parallel_tool_calls", "parallelToolCalls");
    if (rawParallelToolCalls === undefined) {
        return;
    }
    if (typeof rawParallelToolCalls === "boolean") {
        ctx.agent.streamFn = createParallelToolCallsWrapper(ctx.agent.streamFn, rawParallelToolCalls);
        return;
    }
    if (rawParallelToolCalls === null) {
        log.debug("parallel_tool_calls suppressed by null override, skipping injection");
        return;
    }
    const summary = typeof rawParallelToolCalls === "string" ? rawParallelToolCalls : typeof rawParallelToolCalls;
    log.warn(`ignoring invalid parallel_tool_calls param: ${summary}`);
}
/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also applies verified provider-specific request wrappers, such as OpenRouter attribution.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(agent, cfg, provider, modelId, extraParamsOverride, thinkingLevel, agentId, workspaceDir, model, agentDir, resolvedTransport, options) {
    const resolvedExtraParams = resolveExtraParams({
        cfg,
        provider,
        modelId,
        agentId,
    });
    const override = extraParamsOverride && Object.keys(extraParamsOverride).length > 0
        ? Object.fromEntries(Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined))
        : undefined;
    const effectiveExtraParams = options?.preparedExtraParams ??
        resolvePreparedExtraParams({
            cfg,
            provider,
            modelId,
            extraParamsOverride,
            thinkingLevel,
            agentId,
            agentDir,
            workspaceDir,
            resolvedExtraParams,
            model,
            resolvedTransport,
        });
    const wrapperContext = {
        agent,
        cfg,
        provider,
        modelId,
        agentDir,
        workspaceDir,
        thinkingLevel,
        model,
        effectiveExtraParams,
        resolvedExtraParams,
        override,
    };
    const providerStreamBase = agent.streamFn;
    const pluginWrappedStreamFn = providerRuntimeDeps.wrapProviderStreamFn({
        provider,
        config: cfg,
        context: {
            config: cfg,
            provider,
            modelId,
            extraParams: effectiveExtraParams,
            thinkingLevel,
            model,
            streamFn: providerStreamBase,
        },
    });
    agent.streamFn = pluginWrappedStreamFn ?? providerStreamBase;
    // Apply caller/config extra params outside provider defaults so explicit values
    // like `openaiWsWarmup=false` can override provider-added defaults.
    applyPrePluginStreamWrappers(wrapperContext);
    const providerWrapperHandled = pluginWrappedStreamFn !== undefined && pluginWrappedStreamFn !== providerStreamBase;
    applyPostPluginStreamWrappers({
        ...wrapperContext,
        providerWrapperHandled,
    });
    return { effectiveExtraParams };
}
