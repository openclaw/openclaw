//#region src/infra/system-message.d.ts
declare const SYSTEM_MARK = "\u2699\uFE0F";
declare function hasSystemMark(text: string): boolean;
declare function prefixSystemMessage(text: string): string;
//#endregion
export { hasSystemMark as n, prefixSystemMessage as r, SYSTEM_MARK as t };