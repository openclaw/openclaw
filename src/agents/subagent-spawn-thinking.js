import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
function asRecord(value) {
    return value && typeof value === "object" ? value : undefined;
}
function readString(value, key) {
    const raw = value[key];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}
export function resolveSubagentThinkingOverride(params) {
    const targetSubagents = asRecord(asRecord(params.targetAgentConfig)?.subagents);
    const defaultSubagents = asRecord(params.cfg.agents?.defaults?.subagents);
    const resolvedThinkingDefaultRaw = readString(targetSubagents ?? {}, "thinking") ?? readString(defaultSubagents ?? {}, "thinking");
    const thinkingCandidateRaw = params.thinkingOverrideRaw || resolvedThinkingDefaultRaw;
    if (!thinkingCandidateRaw) {
        return {
            status: "ok",
            thinkingOverride: undefined,
            initialSessionPatch: {},
        };
    }
    const normalizedThinking = normalizeThinkLevel(thinkingCandidateRaw);
    if (!normalizedThinking) {
        return {
            status: "error",
            thinkingCandidateRaw,
        };
    }
    return {
        status: "ok",
        thinkingOverride: normalizedThinking,
        initialSessionPatch: {
            thinkingLevel: normalizedThinking === "off" ? null : normalizedThinking,
        },
    };
}
