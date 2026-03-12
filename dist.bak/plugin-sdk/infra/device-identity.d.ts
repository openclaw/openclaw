export type DeviceIdentity = {
    deviceId: string;
    publicKeyPem: string;
    privateKeyPem: string;
};
export declare function loadOrCreateDeviceIdentity(filePath?: string): DeviceIdentity;
export declare function signDevicePayload(privateKeyPem: string, payload: string): string;
export declare function normalizeDevicePublicKeyBase64Url(publicKey: string): string | null;
export declare function deriveDeviceIdFromPublicKey(publicKey: string): string | null;
export declare function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string;
export declare function verifyDeviceSignature(publicKey: string, payload: string, signatureBase64Url: string): boolean;
