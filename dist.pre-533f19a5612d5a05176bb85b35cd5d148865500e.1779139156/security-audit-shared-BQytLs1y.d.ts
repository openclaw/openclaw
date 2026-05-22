import { i as OpenClawConfig } from "./types.openclaw-Bpxi7OSY.js";
//#region extensions/feishu/src/security-audit-shared.d.ts
declare function collectFeishuSecurityAuditFindings(params: {
  cfg: OpenClawConfig;
}): {
  checkId: string;
  severity: "warn";
  title: string;
  detail: string;
  remediation: string;
}[];
//#endregion
export { collectFeishuSecurityAuditFindings as t };