export declare const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export declare const SILENT_REPLY_TOKEN = "NO_REPLY";
export declare function isSilentReplyText(text: string | undefined, token?: string): boolean;
export declare function isSilentReplyPrefixText(text: string | undefined, token?: string): boolean;
