import { type GatewayBonjourBeacon, type GatewayDiscoveryResolvedEndpoint } from "./bonjour-discovery.js";
type GatewayDiscoveryTarget = {
    title: string;
    domain: string;
    endpoint: GatewayDiscoveryResolvedEndpoint | null;
    wsUrl: string | null;
    sshPort: number | null;
    sshTarget: string | null;
};
export declare function buildGatewayDiscoveryTarget(beacon: GatewayBonjourBeacon, opts?: {
    sshUser?: string | null;
}): GatewayDiscoveryTarget;
export declare function buildGatewayDiscoveryLabel(beacon: GatewayBonjourBeacon): string;
export declare function serializeGatewayDiscoveryBeacon(beacon: GatewayBonjourBeacon): {
    instanceName: string;
    displayName: string | null;
    domain: string | null;
    host: string | null;
    lanHost: string | null;
    tailnetDns: string | null;
    gatewayPort: number | null;
    sshPort: number | null;
    wsUrl: string | null;
};
export {};
