import type { SessionManager } from "@mariozechner/pi-coding-agent";
declare const RAW_APPEND_MESSAGE: unique symbol;
export type SessionManagerWithRawAppend = SessionManager & {
    [RAW_APPEND_MESSAGE]?: SessionManager["appendMessage"];
};
/**
 * Return the unguarded appendMessage implementation for a session manager.
 */
export declare function getRawSessionAppendMessage(sessionManager: SessionManager): SessionManager["appendMessage"];
export declare function setRawSessionAppendMessage(sessionManager: SessionManager, appendMessage: SessionManager["appendMessage"]): void;
export {};
