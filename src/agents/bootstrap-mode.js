export function resolveBootstrapMode(params) {
    if (!params.bootstrapPending) {
        return "none";
    }
    if (params.runKind === "heartbeat" || params.runKind === "cron") {
        return "none";
    }
    if (!params.isPrimaryRun || !params.isInteractiveUserFacing) {
        return "none";
    }
    if (!params.hasBootstrapFileAccess) {
        return "none";
    }
    return params.isCanonicalWorkspace ? "full" : "limited";
}
