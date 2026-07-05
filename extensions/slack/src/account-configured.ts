// Slack helper module supports account configured behavior.
import { hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-resolution";
import type { ResolvedSlackAccount } from "./accounts.js";

export function isSlackPluginAccountConfigured(account: ResolvedSlackAccount): boolean {
  const mode = account.config.mode ?? "socket";
  const hasBotToken = Boolean(account.botToken?.trim());
  if (!hasBotToken) {
    return false;
  }
  if (mode === "http") {
    return hasConfiguredAccountValue(account.config.signingSecret);
  }
<<<<<<< HEAD
  if (mode === "relay") {
    const relay = account.config.relay;
    return (
      hasConfiguredAccountValue(relay?.url) &&
      hasConfiguredAccountValue(relay?.authToken) &&
      hasConfiguredAccountValue(relay?.gatewayId)
    );
  }
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  return Boolean(account.appToken?.trim());
}
