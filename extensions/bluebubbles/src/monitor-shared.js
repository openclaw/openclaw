import { normalizeWebhookPath } from "openclaw/plugin-sdk/bluebubbles";
const DEFAULT_WEBHOOK_PATH = "/bluebubbles-webhook";
function resolveWebhookPathFromConfig(config) {
  const raw = config?.webhookPath?.trim();
  if (raw) {
    return normalizeWebhookPath(raw);
  }
  return DEFAULT_WEBHOOK_PATH;
}
export {
  DEFAULT_WEBHOOK_PATH,
  normalizeWebhookPath,
  resolveWebhookPathFromConfig
};
