export declare const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export declare const SILENT_REPLY_TOKEN = "NO_REPLY";
export declare function isSilentReplyText(text: string | undefined, token?: string): boolean;
/**
 * Strip a trailing silent reply token from mixed-content text.
 * Returns the remaining text with the token removed (trimmed).
 * If the result is empty, the entire message should be treated as silent.
 */
export declare function stripSilentToken(text: string, token?: string): string;
export declare function isSilentReplyPrefixText(text: string | undefined, token?: string): boolean;
