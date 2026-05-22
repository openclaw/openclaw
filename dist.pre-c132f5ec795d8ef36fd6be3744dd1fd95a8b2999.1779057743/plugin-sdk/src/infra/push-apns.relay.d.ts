import type { GatewayConfig } from "../config/types.gateway.js";
import { type DeviceIdentity } from "./device-identity.js";
type ApnsRelayPushType = "alert" | "background";
export type ApnsRelayConfig = {
    baseUrl: string;
    timeoutMs: number;
};
type ApnsRelayConfigResolution = {
    ok: true;
    value: ApnsRelayConfig;
} | {
    ok: false;
    error: string;
};
export type ApnsRelayPushResponse = {
    ok: boolean;
    status: number;
    apnsId?: string;
    reason?: string;
    environment: "production";
    tokenSuffix?: string;
};
export type ApnsRelayRequestSender = (params: {
    relayConfig: ApnsRelayConfig;
    sendGrant: string;
    relayHandle: string;
    gatewayDeviceId: string;
    signature: string;
    signedAtMs: number;
    bodyJson: string;
    pushType: ApnsRelayPushType;
    priority: "10" | "5";
    payload: object;
}) => Promise<ApnsRelayPushResponse>;
export declare function resolveApnsRelayConfigFromEnv(env?: NodeJS.ProcessEnv, gatewayConfig?: GatewayConfig): ApnsRelayConfigResolution;
export declare function sendApnsRelayPush(params: {
    relayConfig: ApnsRelayConfig;
    sendGrant: string;
    relayHandle: string;
    pushType: ApnsRelayPushType;
    priority: "10" | "5";
    payload: object;
    gatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
    requestSender?: ApnsRelayRequestSender;
}): Promise<ApnsRelayPushResponse>;
export {};
