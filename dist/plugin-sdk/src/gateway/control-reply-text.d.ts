/**
 * Return true when a chat-visible reply is exactly an internal control token.
 */
export declare function isSuppressedControlReplyText(text: string): boolean;
/**
 * Return true when streamed assistant text looks like the leading fragment of a control token.
 */
export declare function isSuppressedControlReplyLeadFragment(text: string): boolean;
