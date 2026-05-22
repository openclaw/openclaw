import type { SystemPresence } from "../infra/system-presence.js";
export type GatewayProbeAuth = {
    token?: string;
    password?: string;
};
export type GatewayProbeClose = {
    code: number;
    reason: string;
    hint?: string;
};
export type GatewayProbeCapability = "unknown" | "pairing_pending" | "connected_no_operator_scope" | "read_only" | "write_capable" | "admin_capable";
export type GatewayProbeAuthSummary = {
    role: string | null;
    scopes: string[];
    capability: GatewayProbeCapability;
};
export type GatewayProbeServerSummary = {
    version: string | null;
    connId: string | null;
};
export type GatewayProbeResult = {
    ok: boolean;
    url: string;
    connectLatencyMs: number | null;
    error: string | null;
    connectErrorDetails?: unknown;
    close: GatewayProbeClose | null;
    auth: GatewayProbeAuthSummary;
    server?: GatewayProbeServerSummary;
    health: unknown;
    status: unknown;
    presence: SystemPresence[] | null;
    configSnapshot: unknown;
};
export declare const MIN_PROBE_TIMEOUT_MS = 250;
export declare const MAX_TIMER_DELAY_MS = 2147483647;
export declare function clampProbeTimeoutMs(timeoutMs: number): number;
export declare function isPairingPendingProbeFailure(params: {
    error?: string | null;
    close?: GatewayProbeClose | null;
}): boolean;
export declare function resolveGatewayProbeCapability(params: {
    auth?: Pick<GatewayProbeAuthSummary, "scopes"> | null;
    authMetadataPresent?: boolean;
    error?: string | null;
    close?: GatewayProbeClose | null;
    verifiedRead?: boolean;
    connectLatencyMs?: number | null;
}): GatewayProbeCapability;
export declare function probeGateway(opts: {
    url: string;
    auth?: GatewayProbeAuth;
    timeoutMs: number;
    preauthHandshakeTimeoutMs?: number;
    includeDetails?: boolean;
    detailLevel?: "none" | "presence" | "full";
    tlsFingerprint?: string;
}): Promise<GatewayProbeResult>;
