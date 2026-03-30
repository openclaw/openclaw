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
};
export type DevicePairingList = {
    pending: DevicePairingPendingRequest[];
    paired: PairedDevice[];
};
export declare function listDevicePairing(baseDir?: string): Promise<DevicePairingList>;
export declare function getPairedDevice(deviceId: string, baseDir?: string): Promise<PairedDevice | null>;
export declare function requestDevicePairing(req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">, baseDir?: string): Promise<{
    status: "pending";
    request: DevicePairingPendingRequest;
    created: boolean;
}>;
export declare function approveDevicePairing(requestId: string, baseDir?: string): Promise<{
    requestId: string;
    device: PairedDevice;
} | null>;
export declare function rejectDevicePairing(requestId: string, baseDir?: string): Promise<{
    requestId: string;
    deviceId: string;
} | null>;
export declare function removePairedDevice(deviceId: string, baseDir?: string): Promise<{
    deviceId: string;
} | null>;
export declare function updatePairedDeviceMetadata(deviceId: string, patch: Partial<Omit<PairedDevice, "deviceId" | "createdAtMs" | "approvedAtMs" | "approvedScopes">>, baseDir?: string): Promise<void>;
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
    baseDir?: string;
}): Promise<DeviceAuthToken | null>;
export declare function revokeDeviceToken(params: {
    deviceId: string;
    role: string;
    baseDir?: string;
}): Promise<DeviceAuthToken | null>;
export declare function clearDevicePairing(deviceId: string, baseDir?: string): Promise<boolean>;
