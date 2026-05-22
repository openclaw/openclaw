import { E as OpenClawPluginDefinition, T as OpenClawPluginConfigSchema } from "../../types-wNLvWYuA.js";
//#region extensions/copilot-proxy/index.d.ts
declare const _default: {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
//#endregion
export { _default as default };