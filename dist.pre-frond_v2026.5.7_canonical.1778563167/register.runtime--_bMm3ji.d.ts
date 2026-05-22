import { nn as ProviderPlugin, v as OpenClawPluginApi } from "./types-D40p5jC7.js";
//#region extensions/anthropic/register.runtime.d.ts
declare function buildAnthropicProvider(): ProviderPlugin;
declare function registerAnthropicPlugin(api: OpenClawPluginApi): void;
//#endregion
export { registerAnthropicPlugin as n, buildAnthropicProvider as t };