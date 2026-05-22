import { it as PluginHookReplyDispatchResult, nt as PluginHookReplyDispatchContext, rt as PluginHookReplyDispatchEvent } from "./hook-types-AyXrRN7k.js";

//#region src/plugin-sdk/acp-runtime-backend.d.ts
declare function tryDispatchAcpReplyHook(event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext): Promise<PluginHookReplyDispatchResult | void>;
//#endregion
export { tryDispatchAcpReplyHook as t };