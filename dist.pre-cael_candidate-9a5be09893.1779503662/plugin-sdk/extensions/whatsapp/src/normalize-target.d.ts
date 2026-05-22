export declare function isWhatsAppGroupJid(value: string): boolean;
export declare function isWhatsAppNewsletterJid(value: string): boolean;
export declare function isWhatsAppUserTarget(value: string): boolean;
export declare function normalizeWhatsAppTarget(value: string): string | null;
export declare function normalizeWhatsAppMessagingTarget(raw: string): string | undefined;
export declare function normalizeWhatsAppAllowFromEntries(allowFrom: Array<string | number>): string[];
export declare function normalizeWhatsAppAllowFromEntry(entry: string): string | null;
export declare function looksLikeWhatsAppTargetId(raw: string): boolean;
