import { normalizeDeviceMetadataForAuth } from "./device-metadata-normalization.js";
export { normalizeDeviceMetadataForAuth };
type DeviceAuthPayloadParams = {
    deviceId: string;
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    signedAtMs: number;
    token?: string | null;
    nonce: string;
};
type DeviceAuthPayloadV3Params = DeviceAuthPayloadParams & {
    platform?: string | null;
    deviceFamily?: string | null;
};
export declare function buildDeviceAuthPayload(params: DeviceAuthPayloadParams): string;
export declare function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string;
