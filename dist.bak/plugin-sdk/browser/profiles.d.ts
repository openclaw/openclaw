/**
 * CDP port allocation for browser profiles.
 *
 * Default port range: 18800-18899 (100 profiles max)
 * Ports are allocated once at profile creation and persisted in config.
 * Multi-instance: callers may pass an explicit range to avoid collisions.
 *
 * Reserved ports (do not use for CDP):
 *   18789 - Gateway WebSocket
 *   18790 - Bridge
 *   18791 - Browser control server
 *   18792-18799 - Reserved for future one-off services (canvas at 18793)
 */
export declare const CDP_PORT_RANGE_START = 18800;
export declare const CDP_PORT_RANGE_END = 18899;
export declare const PROFILE_NAME_REGEX: RegExp;
export declare function isValidProfileName(name: string): boolean;
export declare function allocateCdpPort(usedPorts: Set<number>, range?: {
    start: number;
    end: number;
}): number | null;
export declare function getUsedPorts(profiles: Record<string, {
    cdpPort?: number;
    cdpUrl?: string;
}> | undefined): Set<number>;
export declare const PROFILE_COLORS: string[];
export declare function allocateColor(usedColors: Set<string>): string;
export declare function getUsedColors(profiles: Record<string, {
    color: string;
}> | undefined): Set<string>;
