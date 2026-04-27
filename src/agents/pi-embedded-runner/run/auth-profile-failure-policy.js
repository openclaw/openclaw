export function resolveAuthProfileFailureReason(params) {
    // Helper-local runs and transport timeouts should not poison shared provider auth health.
    if (params.policy === "local" || !params.failoverReason || params.failoverReason === "timeout") {
        return null;
    }
    return params.failoverReason;
}
