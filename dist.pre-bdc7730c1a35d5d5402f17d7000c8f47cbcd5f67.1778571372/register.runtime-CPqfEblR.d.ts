import { nn as ProviderPlugin, v as OpenClawPluginApi } from "./types-D1CySu2x.js";
//#region extensions/anthropic/register.runtime.d.ts
declare function buildAnthropicProvider(): ProviderPlugin;
declare function registerAnthropicPlugin(api: OpenClawPluginApi): void;
//#endregion
export { registerAnthropicPlugin as n, buildAnthropicProvider as t };