// Feishu webhook paths normalize trusted operator configuration into HTTP request targets.
export const DEFAULT_FEISHU_WEBHOOK_PATH = "/feishu/events";

/** Normalize trusted configuration only; incoming request targets must remain unmodified. */
export function normalizeFeishuWebhookPath(value?: string): string | null {
  const configured = value?.trim();
  if (!configured) {
    return DEFAULT_FEISHU_WEBHOOK_PATH;
  }

  const parsed = URL.parse(configured, "http://localhost");
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return null;
  }
  // URL.search drops a trailing empty query; actual HTTP requests keep it
  // unless a fragment follows, so preserve the exact configured wire target.
  const emptyQuery =
    !parsed.search && parsed.href.endsWith("?") && !configured.includes("#") ? "?" : "";
  return `${parsed.pathname}${parsed.search}${emptyQuery}`;
}
