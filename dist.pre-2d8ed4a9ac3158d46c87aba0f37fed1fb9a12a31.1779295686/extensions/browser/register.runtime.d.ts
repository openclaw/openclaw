import { Q as OpenClawPluginSecurityAuditContext } from "../../types-D0OCNFd4.js";
import { b as runBrowserProxyCommand } from "../../browser-runtime-nDdErBed.js";
import { i as createBrowserTool, r as handleBrowserGatewayRequest, t as createBrowserPluginService } from "../../plugin-service-CKMomafY.js";

//#region extensions/browser/src/security-audit.d.ts
declare function collectBrowserSecurityAuditFindings(ctx: OpenClawPluginSecurityAuditContext): {
  checkId: string;
  severity: "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
}[];
//#endregion
export { collectBrowserSecurityAuditFindings, createBrowserPluginService, createBrowserTool, handleBrowserGatewayRequest, runBrowserProxyCommand };