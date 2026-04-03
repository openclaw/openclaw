import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { listSlackAccountIds, resolveSlackAccount } from "../accounts.js";
import { handleSlackHttpRequest, normalizeSlackWebhookPath } from "./registry.js";

export function registerSlackPluginHttpRoutes(api: OpenClawPluginApi): void {
  const accountIds = new Set<string>([DEFAULT_ACCOUNT_ID, ...listSlackAccountIds(api.config)]);
  const registeredPaths = new Set<string>();
  for (const accountId of accountIds) {
    const account = resolveSlackAccount({ cfg: api.config, accountId });
    registeredPaths.add(normalizeSlackWebhookPath(account.config.webhookPath));
  }
  if (registeredPaths.size === 0) {
    registeredPaths.add(normalizeSlackWebhookPath());
  }
  for (const path of registeredPaths) {
    api.registerHttpRoute({
      path,
      auth: "plugin",
      handler: async (req, res) => await handleSlackHttpRequest(req, res),
    });
  }
}
