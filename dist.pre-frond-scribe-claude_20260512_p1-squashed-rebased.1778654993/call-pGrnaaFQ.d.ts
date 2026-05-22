import { i as OpenClawConfig } from "./types.openclaw-BdSNxnBz.js";
import { n as GatewayClientName, t as GatewayClientMode } from "./client-info-Bai36TcT.js";
import { i as DeviceIdentity } from "./client-Da50VkV-.js";
import { Go as OperatorScope } from "./index-BiA_1_q_.js";

//#region src/gateway/call.d.ts
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
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
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