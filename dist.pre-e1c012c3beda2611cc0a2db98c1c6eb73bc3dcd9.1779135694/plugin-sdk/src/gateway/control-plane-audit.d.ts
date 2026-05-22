import type { GatewayClient } from "./server-methods/types.js";
export type ControlPlaneActor = {
    actor: string;
    deviceId: string;
    clientIp: string;
    connId: string;
};
export declare function resolveControlPlaneActor(client: GatewayClient | null): ControlPlaneActor;
export declare function formatControlPlaneActor(actor: ControlPlaneActor): string;
export declare function summarizeChangedPaths(paths: string[], maxPaths?: number): string;
