import { formatThinkingLevels } from "../auto-reply/thinking.js";
import { resolveSubagentSpawnModelSelection } from "./model-selection.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";
export function splitModelRef(ref) {
    if (!ref) {
        return { provider: undefined, model: undefined };
    }
    const trimmed = ref.trim();
    if (!trimmed) {
        return { provider: undefined, model: undefined };
    }
    const [provider, model] = trimmed.split("/", 2);
    if (model) {
        return { provider, model };
    }
    return { provider: undefined, model: trimmed };
}
export function resolveConfiguredSubagentRunTimeoutSeconds(params) {
    const cfgSubagentTimeout = typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
        Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
        ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
        : 0;
    return typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
        ? Math.max(0, Math.floor(params.runTimeoutSeconds))
        : cfgSubagentTimeout;
}
export function resolveSubagentModelAndThinkingPlan(params) {
    const resolvedModel = resolveSubagentSpawnModelSelection({
        cfg: params.cfg,
        agentId: params.targetAgentId,
        modelOverride: params.modelOverride,
    });
    const thinkingPlan = resolveSubagentThinkingOverride({
        cfg: params.cfg,
        targetAgentConfig: params.targetAgentConfig,
        thinkingOverrideRaw: params.thinkingOverrideRaw,
    });
    if (thinkingPlan.status === "error") {
        const { provider, model } = splitModelRef(resolvedModel);
        const hint = formatThinkingLevels(provider, model);
        return {
            status: "error",
            resolvedModel,
            error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${hint}.`,
        };
    }
    return {
        status: "ok",
        resolvedModel,
        modelApplied: Boolean(resolvedModel),
        thinkingOverride: thinkingPlan.thinkingOverride,
        initialSessionPatch: {
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...thinkingPlan.initialSessionPatch,
        },
    };
}
