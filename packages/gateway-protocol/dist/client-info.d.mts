//#region packages/gateway-protocol/src/client-info.d.ts
declare const GATEWAY_CLIENT_IDS: {
  readonly WEBCHAT_UI: "webchat-ui";
  readonly CONTROL_UI: "openclaw-control-ui";
  readonly TUI: "openclaw-tui";
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
type GatewayClientId = (typeof GATEWAY_CLIENT_IDS)[keyof typeof GATEWAY_CLIENT_IDS];
declare const GATEWAY_CLIENT_NAMES: {
  readonly WEBCHAT_UI: "webchat-ui";
  readonly CONTROL_UI: "openclaw-control-ui";
  readonly TUI: "openclaw-tui";
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
type GatewayClientName = GatewayClientId;
declare const GATEWAY_CLIENT_MODES: {
  readonly WEBCHAT: "webchat";
  readonly CLI: "cli";
  readonly UI: "ui";
  readonly BACKEND: "backend";
  readonly NODE: "node";
  readonly PROBE: "probe";
  readonly TEST: "test";
};
type GatewayClientMode = (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];
type GatewayClientInfo = {
  id: GatewayClientId;
  displayName?: string;
  version: string;
  platform: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  mode: GatewayClientMode;
  instanceId?: string;
};
declare const GATEWAY_CLIENT_CAPS: {
  readonly TOOL_EVENTS: "tool-events";
};
type GatewayClientCap = (typeof GATEWAY_CLIENT_CAPS)[keyof typeof GATEWAY_CLIENT_CAPS];
declare function normalizeGatewayClientId(raw?: string | null): GatewayClientId | undefined;
declare function normalizeGatewayClientName(raw?: string | null): GatewayClientName | undefined;
declare function normalizeGatewayClientMode(raw?: string | null): GatewayClientMode | undefined;
declare function hasGatewayClientCap(caps: string[] | null | undefined, cap: GatewayClientCap): boolean;
//#endregion
export { GATEWAY_CLIENT_CAPS, GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES, GatewayClientCap, GatewayClientId, GatewayClientInfo, GatewayClientMode, GatewayClientName, hasGatewayClientCap, normalizeGatewayClientId, normalizeGatewayClientMode, normalizeGatewayClientName };