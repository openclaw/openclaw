import { J as OpenClawPluginService, v as OpenClawPluginApi } from "../../types-lCXG2pW_.js";
//#region extensions/device-pair/notify.d.ts
type PendingPairingRequest = {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  ts?: number;
};
declare function formatPendingRequests(pending: PendingPairingRequest[]): string;
declare function armPairNotifyOnce(params: {
  api: OpenClawPluginApi;
  ctx: {
    channel: string;
    senderId?: string;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: string | number;
  };
}): Promise<boolean>;
declare function handleNotifyCommand(params: {
  api: OpenClawPluginApi;
  ctx: {
    channel: string;
    senderId?: string;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: string | number;
  };
  action: string;
}): Promise<{
  text: string;
}>;
declare function createPairingNotifierService(api: OpenClawPluginApi): OpenClawPluginService;
declare function registerPairingNotifierService(api: OpenClawPluginApi): void;
//#endregion
export { armPairNotifyOnce, createPairingNotifierService, formatPendingRequests, handleNotifyCommand, registerPairingNotifierService };