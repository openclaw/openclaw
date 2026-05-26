import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as GatewayClientName, t as GatewayClientMode } from "./client-info-Bg3dBQ8F.js";
import { a as DeviceIdentity, r as GatewayClientRequestOptions } from "./client-DiDZFgqH.js";
import { Go as OperatorScope } from "./index-CaLNQFzV.js";

//#region src/gateway/call.d.ts
type GatewayRequestFunction = <T = Record<string, unknown>>(method: string, params?: unknown, opts?: GatewayClientRequestOptions) => Promise<T>;
type CallGatewayBaseOptions = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  config?: OpenClawConfig;
  method: string;
  params?: unknown;
  expectFinal?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onAccepted?: GatewayClientRequestOptions["onAccepted"];
  onSignalAbort?: (request: GatewayRequestFunction) => Promise<void> | void;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  approvalRuntimeToken?: string;
  deviceIdentity?: DeviceIdentity | null;
  instanceId?: string;
  minProtocol?: number;
  maxProtocol?: number;
  requiredMethods?: string[];
  /**
   * Overrides the config path shown in connection error details.
   * Does not affect config loading; callers still control auth via opts.token/password/env/config.
   */
  configPath?: string;
};
type CallGatewayOptions = CallGatewayBaseOptions & {
  scopes?: OperatorScope[];
};
declare function callGateway<T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T>;
//#endregion
export { callGateway as t };