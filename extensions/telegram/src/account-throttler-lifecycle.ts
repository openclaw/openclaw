import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { releaseAccountThrottler } from "./account-throttler.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";
import { releaseStoppedTelegramPollingLease } from "./polling-lease.js";
import { getOptionalTelegramRuntime } from "./runtime.js";

// This module owns account retirement: when a bot token leaves the Gateway
// configuration (rotation, removal, or stop), it releases the token's throttle
// and polling resources after queued work settles. A bot token may be shared
// across accounts; only release its throttler when no configured account still
// uses it (the removed or rotated account excluded).
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
async function releaseRetiredTelegramAccountThrottler(
  token: string,
  cfg?: OpenClawConfig,
  excludeAccountId?: string,
): Promise<boolean> {
  const resolvedCfg =
    cfg ??
    // SAFETY: the runtime snapshot is a read-only view of the same config shape.
    (getOptionalTelegramRuntime()?.config.current?.() as OpenClawConfig);
  if (!token || !resolvedCfg) {
    return false;
  }
  if (telegramTokenStillInUse(resolvedCfg, token, excludeAccountId)) {
    return false;
  }
  return releaseAccountThrottler(token);
}

/**
 * Releases the throttler of a rotated-out bot token and reports whether the
 * account's token actually changed. `nextCfg` no longer configures the old
 * token for this account, so the shared-token check covers sibling accounts.
 */
export async function releaseRotatedTelegramAccountThrottler(
  prevCfg: OpenClawConfig,
  nextCfg: OpenClawConfig,
  accountId: string,
): Promise<boolean> {
  const previousToken = resolveTelegramAccount({ cfg: prevCfg, accountId }).token.trim();
  const nextToken = resolveTelegramAccount({ cfg: nextCfg, accountId }).token.trim();
  if (previousToken === nextToken) {
    return false;
  }
  await releaseRetiredTelegramAccountThrottler(previousToken, nextCfg);
  return true;
}

/**
 * Releases the throttler of a removed account's bot token once no remaining
 * configured account still uses it. `prevCfg` is the config before removal, so
 * it still contains the removed account; that account is excluded from the
 * still-in-use check while a shared sibling token keeps its limiter alive.
 */
export async function releaseRemovedTelegramAccountThrottler(
  prevCfg: OpenClawConfig,
  accountId: string,
): Promise<boolean> {
  const token = resolveTelegramAccount({ cfg: prevCfg, accountId }).token.trim();
  return releaseRetiredTelegramAccountThrottler(token, prevCfg, accountId);
}

/**
 * Releases a stopped account's polling lease and, once the token is no longer
 * configured anywhere (unchanged reloads and manual stops keep the limiter),
 * its account throttler.
 */
export async function releaseStoppedTelegramAccountResources(params: {
  token: string;
  accountId: string;
  log?: { info?: (message: string) => void };
}): Promise<void> {
  const released = await releaseStoppedTelegramPollingLease({
    token: params.token,
    accountId: params.accountId,
  });
  if (released) {
    params.log?.info?.(`[${params.accountId}] released stopped Telegram polling lease`);
  }
  const releasedThrottler = await releaseRetiredTelegramAccountThrottler(params.token);
  if (releasedThrottler) {
    params.log?.info?.(`[${params.accountId}] released retired Telegram account throttler`);
  }
}
