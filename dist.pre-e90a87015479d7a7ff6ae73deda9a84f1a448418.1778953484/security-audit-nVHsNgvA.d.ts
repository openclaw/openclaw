import { i as OpenClawConfig } from "./types.openclaw-DNoZmPZ8.js";
import { t as ResolvedSlackAccount } from "./accounts-BMIuQygD.js";
//#region extensions/slack/src/security-audit.d.ts
declare function collectSlackSecurityAuditFindings(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  account: ResolvedSlackAccount;
}): Promise<{
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
}[]>;
//#endregion
export { collectSlackSecurityAuditFindings as t };