import type { SessionManager } from "@mariozechner/pi-coding-agent";
/**
 * Return the unguarded appendMessage implementation for a session manager.
 */
export declare function getRawSessionAppendMessage(sessionManager: SessionManager): SessionManager["appendMessage"];
export declare function setRawSessionAppendMessage(sessionManager: SessionManager, appendMessage: SessionManager["appendMessage"]): void;
