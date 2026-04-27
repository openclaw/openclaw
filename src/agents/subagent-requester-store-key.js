import { resolveAgentIdFromSessionKey, resolveMainSessionKey, } from "../config/sessions/main-session.js";
import { normalizeMainKey } from "../routing/session-key.js";
export function resolveRequesterStoreKey(cfg, requesterSessionKey) {
    const raw = (requesterSessionKey ?? "").trim();
    if (!raw) {
        return raw;
    }
    if (raw === "global" || raw === "unknown") {
        return raw;
    }
    if (raw.startsWith("agent:")) {
        return raw;
    }
    const mainKey = normalizeMainKey(cfg?.session?.mainKey);
    if (raw === "main" || raw === mainKey) {
        return resolveMainSessionKey(cfg);
    }
    const agentId = resolveAgentIdFromSessionKey(raw);
    return `agent:${agentId}:${raw}`;
}
