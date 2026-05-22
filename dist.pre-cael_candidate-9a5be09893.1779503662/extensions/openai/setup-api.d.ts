import { A as OpenClawPluginDefinition, k as OpenClawPluginConfigSchema, sn as ProviderPlugin } from "../../types-DdTQpZSH.js";
//#region extensions/openai/setup-api.d.ts
declare function buildOpenAISetupProvider(): ProviderPlugin;
declare function buildOpenAICodexSetupProvider(): ProviderPlugin;
declare const _default: {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
//#endregion
export { buildOpenAICodexSetupProvider, buildOpenAISetupProvider, _default as default };