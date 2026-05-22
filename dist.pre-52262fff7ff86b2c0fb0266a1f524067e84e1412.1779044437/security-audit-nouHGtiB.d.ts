import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { t as ResolvedTelegramAccount } from "./accounts-AwZ4p-qv.js";

//#region extensions/telegram/src/security-audit.d.ts
declare function collectTelegramSecurityAuditFindings(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  account: ResolvedTelegramAccount;
}): Promise<{
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
}[]>;
//#endregion
export { collectTelegramSecurityAuditFindings as t };