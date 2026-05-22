import { C as OpenClawPluginApi, H as OpenClawPluginNodeHostCommand, Z as OpenClawPluginSecurityAuditCollector } from "../../types-Dw7_sm4q.js";
//#region extensions/browser/plugin-registration.d.ts
declare const browserPluginReload: {
  restartPrefixes: string[];
};
declare const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[];
declare const browserSecurityAuditCollectors: OpenClawPluginSecurityAuditCollector[];
declare function registerBrowserPlugin(api: OpenClawPluginApi): void;
//#endregion
export { browserPluginNodeHostCommands, browserPluginReload, browserSecurityAuditCollectors, registerBrowserPlugin };