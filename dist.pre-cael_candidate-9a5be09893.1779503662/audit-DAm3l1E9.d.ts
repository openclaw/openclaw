import { D as TelegramGroupConfig, k as TelegramNetworkConfig } from "./types.channels-C67UBRPK.js";
//#region extensions/telegram/src/audit.types.d.ts
type TelegramGroupMembershipAuditEntry = {
  chatId: string;
  ok: boolean;
  status?: string | null;
  error?: string | null;
  matchKey?: string;
  matchSource?: "id";
};
type TelegramGroupMembershipAudit = {
  ok: boolean;
  checkedGroups: number;
  unresolvedGroups: number;
  hasWildcardUnmentionedGroups: boolean;
  groups: TelegramGroupMembershipAuditEntry[];
  elapsedMs: number;
};
type AuditTelegramGroupMembershipParams = {
  token: string;
  botId: number;
  groupIds: string[];
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
  apiRoot?: string;
  timeoutMs: number;
};
//#endregion
//#region extensions/telegram/src/audit.d.ts
declare function collectTelegramUnmentionedGroupIds(groups: Record<string, TelegramGroupConfig> | undefined): {
  groupIds: string[];
  unresolvedGroups: number;
  hasWildcardUnmentionedGroups: boolean;
};
declare function auditTelegramGroupMembership(params: AuditTelegramGroupMembershipParams): Promise<TelegramGroupMembershipAudit>;
//#endregion
export { TelegramGroupMembershipAuditEntry as a, TelegramGroupMembershipAudit as i, collectTelegramUnmentionedGroupIds as n, AuditTelegramGroupMembershipParams as r, auditTelegramGroupMembership as t };