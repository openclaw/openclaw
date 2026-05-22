import { C as OpenClawPluginDefinition, S as OpenClawPluginConfigSchema, g as OpenClawPluginApi } from "../../types-BYigPDoy.js";
//#region extensions/matrix/src/cli-metadata.d.ts
declare function registerMatrixCliMetadata(api: OpenClawPluginApi): void;
//#endregion
//#region extensions/matrix/cli-metadata.d.ts
declare const _default: {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
//#endregion
export { _default as default, registerMatrixCliMetadata };