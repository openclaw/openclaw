import type { DeviceIdentity } from "./device-identity.js";
import { type ApnsRelayConfig, type ApnsRelayRequestSender, resolveApnsRelayConfigFromEnv } from "./push-apns.relay.js";
type ApnsEnvironment = "sandbox" | "production";
type ApnsTransport = "direct" | "relay";
type DirectApnsRegistration = {
    nodeId: string;
    transport: "direct";
    token: string;
    topic: string;
    environment: ApnsEnvironment;
    updatedAtMs: number;
};
type RelayApnsRegistration = {
    nodeId: string;
    transport: "relay";
    relayHandle: string;
    sendGrant: string;
    installationId: string;
    topic: string;
    environment: "production";
    distribution: "official";
    updatedAtMs: number;
    tokenDebugSuffix?: string;
};
export type ApnsRegistration = DirectApnsRegistration | RelayApnsRegistration;
export type ApnsAuthConfig = {
    teamId: string;
    keyId: string;
    privateKey: string;
};
type ApnsAuthConfigResolution = {
    ok: true;
    value: ApnsAuthConfig;
} | {
    ok: false;
    error: string;
};
export type ApnsPushResult = {
    ok: boolean;
    status: number;
    apnsId?: string;
    reason?: string;
    tokenSuffix: string;
    topic: string;
    environment: ApnsEnvironment;
    transport: ApnsTransport;
};
type ApnsPushAlertResult = ApnsPushResult;
type ApnsPushWakeResult = ApnsPushResult;
type ApnsPushType = "alert" | "background";
type ApnsRequestParams = {
    token: string;
    topic: string;
    environment: ApnsEnvironment;
    bearerToken: string;
    payload: object;
    timeoutMs: number;
    pushType: ApnsPushType;
    priority: "10" | "5";
};
type ApnsRequestResponse = {
    status: number;
    apnsId?: string;
    body: string;
};
type ApnsRequestSender = (params: ApnsRequestParams) => Promise<ApnsRequestResponse>;
type RegisterDirectApnsParams = {
    nodeId: string;
    transport?: "direct";
    token: string;
    topic: string;
    environment?: unknown;
    baseDir?: string;
};
type RegisterRelayApnsParams = {
    nodeId: string;
    transport: "relay";
    relayHandle: string;
    sendGrant: string;
    installationId: string;
    topic: string;
    environment?: unknown;
    distribution?: unknown;
    tokenDebugSuffix?: unknown;
    baseDir?: string;
};
type RegisterApnsParams = RegisterDirectApnsParams | RegisterRelayApnsParams;
export declare function normalizeApnsEnvironment(value: unknown): ApnsEnvironment | null;
export declare function registerApnsRegistration(params: RegisterApnsParams): Promise<ApnsRegistration>;
export declare function registerApnsToken(params: {
    nodeId: string;
    token: string;
    topic: string;
    environment?: unknown;
    baseDir?: string;
}): Promise<DirectApnsRegistration>;
export declare function loadApnsRegistration(nodeId: string, baseDir?: string): Promise<ApnsRegistration | null>;
export declare function clearApnsRegistration(nodeId: string, baseDir?: string): Promise<boolean>;
export declare function clearApnsRegistrationIfCurrent(params: {
    nodeId: string;
    registration: ApnsRegistration;
    baseDir?: string;
}): Promise<boolean>;
export declare function shouldInvalidateApnsRegistration(result: {
    status: number;
    reason?: string;
}): boolean;
export declare function shouldClearStoredApnsRegistration(params: {
    registration: ApnsRegistration;
    result: {
        status: number;
        reason?: string;
    };
    overrideEnvironment?: ApnsEnvironment | null;
}): boolean;
export declare function resolveApnsAuthConfigFromEnv(env?: NodeJS.ProcessEnv): Promise<ApnsAuthConfigResolution>;
type ApnsAlertCommonParams = {
    nodeId: string;
    title: string;
    body: string;
    timeoutMs?: number;
};
type DirectApnsAlertParams = ApnsAlertCommonParams & {
    registration: DirectApnsRegistration;
    auth: ApnsAuthConfig;
    requestSender?: ApnsRequestSender;
    relayConfig?: never;
    relayRequestSender?: never;
};
type RelayApnsAlertParams = ApnsAlertCommonParams & {
    registration: RelayApnsRegistration;
    relayConfig: ApnsRelayConfig;
    relayRequestSender?: ApnsRelayRequestSender;
    relayGatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
    auth?: never;
    requestSender?: never;
};
type ApnsBackgroundWakeCommonParams = {
    nodeId: string;
    wakeReason?: string;
    timeoutMs?: number;
};
type DirectApnsBackgroundWakeParams = ApnsBackgroundWakeCommonParams & {
    registration: DirectApnsRegistration;
    auth: ApnsAuthConfig;
    requestSender?: ApnsRequestSender;
    relayConfig?: never;
    relayRequestSender?: never;
};
type RelayApnsBackgroundWakeParams = ApnsBackgroundWakeCommonParams & {
    registration: RelayApnsRegistration;
    relayConfig: ApnsRelayConfig;
    relayRequestSender?: ApnsRelayRequestSender;
    relayGatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
    auth?: never;
    requestSender?: never;
};
type ApnsExecApprovalAlertCommonParams = {
    nodeId: string;
    approvalId: string;
    timeoutMs?: number;
};
type DirectApnsExecApprovalAlertParams = ApnsExecApprovalAlertCommonParams & {
    registration: DirectApnsRegistration;
    auth: ApnsAuthConfig;
    requestSender?: ApnsRequestSender;
    relayConfig?: never;
    relayRequestSender?: never;
};
type RelayApnsExecApprovalAlertParams = ApnsExecApprovalAlertCommonParams & {
    registration: RelayApnsRegistration;
    relayConfig: ApnsRelayConfig;
    relayRequestSender?: ApnsRelayRequestSender;
    relayGatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
    auth?: never;
    requestSender?: never;
};
type ApnsExecApprovalResolvedCommonParams = {
    nodeId: string;
    approvalId: string;
    timeoutMs?: number;
};
type DirectApnsExecApprovalResolvedParams = ApnsExecApprovalResolvedCommonParams & {
    registration: DirectApnsRegistration;
    auth: ApnsAuthConfig;
    requestSender?: ApnsRequestSender;
    relayConfig?: never;
    relayRequestSender?: never;
};
type RelayApnsExecApprovalResolvedParams = ApnsExecApprovalResolvedCommonParams & {
    registration: RelayApnsRegistration;
    relayConfig: ApnsRelayConfig;
    relayRequestSender?: ApnsRelayRequestSender;
    relayGatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
    auth?: never;
    requestSender?: never;
};
export declare function sendApnsAlert(params: DirectApnsAlertParams | RelayApnsAlertParams): Promise<ApnsPushAlertResult>;
export declare function sendApnsBackgroundWake(params: DirectApnsBackgroundWakeParams | RelayApnsBackgroundWakeParams): Promise<ApnsPushWakeResult>;
export declare function sendApnsExecApprovalAlert(params: DirectApnsExecApprovalAlertParams | RelayApnsExecApprovalAlertParams): Promise<ApnsPushAlertResult>;
export declare function sendApnsExecApprovalResolvedWake(params: DirectApnsExecApprovalResolvedParams | RelayApnsExecApprovalResolvedParams): Promise<ApnsPushWakeResult>;
export { type ApnsRelayConfig, resolveApnsRelayConfigFromEnv };
