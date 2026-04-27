import { CONTEXT_WINDOW_HARD_MIN_TOKENS, CONTEXT_WINDOW_WARN_BELOW_TOKENS, evaluateContextWindowGuard, formatContextWindowBlockMessage, formatContextWindowWarningMessage, resolveContextWindowInfo, } from "../../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { FailoverError } from "../../failover-error.js";
import { log } from "../logger.js";
import { readPiModelContextTokens } from "../model-context-tokens.js";
export async function resolveHookModelSelection(params) {
    let provider = params.provider;
    let modelId = params.modelId;
    let modelResolveOverride;
    let legacyBeforeAgentStartResult;
    const hookRunner = params.hookRunner;
    // Run before_model_resolve hooks early so plugins can override the
    // provider/model before resolveModel().
    //
    // Legacy compatibility: before_agent_start is also checked for override
    // fields if present. New hook takes precedence when both are set.
    if (hookRunner?.hasHooks("before_model_resolve")) {
        try {
            const event = params.attachments
                ? { prompt: params.prompt, attachments: params.attachments }
                : { prompt: params.prompt };
            modelResolveOverride = await hookRunner.runBeforeModelResolve(event, params.hookContext);
        }
        catch (hookErr) {
            log.warn(`before_model_resolve hook failed: ${String(hookErr)}`);
        }
    }
    if (hookRunner?.hasHooks("before_agent_start")) {
        try {
            legacyBeforeAgentStartResult = await hookRunner.runBeforeAgentStart({ prompt: params.prompt }, params.hookContext);
            modelResolveOverride = {
                providerOverride: modelResolveOverride?.providerOverride ?? legacyBeforeAgentStartResult?.providerOverride,
                modelOverride: modelResolveOverride?.modelOverride ?? legacyBeforeAgentStartResult?.modelOverride,
            };
        }
        catch (hookErr) {
            log.warn(`before_agent_start hook (legacy model resolve path) failed: ${String(hookErr)}`);
        }
    }
    if (modelResolveOverride?.providerOverride) {
        provider = modelResolveOverride.providerOverride;
        log.info(`[hooks] provider overridden to ${provider}`);
    }
    if (modelResolveOverride?.modelOverride) {
        modelId = modelResolveOverride.modelOverride;
        log.info(`[hooks] model overridden to ${modelId}`);
    }
    return {
        provider,
        modelId,
        legacyBeforeAgentStartResult,
    };
}
export function buildBeforeModelResolveAttachments(images) {
    if (!images?.length) {
        return undefined;
    }
    return images.map((img) => ({
        kind: "image",
        mimeType: img.mimeType,
    }));
}
export function resolveEffectiveRuntimeModel(params) {
    const ctxInfo = resolveContextWindowInfo({
        cfg: params.cfg,
        provider: params.provider,
        modelId: params.modelId,
        modelContextTokens: readPiModelContextTokens(params.runtimeModel),
        modelContextWindow: params.runtimeModel.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    // Apply contextTokens cap to model so pi-coding-agent's auto-compaction
    // threshold uses the effective limit, not the native context window.
    const effectiveModel = ctxInfo.tokens < (params.runtimeModel.contextWindow ?? Infinity)
        ? { ...params.runtimeModel, contextWindow: ctxInfo.tokens }
        : params.runtimeModel;
    const ctxGuard = evaluateContextWindowGuard({
        info: ctxInfo,
        warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
        hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
    });
    const runtimeBaseUrl = typeof params.runtimeModel.baseUrl === "string"
        ? params.runtimeModel.baseUrl
        : undefined;
    if (ctxGuard.shouldWarn) {
        log.warn(formatContextWindowWarningMessage({
            provider: params.provider,
            modelId: params.modelId,
            guard: ctxGuard,
            runtimeBaseUrl,
        }));
    }
    if (ctxGuard.shouldBlock) {
        const message = formatContextWindowBlockMessage({
            guard: ctxGuard,
            runtimeBaseUrl,
        });
        log.error(`blocked model (context window too small): ${params.provider}/${params.modelId} ctx=${ctxGuard.tokens} (min=${CONTEXT_WINDOW_HARD_MIN_TOKENS}) source=${ctxGuard.source}; ${message}`);
        throw new FailoverError(message, {
            reason: "unknown",
            provider: params.provider,
            model: params.modelId,
        });
    }
    return {
        ctxInfo,
        effectiveModel,
    };
}
