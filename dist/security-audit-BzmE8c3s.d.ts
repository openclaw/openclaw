import { o as ResolvedZalouserAccount } from "./accounts-BB2QBzNe.js";

//#region extensions/zalouser/src/security-audit.d.ts
declare function isZalouserMutableGroupEntry(raw: string): boolean;
declare function collectZalouserSecurityAuditFindings(params: {
  accountId?: string | null;
  account: ResolvedZalouserAccount;
  orderedAccountIds: string[];
  hasExplicitAccountPath: boolean;
}): {
  checkId: string;
  severity: "info" | "warn";
  title: string;
  detail: string;
  remediation: string;
}[];
//#endregion
export { isZalouserMutableGroupEntry as n, collectZalouserSecurityAuditFindings as t };