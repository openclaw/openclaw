import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { listSlackAccountIds, mergeSlackAccountConfig } from "../accounts.js";
import { normalizeSlackWebhookPath } from "./paths.js";

let slackHttpHandlerRuntimePromise: Promise<typeof import("./handler.runtime.js")> | null = null;

async function loadSlackHttpHandlerRuntime() {
  slackHttpHandlerRuntimePromise ??= import("./handler.runtime.js");
  return await slackHttpHandlerRuntimePromise;
}

export function registerSlackPluginHttpRoutes(api: OpenClawPluginApi): void {
  const accountIds = new Set<string>([DEFAULT_ACCOUNT_ID, ...listSlackAccountIds(api.config)]);
  const registeredPaths = new Set<string>();
  for (const rawAccountId of accountIds) {
    // Use mergeSlackAccountConfig (the token-free surface) instead of
    // resolveSlackAccount here. The register path only needs `webhookPath`
    // to register an HTTP route — it has no business resolving bot/app/user
    // tokens, and doing so crashes the CLI when tokens are stored as
    // SecretRef objects because the CLI has no gateway runtime snapshot to
    // resolve secrets against. Token resolution still happens at request
    // time inside handleSlackHttpRequest, which runs under the gateway
    // runtime where secrets are resolvable (#63937).
    const accountId = normalizeAccountId(rawAccountId);
    const merged = mergeSlackAccountConfig(api.config, accountId);
    registeredPaths.add(normalizeSlackWebhookPath(merged.webhookPath));
  }
  if (registeredPaths.size === 0) {
    registeredPaths.add(normalizeSlackWebhookPath());
  }
  for (const path of registeredPaths) {
    api.registerHttpRoute({
      path,
      auth: "plugin",
      handler: async (req, res) =>
        await (await loadSlackHttpHandlerRuntime()).handleSlackHttpRequest(req, res),
    });
  }
}
