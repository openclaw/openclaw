import { T as OpenClawPluginDefinition, w as OpenClawPluginConfigSchema } from "../../types-DzNNj7u7.js";
//#region extensions/voice-call/setup-api.d.ts
declare const _default: {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
//#endregion
export { _default as default };