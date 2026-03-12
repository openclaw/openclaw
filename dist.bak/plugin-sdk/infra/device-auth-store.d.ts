import { type DeviceAuthEntry } from "../shared/device-auth.js";
export declare function loadDeviceAuthToken(params: {
    deviceId: string;
    role: string;
    env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null;
export declare function storeDeviceAuthToken(params: {
    deviceId: string;
    role: string;
    token: string;
    scopes?: string[];
    env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry;
export declare function clearDeviceAuthToken(params: {
    deviceId: string;
    role: string;
    env?: NodeJS.ProcessEnv;
}): void;
