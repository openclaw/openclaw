export declare function extractTextFromChatContent(content: unknown, opts?: {
    sanitizeText?: (text: string) => string;
    joinWith?: string;
    normalizeText?: (text: string) => string;
}): string | null;
