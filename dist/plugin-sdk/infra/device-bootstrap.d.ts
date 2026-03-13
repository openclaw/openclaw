export declare const DEVICE_BOOTSTRAP_TOKEN_TTL_MS: number;
export type DeviceBootstrapTokenRecord = {
    token: string;
    ts: number;
    deviceId?: string;
    publicKey?: string;
    roles?: string[];
    scopes?: string[];
    issuedAtMs: number;
    lastUsedAtMs?: number;
};
export declare function issueDeviceBootstrapToken(params?: {
    baseDir?: string;
}): Promise<{
    token: string;
    expiresAtMs: number;
}>;
export declare function verifyDeviceBootstrapToken(params: {
    token: string;
    deviceId: string;
    publicKey: string;
    role: string;
    scopes: readonly string[];
    baseDir?: string;
}): Promise<{
    ok: true;
} | {
    ok: false;
    reason: string;
}>;
