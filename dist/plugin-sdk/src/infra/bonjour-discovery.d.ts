import { runCommandWithTimeout } from "../process/exec.js";
export type GatewayBonjourBeacon = {
    instanceName: string;
    domain?: string;
    displayName?: string;
    host?: string;
    port?: number;
    lanHost?: string;
    tailnetDns?: string;
    gatewayPort?: number;
    sshPort?: number;
    gatewayTls?: boolean;
    gatewayTlsFingerprintSha256?: string;
    cliPath?: string;
    role?: string;
    transport?: string;
    txt?: Record<string, string>;
};
export type GatewayDiscoveryResolvedEndpoint = {
    host: string;
    port: number;
    gatewayTls: boolean;
    gatewayTlsFingerprintSha256?: string;
    scheme: "ws" | "wss";
    wsUrl: string;
};
export declare function resolveGatewayDiscoveryEndpoint(beacon: GatewayBonjourBeacon): GatewayDiscoveryResolvedEndpoint | null;
export declare function pickResolvedGatewayHost(beacon: GatewayBonjourBeacon): string | null;
export declare function pickResolvedGatewayPort(beacon: GatewayBonjourBeacon): number | null;
export type GatewayBonjourDiscoverOpts = {
    timeoutMs?: number;
    domains?: string[];
    wideAreaDomain?: string | null;
    platform?: NodeJS.Platform;
    run?: typeof runCommandWithTimeout;
};
export declare function discoverGatewayBeacons(opts?: GatewayBonjourDiscoverOpts): Promise<GatewayBonjourBeacon[]>;
