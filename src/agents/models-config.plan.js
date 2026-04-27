import { isRecord } from "../utils.js";
import { mergeProviders, mergeWithExistingProviderSecrets, } from "./models-config.merge.js";
import { applyNativeStreamingUsageCompat, enforceSourceManagedProviderSecrets, normalizeProviders, resolveImplicitProviders, } from "./models-config.providers.js";
export async function resolveProvidersForModelsJsonWithDeps(params, deps) {
    const { cfg, agentDir, env } = params;
    const explicitProviders = cfg.models?.providers ?? {};
    const resolveImplicitProvidersImpl = deps?.resolveImplicitProviders ?? resolveImplicitProviders;
    const implicitProviders = await resolveImplicitProvidersImpl({
        agentDir,
        config: cfg,
        env,
        explicitProviders,
    });
    return mergeProviders({
        implicit: implicitProviders,
        explicit: explicitProviders,
    });
}
function resolveProvidersForMode(params) {
    if (params.mode !== "merge") {
        return params.providers;
    }
    const existing = params.existingParsed;
    if (!isRecord(existing) || !isRecord(existing.providers)) {
        return params.providers;
    }
    const existingProviders = existing.providers;
    return mergeWithExistingProviderSecrets({
        nextProviders: params.providers,
        existingProviders: existingProviders,
        secretRefManagedProviders: params.secretRefManagedProviders,
    });
}
export async function planOpenClawModelsJsonWithDeps(params, deps) {
    const { cfg, agentDir, env } = params;
    const providers = await resolveProvidersForModelsJsonWithDeps({ cfg, agentDir, env }, deps);
    if (Object.keys(providers).length === 0) {
        return { action: "skip" };
    }
    const mode = cfg.models?.mode ?? "merge";
    const secretRefManagedProviders = new Set();
    const normalizedProviders = normalizeProviders({
        providers,
        agentDir,
        env,
        secretDefaults: cfg.secrets?.defaults,
        sourceProviders: params.sourceConfigForSecrets?.models?.providers,
        sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
        secretRefManagedProviders,
    }) ?? providers;
    const mergedProviders = resolveProvidersForMode({
        mode,
        existingParsed: params.existingParsed,
        providers: normalizedProviders,
        secretRefManagedProviders,
    });
    const secretEnforcedProviders = enforceSourceManagedProviderSecrets({
        providers: mergedProviders,
        sourceProviders: params.sourceConfigForSecrets?.models?.providers,
        sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
        secretRefManagedProviders,
    }) ?? mergedProviders;
    const finalProviders = applyNativeStreamingUsageCompat(secretEnforcedProviders);
    const nextContents = `${JSON.stringify({ providers: finalProviders }, null, 2)}\n`;
    if (params.existingRaw === nextContents) {
        return { action: "noop" };
    }
    return {
        action: "write",
        contents: nextContents,
    };
}
export async function planOpenClawModelsJson(params) {
    return planOpenClawModelsJsonWithDeps(params);
}
