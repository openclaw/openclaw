/**
 * @deprecated Compatibility subpath. Import webhook path helpers from
 * `openclaw/plugin-sdk/webhook-ingress` instead.
 */
/** @deprecated Import from `openclaw/plugin-sdk/webhook-ingress` instead. */
export declare function normalizeWebhookPath(raw: string): string;
/** @deprecated Import from `openclaw/plugin-sdk/webhook-ingress` instead. */
export declare function resolveWebhookPath(params: {
    webhookPath?: string;
    webhookUrl?: string;
    defaultPath?: string | null;
}): string | null;
