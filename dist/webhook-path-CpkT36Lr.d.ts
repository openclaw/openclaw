//#region src/plugin-sdk/webhook-path.d.ts
/**
 * @deprecated Compatibility subpath. Import webhook path helpers from
 * `openclaw/plugin-sdk/webhook-ingress` instead.
 */
/** @deprecated Import from `openclaw/plugin-sdk/webhook-ingress` instead. */
declare function normalizeWebhookPath(raw: string): string;
/** @deprecated Import from `openclaw/plugin-sdk/webhook-ingress` instead. */
declare function resolveWebhookPath(params: {
  webhookPath?: string;
  webhookUrl?: string;
  defaultPath?: string | null;
}): string | null;
//#endregion
export { resolveWebhookPath as n, normalizeWebhookPath as t };