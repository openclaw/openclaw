import { A as OpenClawPluginDefinition, k as OpenClawPluginConfigSchema } from "../../types-Vx7Jq4_-2.js";
//#region extensions/canvas/index.d.ts
declare const _default: {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
//#endregion
export { _default as default };