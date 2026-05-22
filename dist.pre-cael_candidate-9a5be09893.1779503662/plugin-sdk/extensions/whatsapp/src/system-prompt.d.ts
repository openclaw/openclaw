export declare function resolveWhatsAppGroupSystemPrompt(params: {
    accountConfig?: {
        groups?: Record<string, {
            systemPrompt?: string | null;
        }>;
    } | null;
    groupId?: string | null;
}): string | undefined;
export declare function resolveWhatsAppDirectSystemPrompt(params: {
    accountConfig?: {
        direct?: Record<string, {
            systemPrompt?: string | null;
        }>;
    } | null;
    peerId?: string | null;
}): string | undefined;
