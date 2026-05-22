//#region src/auto-reply/tokens.d.ts
declare const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
declare const SILENT_REPLY_TOKEN = "NO_REPLY";
declare function isSilentReplyText(text: string | undefined, token?: string): boolean;
declare function isSilentReplyPayloadText(text: string | undefined, token?: string): boolean;
//#endregion
export { isSilentReplyText as i, SILENT_REPLY_TOKEN as n, isSilentReplyPayloadText as r, HEARTBEAT_TOKEN as t };