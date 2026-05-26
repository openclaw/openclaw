export declare const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export declare const SILENT_REPLY_TOKEN = "NO_REPLY";
export declare function isSilentReplyText(text: string | undefined, token?: string): boolean;
export declare function isSilentReplyPayloadText(text: string | undefined, token?: string): boolean;
/**
 * Strip a trailing silent reply token from mixed-content text.
 * Returns the remaining text with the token removed (trimmed).
 * If the result is empty, the entire message should be treated as silent.
 */
export declare function stripSilentToken(text: string, token?: string): string;
/**
 * Strip leading silent reply tokens from text.
 * Handles cases like "NO_REPLYThe user is saying..." where the token
 * is not separated from the following text.
 */
export declare function stripLeadingSilentToken(text: string, token?: string): string;
/**
 * Check whether text starts with one or more leading silent reply tokens where
 * the final token is glued directly to visible content.
 */
export declare function startsWithSilentToken(text: string | undefined, token?: string): boolean;
export declare function isSilentReplyPrefixText(text: string | undefined, token?: string): boolean;
