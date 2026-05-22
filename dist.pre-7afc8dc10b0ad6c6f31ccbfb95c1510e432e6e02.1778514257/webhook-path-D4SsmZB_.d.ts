//#region src/plugin-sdk/webhook-path.d.ts
/** Normalize webhook paths into the canonical registry form used by route lookup. */
declare function normalizeWebhookPath(raw: string): string;
/** Resolve the effective webhook path from explicit path, URL, or default fallback. */
declare function resolveWebhookPath(params: {
  webhookPath?: string;
  webhookUrl?: string;
  defaultPath?: string | null;
}): string | null;
//#endregion
export { resolveWebhookPath as n, normalizeWebhookPath as t };