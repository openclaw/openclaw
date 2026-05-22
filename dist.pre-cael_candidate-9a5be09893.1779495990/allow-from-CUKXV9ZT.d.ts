//#region extensions/telegram/src/allow-from.d.ts
declare function normalizeTelegramAllowFromEntry(raw: unknown): string;
declare function isNumericTelegramUserId(raw: string): boolean;
declare function isNumericTelegramSenderUserId(raw: string): boolean;
//#endregion
export { isNumericTelegramUserId as n, normalizeTelegramAllowFromEntry as r, isNumericTelegramSenderUserId as t };