/** Normalize webhook paths into the canonical registry form used by route lookup. */
export declare function normalizeWebhookPath(raw: string): string;
/** Resolve the effective webhook path from explicit path, URL, or default fallback. */
export declare function resolveWebhookPath(params: {
    webhookPath?: string;
    webhookUrl?: string;
    defaultPath?: string | null;
}): string | null;
