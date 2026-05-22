import { nt as PluginHookReplyDispatchEvent, rt as PluginHookReplyDispatchResult, tt as PluginHookReplyDispatchContext } from "./hook-types-BtzgJ9oV.js";

//#region src/plugin-sdk/acp-runtime-backend.d.ts
declare function tryDispatchAcpReplyHook(event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext): Promise<PluginHookReplyDispatchResult | void>;
//#endregion
export { tryDispatchAcpReplyHook as t };