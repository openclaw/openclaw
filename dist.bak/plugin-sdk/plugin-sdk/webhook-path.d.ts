export declare function normalizeWebhookPath(raw: string): string;
export declare function resolveWebhookPath(params: {
    webhookPath?: string;
    webhookUrl?: string;
    defaultPath?: string | null;
}): string | null;
