export type DeviceAuthEntry = {
    token: string;
    role: string;
    scopes: string[];
    updatedAtMs: number;
};
export type DeviceAuthStore = {
    version: 1;
    deviceId: string;
    tokens: Record<string, DeviceAuthEntry>;
};
export declare function normalizeDeviceAuthRole(role: string): string;
export declare function normalizeDeviceAuthScopes(scopes: string[] | undefined): string[];
