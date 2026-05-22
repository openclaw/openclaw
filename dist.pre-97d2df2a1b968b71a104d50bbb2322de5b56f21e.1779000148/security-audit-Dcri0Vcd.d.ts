import { t as ResolvedSynologyChatAccount } from "./types-C2M4uAFF.js";

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