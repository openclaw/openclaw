import { ut as GoogleChatAccountConfig } from "./types.channels-qd_8k3sY.js";
//#region extensions/googlechat/src/accounts.d.ts
type GoogleChatCredentialSource = "file" | "inline" | "env" | "none";
type ResolvedGoogleChatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: GoogleChatAccountConfig;
  credentialSource: GoogleChatCredentialSource;
  credentials?: Record<string, unknown>;
  credentialsFile?: string;
};
//#endregion
export { ResolvedGoogleChatAccount as t };