import { C as OpenClawPluginApi, H as OpenClawPluginNodeHostCommand, Z as OpenClawPluginSecurityAuditCollector } from "../../types-Vx7Jq4_-2.js";
//#region extensions/browser/plugin-registration.d.ts
declare const browserPluginReload: {
  restartPrefixes: string[];
};
declare const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[];
declare const browserSecurityAuditCollectors: OpenClawPluginSecurityAuditCollector[];
declare function registerBrowserPlugin(api: OpenClawPluginApi): void;
//#endregion
export { browserPluginNodeHostCommands, browserPluginReload, browserSecurityAuditCollectors, registerBrowserPlugin };