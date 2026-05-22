import { i as OpenClawConfig } from "./types.openclaw-DNoZmPZ8.js";
import { gt as DiscordActionConfig, ht as DiscordAccountConfig } from "./types.channels-B3ouN96p.js";
import { t as DiscordCredentialStatus } from "./token-KtIQ1e-n.js";

//#region extensions/discord/src/accounts.d.ts
type ResolvedDiscordAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "config" | "none";
  tokenStatus: DiscordCredentialStatus;
  config: DiscordAccountConfig;
};
declare const listDiscordAccountIds: (cfg: OpenClawConfig) => string[];
declare const resolveDefaultDiscordAccountId: (cfg: OpenClawConfig) => string;
declare function resolveDiscordAccountConfig(cfg: OpenClawConfig, accountId: string): DiscordAccountConfig | undefined;
declare function mergeDiscordAccountConfig(cfg: OpenClawConfig, accountId: string): DiscordAccountConfig;
declare function createDiscordActionGate(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): (key: keyof DiscordActionConfig, defaultValue?: boolean) => boolean;
declare function resolveDiscordAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDiscordAccount;
declare function resolveDiscordMaxLinesPerMessage(params: {
  cfg: OpenClawConfig;
  discordConfig?: DiscordAccountConfig | null;
  accountId?: string | null;
}): number | undefined;
declare function listEnabledDiscordAccounts(cfg: OpenClawConfig): ResolvedDiscordAccount[];
//#endregion
export { mergeDiscordAccountConfig as a, resolveDiscordAccountConfig as c, listEnabledDiscordAccounts as i, resolveDiscordMaxLinesPerMessage as l, createDiscordActionGate as n, resolveDefaultDiscordAccountId as o, listDiscordAccountIds as r, resolveDiscordAccount as s, ResolvedDiscordAccount as t };