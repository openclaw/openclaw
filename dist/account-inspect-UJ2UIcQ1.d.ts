import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { _ as TelegramAccountConfig } from "./types.channels-qd_8k3sY.js";
//#region extensions/telegram/src/account-inspect.d.ts
type TelegramCredentialStatus = "available" | "configured_unavailable" | "missing";
type InspectedTelegramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  tokenStatus: TelegramCredentialStatus;
  configured: boolean;
  config: TelegramAccountConfig;
};
declare function inspectTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envToken?: string | null;
}): InspectedTelegramAccount;
//#endregion
export { TelegramCredentialStatus as n, inspectTelegramAccount as r, InspectedTelegramAccount as t };