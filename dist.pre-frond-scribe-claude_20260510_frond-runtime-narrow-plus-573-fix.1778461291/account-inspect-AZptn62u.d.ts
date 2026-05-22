import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { F as SlackAccountConfig } from "./types.channels-Df4-Bt6H.js";
import { l as SlackAccountSurfaceFields, n as SlackTokenSource } from "./accounts-DPsUsrfo.js";
//#region extensions/slack/src/account-inspect.d.ts
type SlackCredentialStatus = "available" | "configured_unavailable" | "missing";
type InspectedSlackAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  mode?: SlackAccountConfig["mode"];
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  signingSecretSource?: SlackTokenSource;
  userTokenSource: SlackTokenSource;
  botTokenStatus: SlackCredentialStatus;
  appTokenStatus: SlackCredentialStatus;
  signingSecretStatus?: SlackCredentialStatus;
  userTokenStatus: SlackCredentialStatus;
  configured: boolean;
  config: SlackAccountConfig;
} & SlackAccountSurfaceFields;
declare function inspectSlackAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envBotToken?: string | null;
  envAppToken?: string | null;
  envUserToken?: string | null;
}): InspectedSlackAccount;
//#endregion
export { SlackCredentialStatus as n, inspectSlackAccount as r, InspectedSlackAccount as t };