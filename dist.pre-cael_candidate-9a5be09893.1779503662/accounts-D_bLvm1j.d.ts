import { ft as GoogleChatAccountConfig } from "./types.channels-C67UBRPK.js";
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