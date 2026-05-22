import { t as ResolvedSynologyChatAccount } from "./types-C21HA4t-.js";

//#region extensions/synology-chat/src/security-audit.d.ts
declare function collectSynologyChatSecurityAuditFindings(params: {
  accountId?: string | null;
  account: ResolvedSynologyChatAccount;
  orderedAccountIds: string[];
  hasExplicitAccountPath: boolean;
}): {
  checkId: string;
  severity: "info";
  title: string;
  detail: string;
  remediation: string;
}[];
//#endregion
export { collectSynologyChatSecurityAuditFindings as t };