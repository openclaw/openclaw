import { q as OpenClawPluginSecurityAuditContext } from "../../types-lCXG2pW_.js";
import { b as runBrowserProxyCommand } from "../../browser-runtime-DxO67RAw.js";
import { i as createBrowserTool, r as handleBrowserGatewayRequest, t as createBrowserPluginService } from "../../plugin-service-DfoklqOx.js";

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