export type NetworkModeBlockReason = "host" | "container_namespace_join";
export declare function normalizeNetworkMode(network: string | undefined): string | undefined;
export declare function getBlockedNetworkModeReason(params: {
    network: string | undefined;
    allowContainerNamespaceJoin?: boolean;
}): NetworkModeBlockReason | null;
export declare function isDangerousNetworkMode(network: string | undefined): boolean;
