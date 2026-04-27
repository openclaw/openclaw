import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
export async function applyBootstrapHookOverrides(params) {
    const sessionKey = params.sessionKey ?? params.sessionId ?? "unknown";
    const agentId = params.agentId ??
        (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
    const context = {
        workspaceDir: params.workspaceDir,
        bootstrapFiles: params.files,
        cfg: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId,
    };
    const event = createInternalHookEvent("agent", "bootstrap", sessionKey, context);
    await triggerInternalHook(event);
    const updated = event.context.bootstrapFiles;
    return Array.isArray(updated) ? updated : params.files;
}
