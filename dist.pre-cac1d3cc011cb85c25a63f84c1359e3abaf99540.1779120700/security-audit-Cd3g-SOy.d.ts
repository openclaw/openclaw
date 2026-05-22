import { i as OpenClawConfig } from "./types.openclaw-C58U02FA.js";
import { t as ResolvedDiscordAccount } from "./accounts-Dn0bnl_o.js";

//#region extensions/discord/src/security-audit.d.ts
declare function collectDiscordSecurityAuditFindings(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  account: ResolvedDiscordAccount;
  orderedAccountIds: string[];
  hasExplicitAccountPath: boolean;
}): Promise<{
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
}[]>;
//#endregion
export { collectDiscordSecurityAuditFindings as t };