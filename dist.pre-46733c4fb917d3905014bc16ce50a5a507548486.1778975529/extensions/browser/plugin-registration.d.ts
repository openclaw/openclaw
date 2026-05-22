import { R as OpenClawPluginNodeHostCommand, q as OpenClawPluginSecurityAuditCollector, y as OpenClawPluginApi } from "../../types-Dggwf5Fv.js";
//#region extensions/browser/plugin-registration.d.ts
declare const browserPluginReload: {
  restartPrefixes: string[];
};
declare const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[];
declare const browserSecurityAuditCollectors: OpenClawPluginSecurityAuditCollector[];
declare function registerBrowserPlugin(api: OpenClawPluginApi): void;
//#endregion
export { browserPluginNodeHostCommands, browserPluginReload, browserSecurityAuditCollectors, registerBrowserPlugin };