//#region extensions/whatsapp/src/normalize-target.d.ts
declare function isWhatsAppGroupJid(value: string): boolean;
declare function isWhatsAppUserTarget(value: string): boolean;
declare function normalizeWhatsAppTarget(value: string): string | null;
declare function normalizeWhatsAppMessagingTarget(raw: string): string | undefined;
declare function normalizeWhatsAppAllowFromEntries(allowFrom: Array<string | number>): string[];
declare function looksLikeWhatsAppTargetId(raw: string): boolean;
//#endregion
export { normalizeWhatsAppMessagingTarget as a, normalizeWhatsAppAllowFromEntries as i, isWhatsAppUserTarget as n, normalizeWhatsAppTarget as o, looksLikeWhatsAppTargetId as r, isWhatsAppGroupJid as t };