export declare function normalizeWideAreaDomain(raw?: string | null): string | null;
export declare function resolveWideAreaDiscoveryDomain(params?: {
    env?: NodeJS.ProcessEnv;
    configDomain?: string | null;
}): string | null;
export declare function getWideAreaZonePath(domain: string): string;
export type WideAreaGatewayZoneOpts = {
    domain: string;
    gatewayPort: number;
    displayName: string;
    tailnetIPv4: string;
    tailnetIPv6?: string;
    gatewayTlsEnabled?: boolean;
    gatewayTlsFingerprintSha256?: string;
    instanceLabel?: string;
    hostLabel?: string;
    tailnetDns?: string;
    sshPort?: number;
    cliPath?: string;
};
export declare function renderWideAreaGatewayZoneText(opts: WideAreaGatewayZoneOpts & {
    serial: number;
}): string;
export declare function writeWideAreaGatewayZone(opts: WideAreaGatewayZoneOpts): Promise<{
    zonePath: string;
    changed: boolean;
}>;
