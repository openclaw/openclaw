import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { releaseAccountThrottler } from "./account-throttler.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";
import { getOptionalTelegramRuntime } from "./runtime.js";

// A bot token may be shared across accounts; only release its throttler when
// no configured account still uses it (the removed or rotated account excluded).
function telegramTokenStillInUse(
  cfg: OpenClawConfig,
  token: string,
  excludeAccountId?: string,
): boolean {
  const excluded =
    excludeAccountId === undefined ? undefined : normalizeOptionalAccountId(excludeAccountId);
  return listTelegramAccountIds(cfg).some(
    (accountId) =>
      accountId !== excluded && resolveTelegramAccount({ cfg, accountId }).token.trim() === token,
  );
}

/**
 * Releases the throttler of a retired bot token once no configured account
 * still uses it. The caller (config reload, account removal, manual stop) has
 * already excluded the affected account; the token stays cached when a sibling
 * account shares it, so penalty state survives.
 */
export async function releaseRetiredTelegramAccountThrottler(
  token: string,
  cfg?: OpenClawConfig,
  excludeAccountId?: string,
): Promise<boolean> {
  const resolvedCfg = cfg ?? (getOptionalTelegramRuntime()?.config.current?.() as OpenClawConfig);
  if (!token || !resolvedCfg) {
    return false;
  }
  if (telegramTokenStillInUse(resolvedCfg, token, excludeAccountId)) {
    return false;
  }
  return releaseAccountThrottler(token);
}
