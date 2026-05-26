import { Q as OpenClawPluginSecurityAuditContext } from "../../types-Vx7Jq4_-2.js";
import { b as runBrowserProxyCommand } from "../../browser-runtime-CUz1Ea0r.js";
import { i as createBrowserTool, r as handleBrowserGatewayRequest, t as createBrowserPluginService } from "../../plugin-service-gYiaqMTg.js";

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