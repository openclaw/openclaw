import { i as OpenClawConfig } from "./types.openclaw-BdZr8Ncl.js";
import { T as ReplyToMode, _ as GroupPolicy, h as DmPolicy } from "./types.base-BUAA7yMj.js";
import { t as WhatsAppAccountConfig } from "./account-types-DV84RKUy.js";

//#region extensions/whatsapp/src/account-ids.d.ts
declare const listConfiguredAccountIds: (cfg: OpenClawConfig) => string[], listAccountIds: (cfg: OpenClawConfig) => string[], resolveDefaultWhatsAppAccountId: (cfg: OpenClawConfig) => string;
//#endregion
//#region extensions/whatsapp/src/accounts.d.ts
type ResolvedWhatsAppAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  sendReadReceipts: boolean;
  messagePrefix?: string;
  defaultTo?: string;
  authDir: string;
  isLegacyAuthDir: boolean;
  selfChatMode?: boolean;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: GroupPolicy;
  dmPolicy?: DmPolicy;
  historyLimit?: number;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
  blockStreaming?: boolean;
  ackReaction?: WhatsAppAccountConfig["ackReaction"];
  reactionLevel?: WhatsAppAccountConfig["reactionLevel"];
  groups?: WhatsAppAccountConfig["groups"];
  direct?: WhatsAppAccountConfig["direct"];
  debounceMs?: number;
  replyToMode?: ReplyToMode;
};
declare const DEFAULT_WHATSAPP_MEDIA_MAX_MB = 50;
declare function listWhatsAppAuthDirs(cfg: OpenClawConfig): string[];
declare function hasAnyWhatsAppAuth(cfg: OpenClawConfig): boolean;
declare function resolveWhatsAppAuthDir(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): {
  authDir: string;
  isLegacy: boolean;
};
declare function resolveWhatsAppAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWhatsAppAccount;
declare function resolveWhatsAppMediaMaxBytes(account: Pick<ResolvedWhatsAppAccount, "mediaMaxMb">): number;
declare function listEnabledWhatsAppAccounts(cfg: OpenClawConfig): ResolvedWhatsAppAccount[];
//#endregion
export { listWhatsAppAuthDirs as a, resolveWhatsAppMediaMaxBytes as c, listEnabledWhatsAppAccounts as i, listAccountIds as l, ResolvedWhatsAppAccount as n, resolveWhatsAppAccount as o, hasAnyWhatsAppAuth as r, resolveWhatsAppAuthDir as s, DEFAULT_WHATSAPP_MEDIA_MAX_MB as t, resolveDefaultWhatsAppAccountId as u };