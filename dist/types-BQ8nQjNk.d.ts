//#region extensions/synology-chat/src/types.d.ts
type SynologyWebhookPathSource = "default" | "inherited-base" | "explicit";
/** Fully resolved account config with defaults applied */
interface ResolvedSynologyChatAccount {
  accountId: string;
  enabled: boolean;
  token: string;
  incomingUrl: string;
  nasHost: string;
  webhookPath: string;
  webhookPathSource: SynologyWebhookPathSource;
  dangerouslyAllowNameMatching: boolean;
  dangerouslyAllowInheritedWebhookPath: boolean;
  dmPolicy: "open" | "allowlist" | "disabled";
  allowedUserIds: string[];
  rateLimitPerMinute: number;
  botName: string;
  allowInsecureSsl: boolean;
}
//#endregion
export { ResolvedSynologyChatAccount as t };