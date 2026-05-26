import { n as AzAccount, t as AzAccessToken } from "./shared-FgR3yAtS.js";

//#region extensions/microsoft-foundry/cli.d.ts
declare function execAz(args: string[]): string;
declare function isAzCliInstalled(): boolean;
declare function getLoggedInAccount(): AzAccount | null;
declare function listSubscriptions(): AzAccount[];
type AccessTokenParams = {
  subscriptionId?: string;
  tenantId?: string;
};
declare function getAccessTokenResult(params?: AccessTokenParams): AzAccessToken;
declare function getAccessTokenResultAsync(params?: AccessTokenParams): Promise<AzAccessToken>;
declare function azLoginDeviceCode(): Promise<void>;
declare function azLoginDeviceCodeWithOptions(params: {
  tenantId?: string;
  allowNoSubscriptions?: boolean;
}): Promise<void>;
//#endregion
export { getAccessTokenResultAsync as a, listSubscriptions as c, getAccessTokenResult as i, azLoginDeviceCodeWithOptions as n, getLoggedInAccount as o, execAz as r, isAzCliInstalled as s, azLoginDeviceCode as t };