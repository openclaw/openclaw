import { A as OpenClawPluginDefinition, k as OpenClawPluginConfigSchema } from "../../types-B1YsHkjI.js";
//#region extensions/memory-wiki/setup-api.d.ts
declare const _default: {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
//#endregion
export { _default as default };