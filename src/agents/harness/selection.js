import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listAgentEntries, resolveSessionAgentIds } from "../agent-scope.js";
import { normalizeEmbeddedAgentRuntime, resolveEmbeddedAgentHarnessFallback, resolveEmbeddedAgentRuntime, } from "../pi-embedded-runner/runtime.js";
import { createPiAgentHarness } from "./builtin-pi.js";
import { listRegisteredAgentHarnesses } from "./registry.js";
const log = createSubsystemLogger("agents/harness");
function listPluginAgentHarnesses() {
    return listRegisteredAgentHarnesses().map((entry) => entry.harness);
}
function compareHarnessSupport(left, right) {
    const priorityDelta = (right.support.priority ?? 0) - (left.support.priority ?? 0);
    if (priorityDelta !== 0) {
        return priorityDelta;
    }
    return left.harness.id.localeCompare(right.harness.id);
}
export function selectAgentHarness(params) {
    return selectAgentHarnessDecision(params).harness;
}
function selectAgentHarnessDecision(params) {
    const pinnedPolicy = resolvePinnedAgentHarnessPolicy(params.agentHarnessId);
    const policy = pinnedPolicy ?? resolveAgentHarnessPolicy(params);
    // PI is intentionally not part of the plugin candidate list. It is the legacy
    // fallback path, so `fallback: "none"` can prove that only plugin harnesses run.
    const pluginHarnesses = listPluginAgentHarnesses();
    const piHarness = createPiAgentHarness();
    const runtime = policy.runtime;
    if (runtime === "pi") {
        return buildSelectionDecision({
            harness: piHarness,
            policy,
            selectedReason: pinnedPolicy ? "pinned" : "forced_pi",
            candidates: listHarnessCandidates(pluginHarnesses),
        });
    }
    if (runtime !== "auto") {
        const forced = pluginHarnesses.find((entry) => entry.id === runtime);
        if (forced) {
            return buildSelectionDecision({
                harness: forced,
                policy,
                selectedReason: pinnedPolicy ? "pinned" : "forced_plugin",
                candidates: listHarnessCandidates(pluginHarnesses),
            });
        }
        if (policy.fallback === "none") {
            throw new Error(`Requested agent harness "${runtime}" is not registered and PI fallback is disabled.`);
        }
        log.warn("requested agent harness is not registered; falling back to embedded PI backend", {
            requestedRuntime: runtime,
        });
        return buildSelectionDecision({
            harness: piHarness,
            policy,
            selectedReason: "forced_plugin_fallback_to_pi",
            candidates: listHarnessCandidates(pluginHarnesses),
        });
    }
    const candidates = pluginHarnesses.map((harness) => ({
        harness,
        support: harness.supports({
            provider: params.provider,
            modelId: params.modelId,
            requestedRuntime: runtime,
        }),
    }));
    const supported = candidates
        .filter((entry) => entry.support.supported)
        .toSorted(compareHarnessSupport);
    const selected = supported[0]?.harness;
    if (selected) {
        return buildSelectionDecision({
            harness: selected,
            policy,
            selectedReason: "auto_plugin",
            candidates: candidates.map(toSelectionCandidate),
        });
    }
    if (policy.fallback === "none") {
        throw new Error(`No registered agent harness supports ${formatProviderModel(params)} and PI fallback is disabled.`);
    }
    return buildSelectionDecision({
        harness: piHarness,
        policy,
        selectedReason: "auto_pi_fallback",
        candidates: candidates.map(toSelectionCandidate),
    });
}
export async function runAgentHarnessAttemptWithFallback(params) {
    const selection = selectAgentHarnessDecision({
        provider: params.provider,
        modelId: params.modelId,
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        agentHarnessId: params.agentHarnessId,
    });
    const harness = selection.harness;
    logAgentHarnessSelection(selection, {
        provider: params.provider,
        modelId: params.modelId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
    });
    if (harness.id === "pi") {
        const result = await harness.runAttempt(params);
        return applyHarnessResultClassification(harness, result, params);
    }
    try {
        const result = await harness.runAttempt(params);
        return applyHarnessResultClassification(harness, result, params);
    }
    catch (error) {
        log.warn(`${harness.label} failed; not falling back to embedded PI backend`, {
            harnessId: harness.id,
            provider: params.provider,
            modelId: params.modelId,
            error: formatErrorMessage(error),
        });
        throw error;
    }
}
function listHarnessCandidates(harnesses) {
    return harnesses.map((harness) => ({
        id: harness.id,
        label: harness.label,
        pluginId: harness.pluginId,
    }));
}
function toSelectionCandidate(entry) {
    return {
        id: entry.harness.id,
        label: entry.harness.label,
        pluginId: entry.harness.pluginId,
        supported: entry.support.supported,
        priority: entry.support.supported ? entry.support.priority : undefined,
        reason: entry.support.reason,
    };
}
function buildSelectionDecision(params) {
    return {
        harness: params.harness,
        policy: params.policy,
        selectedHarnessId: params.harness.id,
        selectedReason: params.selectedReason,
        candidates: params.candidates,
    };
}
function logAgentHarnessSelection(selection, params) {
    if (!log.isEnabled("debug")) {
        return;
    }
    log.debug("agent harness selected", {
        provider: params.provider,
        modelId: params.modelId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        selectedHarnessId: selection.selectedHarnessId,
        selectedReason: selection.selectedReason,
        runtime: selection.policy.runtime,
        fallback: selection.policy.fallback,
        candidates: selection.candidates,
    });
}
function applyHarnessResultClassification(harness, result, params) {
    const classification = harness.classify?.(result, params);
    if (!classification || classification === "ok") {
        return { ...result, agentHarnessId: harness.id };
    }
    return {
        ...result,
        agentHarnessId: harness.id,
        agentHarnessResultClassification: classification,
    };
}
function resolvePinnedAgentHarnessPolicy(agentHarnessId) {
    if (!agentHarnessId?.trim()) {
        return undefined;
    }
    const runtime = normalizeEmbeddedAgentRuntime(agentHarnessId);
    if (runtime === "auto") {
        return undefined;
    }
    return { runtime, fallback: "none" };
}
export async function maybeCompactAgentHarnessSession(params) {
    const harness = selectAgentHarness({
        provider: params.provider ?? "",
        modelId: params.model,
        config: params.config,
        sessionKey: params.sessionKey,
        agentHarnessId: params.agentHarnessId,
    });
    if (!harness.compact) {
        if (harness.id !== "pi") {
            return {
                ok: false,
                compacted: false,
                reason: `Agent harness "${harness.id}" does not support compaction.`,
            };
        }
        return undefined;
    }
    return harness.compact(params);
}
export function resolveAgentHarnessPolicy(params) {
    const env = params.env ?? process.env;
    // Harness policy can be session-scoped because users may switch between agents
    // with different strictness requirements inside the same gateway process.
    const agentPolicy = resolveAgentEmbeddedHarnessConfig(params.config, {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
    });
    const defaultsPolicy = params.config?.agents?.defaults?.embeddedHarness;
    const runtime = env.OPENCLAW_AGENT_RUNTIME?.trim()
        ? resolveEmbeddedAgentRuntime(env)
        : normalizeEmbeddedAgentRuntime(agentPolicy?.runtime ?? defaultsPolicy?.runtime);
    return {
        runtime,
        fallback: resolveAgentHarnessFallbackPolicy({
            env,
            runtime,
            agentPolicy,
            defaultsPolicy,
        }),
    };
}
function resolveAgentHarnessFallbackPolicy(params) {
    const envFallback = resolveEmbeddedAgentHarnessFallback(params.env);
    if (envFallback) {
        return envFallback;
    }
    const envRuntime = params.env.OPENCLAW_AGENT_RUNTIME?.trim();
    if (envRuntime && isPluginAgentRuntime(params.runtime)) {
        return normalizeAgentHarnessFallback(undefined, params.runtime);
    }
    if (params.agentPolicy?.runtime) {
        return normalizeAgentHarnessFallback(params.agentPolicy.fallback, params.runtime);
    }
    return normalizeAgentHarnessFallback(params.agentPolicy?.fallback ?? params.defaultsPolicy?.fallback, params.runtime);
}
function isPluginAgentRuntime(runtime) {
    return runtime !== "auto" && runtime !== "pi";
}
function resolveAgentEmbeddedHarnessConfig(config, params) {
    if (!config) {
        return undefined;
    }
    const { sessionAgentId } = resolveSessionAgentIds({
        config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
    });
    return listAgentEntries(config).find((entry) => normalizeAgentId(entry.id) === sessionAgentId)
        ?.embeddedHarness;
}
function normalizeAgentHarnessFallback(value, runtime) {
    if (value) {
        return value === "none" ? "none" : "pi";
    }
    return runtime === "auto" ? "pi" : "none";
}
function formatProviderModel(params) {
    return params.modelId ? `${params.provider}/${params.modelId}` : params.provider;
}
