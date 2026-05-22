import { C as OpenClawPluginApi, sn as ProviderPlugin } from "./types-UTp4ves_.js";
//#region extensions/anthropic/register.runtime.d.ts
declare function buildAnthropicProvider(): ProviderPlugin;
declare function registerAnthropicPlugin(api: OpenClawPluginApi): void;
//#endregion
export { registerAnthropicPlugin as n, buildAnthropicProvider as t };