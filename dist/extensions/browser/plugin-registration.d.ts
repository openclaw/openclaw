import { K as OpenClawPluginSecurityAuditCollector, L as OpenClawPluginNodeHostCommand, v as OpenClawPluginApi } from "../../types-lCXG2pW_.js";
//#region extensions/browser/plugin-registration.d.ts
declare const browserPluginReload: {
  restartPrefixes: string[];
};
declare const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[];
declare const browserSecurityAuditCollectors: OpenClawPluginSecurityAuditCollector[];
declare function registerBrowserPlugin(api: OpenClawPluginApi): void;
//#endregion
export { browserPluginNodeHostCommands, browserPluginReload, browserSecurityAuditCollectors, registerBrowserPlugin };