export type NetworkModeBlockReason = "host" | "container_namespace_join";

export function normalizeNetworkMode(network: string | undefined): string | undefined {
  const normalized = network?.trim().toLowerCase();
  return normalized || undefined;
}

export function getBlockedNetworkModeReason(params: {
  network: string | undefined;
  allowContainerNamespaceJoin?: boolean;
}): NetworkModeBlockReason | null {
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

export function isDangerousNetworkMode(network: string | undefined): boolean {
  const normalized = normalizeNetworkMode(network);
  return normalized === "host" || normalized?.startsWith("container:") === true;
}
