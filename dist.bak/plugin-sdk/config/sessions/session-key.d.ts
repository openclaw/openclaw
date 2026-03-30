import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionScope } from "./types.js";
export declare function deriveSessionKey(scope: SessionScope, ctx: MsgContext): string;
/**
 * Resolve the session key with a canonical direct-chat bucket (default: "main").
 * All non-group direct chats collapse to this bucket; groups stay isolated.
 */
export declare function resolveSessionKey(scope: SessionScope, ctx: MsgContext, mainKey?: string): string;
