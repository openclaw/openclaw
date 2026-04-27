import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";
const registry = createSessionManagerRuntimeRegistry();
export const setCompactionSafeguardRuntime = registry.set;
export const getCompactionSafeguardRuntime = registry.get;
export function setCompactionSafeguardCancelReason(sessionManager, reason) {
    const current = getCompactionSafeguardRuntime(sessionManager);
    const trimmed = reason?.trim();
    if (!current) {
        if (!trimmed) {
            return;
        }
        setCompactionSafeguardRuntime(sessionManager, { cancelReason: trimmed });
        return;
    }
    const next = { ...current };
    if (trimmed) {
        next.cancelReason = trimmed;
    }
    else {
        delete next.cancelReason;
    }
    setCompactionSafeguardRuntime(sessionManager, next);
}
export function consumeCompactionSafeguardCancelReason(sessionManager) {
    const current = getCompactionSafeguardRuntime(sessionManager);
    const reason = current?.cancelReason?.trim();
    if (!reason) {
        return null;
    }
    const next = { ...current };
    delete next.cancelReason;
    setCompactionSafeguardRuntime(sessionManager, Object.keys(next).length > 0 ? next : null);
    return reason;
}
