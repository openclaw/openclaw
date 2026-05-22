import { type DeviceBootstrapProfile } from "../shared/device-bootstrap-profile.js";
export type DevicePairingPendingRequest = {
    requestId: string;
    deviceId: string;
    publicKey: string;
    displayName?: string;
    platform?: string;
    deviceFamily?: string;
    clientId?: string;
    clientMode?: string;
    role?: string;
    roles?: string[];
    scopes?: string[];
    remoteIp?: string;
    silent?: boolean;
    isRepair?: boolean;
    ts: number;
};
export type DeviceAuthToken = {
    token: string;
    role: string;
    scopes: string[];
    createdAtMs: number;
    rotatedAtMs?: number;
    revokedAtMs?: number;
    lastUsedAtMs?: number;
};
export type DeviceAuthTokenSummary = {
    role: string;
    scopes: string[];
    createdAtMs: number;
    rotatedAtMs?: number;
    revokedAtMs?: number;
    lastUsedAtMs?: number;
};
export type RotateDeviceTokenDenyReason = "unknown-device-or-role" | "missing-approved-scope-baseline" | "scope-outside-approved-baseline" | "caller-missing-scope";
export type RotateDeviceTokenResult = {
    ok: true;
    entry: DeviceAuthToken;
} | {
    ok: false;
    reason: RotateDeviceTokenDenyReason;
    scope?: string;
};
export type RevokeDeviceTokenDenyReason = "unknown-device-or-role" | "caller-missing-scope";
export type RevokeDeviceTokenResult = {
    ok: true;
    entry: DeviceAuthToken;
} | {
    ok: false;
    reason: RevokeDeviceTokenDenyReason;
    scope?: string;
};
export type PairedDevice = {
    deviceId: string;
    publicKey: string;
    displayName?: string;
    platform?: string;
    deviceFamily?: string;
    clientId?: string;
    clientMode?: string;
    role?: string;
    roles?: string[];
    scopes?: string[];
    approvedScopes?: string[];
    remoteIp?: string;
    tokens?: Record<string, DeviceAuthToken>;
    createdAtMs: number;
    approvedAtMs: number;
    lastSeenAtMs?: number;
    lastSeenReason?: string;
};
export type PairedDeviceMetadataPatch = Pick<PairedDevice, "displayName" | "clientId" | "clientMode" | "remoteIp" | "lastSeenAtMs" | "lastSeenReason">;
export type DevicePairingList = {
    pending: DevicePairingPendingRequest[];
    paired: PairedDevice[];
};
export type DevicePairingForbiddenReason = "caller-scopes-required" | "caller-missing-scope" | "scope-outside-requested-roles" | "bootstrap-role-not-allowed" | "bootstrap-scope-not-allowed";
export type DevicePairingForbiddenResult = {
    status: "forbidden";
    reason: DevicePairingForbiddenReason;
    scope?: string;
    role?: string;
};
export type ApproveDevicePairingResult = {
    status: "approved";
    requestId: string;
    device: PairedDevice;
} | DevicePairingForbiddenResult | null;
export declare function formatDevicePairingForbiddenMessage(result: DevicePairingForbiddenResult): string;
export declare function listApprovedPairedDeviceRoles(device: Pick<PairedDevice, "role" | "roles">): string[];
export declare function listEffectivePairedDeviceRoles(device: Pick<PairedDevice, "role" | "roles" | "tokens">): string[];
export declare function hasEffectivePairedDeviceRole(device: Pick<PairedDevice, "role" | "roles" | "tokens">, role: string): boolean;
export declare function listDevicePairing(baseDir?: string): Promise<DevicePairingList>;
export declare function getPairedDevice(deviceId: string, baseDir?: string): Promise<PairedDevice | null>;
export declare function getPendingDevicePairing(requestId: string, baseDir?: string): Promise<DevicePairingPendingRequest | null>;
export declare function requestDevicePairing(req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">, baseDir?: string): Promise<{
    status: "pending";
    request: DevicePairingPendingRequest;
    created: boolean;
}>;
export declare function approveDevicePairing(requestId: string, baseDir?: string): Promise<ApproveDevicePairingResult>;
export declare function approveDevicePairing(requestId: string, options: {
    callerScopes?: readonly string[];
}, baseDir?: string): Promise<ApproveDevicePairingResult>;
export declare function approveBootstrapDevicePairing(requestId: string, bootstrapProfile: DeviceBootstrapProfile, baseDir?: string): Promise<ApproveDevicePairingResult>;
export declare function rejectDevicePairing(requestId: string, baseDir?: string): Promise<{
    requestId: string;
    deviceId: string;
} | null>;
export declare function removePairedDevice(deviceId: string, baseDir?: string): Promise<{
    deviceId: string;
} | null>;
export declare function updatePairedDeviceMetadata(deviceId: string, patch: Partial<PairedDeviceMetadataPatch>, baseDir?: string): Promise<boolean>;
export declare function summarizeDeviceTokens(tokens: Record<string, DeviceAuthToken> | undefined): DeviceAuthTokenSummary[] | undefined;
export declare function verifyDeviceToken(params: {
    deviceId: string;
    token: string;
    role: string;
    scopes: string[];
    baseDir?: string;
}): Promise<{
    ok: boolean;
    reason?: string;
}>;
export declare function ensureDeviceToken(params: {
    deviceId: string;
    role: string;
    scopes: string[];
    baseDir?: string;
}): Promise<DeviceAuthToken | null>;
export declare function rotateDeviceToken(params: {
    deviceId: string;
    role: string;
    scopes?: string[];
    callerScopes?: readonly string[];
    baseDir?: string;
}): Promise<RotateDeviceTokenResult>;
export declare function revokeDeviceToken(params: {
    deviceId: string;
    role: string;
    callerScopes?: readonly string[];
    baseDir?: string;
}): Promise<RevokeDeviceTokenResult>;
export declare function clearDevicePairing(deviceId: string, baseDir?: string): Promise<boolean>;
