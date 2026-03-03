export function normalizeNetworkMode(network) {
    const normalized = network?.trim().toLowerCase();
    return normalized || undefined;
}
export function getBlockedNetworkModeReason(params) {
    const normalized = normalizeNetworkMode(params.network);
    if (!normalized) {
        return null;
    }
    if (normalized === "host") {
        return "host";
    }
    if (normalized.startsWith("container:") && params.allowContainerNamespaceJoin !== true) {
        return "container_namespace_join";
    }
    return null;
}
export function isDangerousNetworkMode(network) {
    const normalized = normalizeNetworkMode(network);
    return normalized === "host" || normalized?.startsWith("container:") === true;
}
