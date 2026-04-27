import { normalizeFastMode } from "../auto-reply/thinking.shared.js";
import { resolveAgentConfig } from "./agent-scope.js";
function resolveConfiguredFastModeRaw(params) {
    const modelKey = `${params.provider}/${params.model}`;
    const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
    return modelConfig?.params?.fastMode ?? modelConfig?.params?.fast_mode;
}
export function resolveFastModeState(params) {
    const sessionOverride = normalizeFastMode(params.sessionEntry?.fastMode);
    if (sessionOverride !== undefined) {
        return { enabled: sessionOverride, source: "session" };
    }
    const agentDefault = params.agentId && params.cfg
        ? resolveAgentConfig(params.cfg, params.agentId)?.fastModeDefault
        : undefined;
    if (typeof agentDefault === "boolean") {
        return { enabled: agentDefault, source: "agent" };
    }
    const configuredRaw = resolveConfiguredFastModeRaw(params);
    const configured = normalizeFastMode(configuredRaw);
    if (configured !== undefined) {
        return { enabled: configured, source: "config" };
    }
    return { enabled: false, source: "default" };
}
