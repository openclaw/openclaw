export declare const GATEWAY_CLIENT_IDS: {
    readonly WEBCHAT_UI: "webchat-ui";
    readonly CONTROL_UI: "openclaw-control-ui";
    readonly WEBCHAT: "webchat";
    readonly CLI: "cli";
    readonly GATEWAY_CLIENT: "gateway-client";
    readonly MACOS_APP: "openclaw-macos";
    readonly IOS_APP: "openclaw-ios";
    readonly ANDROID_APP: "openclaw-android";
    readonly NODE_HOST: "node-host";
    readonly TEST: "test";
    readonly FINGERPRINT: "fingerprint";
    readonly PROBE: "openclaw-probe";
};
export type GatewayClientId = (typeof GATEWAY_CLIENT_IDS)[keyof typeof GATEWAY_CLIENT_IDS];
export declare const GATEWAY_CLIENT_NAMES: {
    readonly WEBCHAT_UI: "webchat-ui";
    readonly CONTROL_UI: "openclaw-control-ui";
    readonly WEBCHAT: "webchat";
    readonly CLI: "cli";
    readonly GATEWAY_CLIENT: "gateway-client";
    readonly MACOS_APP: "openclaw-macos";
    readonly IOS_APP: "openclaw-ios";
    readonly ANDROID_APP: "openclaw-android";
    readonly NODE_HOST: "node-host";
    readonly TEST: "test";
    readonly FINGERPRINT: "fingerprint";
    readonly PROBE: "openclaw-probe";
};
export type GatewayClientName = GatewayClientId;
export declare const GATEWAY_CLIENT_MODES: {
    readonly WEBCHAT: "webchat";
    readonly CLI: "cli";
    readonly UI: "ui";
    readonly BACKEND: "backend";
    readonly NODE: "node";
    readonly PROBE: "probe";
    readonly TEST: "test";
};
export type GatewayClientMode = (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];
export type GatewayClientInfo = {
    id: GatewayClientId;
    displayName?: string;
    version: string;
    platform: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    mode: GatewayClientMode;
    instanceId?: string;
};
export declare const GATEWAY_CLIENT_CAPS: {
    readonly TOOL_EVENTS: "tool-events";
};
export type GatewayClientCap = (typeof GATEWAY_CLIENT_CAPS)[keyof typeof GATEWAY_CLIENT_CAPS];
export declare function normalizeGatewayClientId(raw?: string | null): GatewayClientId | undefined;
export declare function normalizeGatewayClientName(raw?: string | null): GatewayClientName | undefined;
export declare function normalizeGatewayClientMode(raw?: string | null): GatewayClientMode | undefined;
export declare function hasGatewayClientCap(caps: string[] | null | undefined, cap: GatewayClientCap): boolean;
