export declare function isWhatsAppGroupJid(value: string): boolean;
/**
 * Check if value looks like a WhatsApp user target (e.g. "41796666864:0@s.whatsapp.net" or "123@lid").
 */
export declare function isWhatsAppUserTarget(value: string): boolean;
export declare function normalizeWhatsAppTarget(value: string): string | null;
