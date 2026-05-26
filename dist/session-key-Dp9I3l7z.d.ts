import { s as SessionScope } from "./types-ChLEnNVH.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";

//#region src/config/sessions/session-key.d.ts
declare function deriveSessionKey(scope: SessionScope, ctx: MsgContext): string;
/**
 * Resolve the session key with a canonical direct-chat bucket (default: "main").
 * All non-group direct chats collapse to this bucket; groups stay isolated.
 */
declare function resolveSessionKey(scope: SessionScope, ctx: MsgContext, mainKey?: string, agentId?: string): string;
//#endregion
export { resolveSessionKey as n, deriveSessionKey as t };