/**
 * Admin resolver module.
 * 管理员解析器模块。
 *
 * - Persists the bot admin openid per (accountId, appId)
 * - Persists the "upgrade greeting target" openid that records who triggered
 *   the last `/bot-upgrade`
 * - Sends the startup greeting when the gateway reaches the READY/RESUMED
 *   state after a plugin version change
 *
 * Ported from openclaw-qqbot/src/admin-resolver.ts. The only behavioural
 * differences compared to the standalone module are:
 *   - file paths go through `engine/utils/data-paths.ts`
 *   - proactive messaging uses the fused `sendProactiveMessage` helper
 *     (which accepts a fully qualified `qqbot:c2c:<openid>` target and a
 *     GatewayAccount; no need to manage access tokens manually).
 */

import * as fs from "node:fs";
import type { EngineLogger, GatewayAccount } from "../gateway/types.js";
import { sendProactiveMessage } from "../messaging/outbound.js";
import {
  getAdminMarkerFile,
  getLegacyAdminMarkerFile,
  getUpgradeGreetingTargetFile,
} from "../utils/data-paths.js";
import { listKnownUsers } from "./known-users.js";
import {
  getStartupGreetingPlan,
  markStartupGreetingFailed,
  markStartupGreetingSent,
} from "./startup-greeting.js";

// ---- Types ----

export interface AdminResolverContext {
  account: GatewayAccount;
  log?: EngineLogger;
}

// ---- Admin openid persistence ----

/**
 * Read the stored admin openid for (accountId, appId).
 *
 * Strategy: new path first → legacy single-account path as fallback →
 * auto-migrate legacy content to the new path and delete the legacy file.
 */
export function loadAdminOpenId(accountId: string, appId: string): string | undefined {
  try {
    const newFile = getAdminMarkerFile(accountId, appId);
    if (fs.existsSync(newFile)) {
      const data = JSON.parse(fs.readFileSync(newFile, "utf8"));
      if (data.openid) {
        return data.openid;
      }
    }

    const legacyFile = getLegacyAdminMarkerFile(accountId);
    if (fs.existsSync(legacyFile)) {
      const data = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
      if (data.openid) {
        saveAdminOpenId(accountId, appId, data.openid);
        try {
          fs.unlinkSync(legacyFile);
        } catch {
          /* ignore */
        }
        return data.openid;
      }
    }
  } catch {
    /* corrupt file treated as missing */
  }
  return undefined;
}

export function saveAdminOpenId(accountId: string, appId: string, openid: string): void {
  try {
    fs.writeFileSync(
      getAdminMarkerFile(accountId, appId),
      JSON.stringify({ accountId, appId, openid, savedAt: new Date().toISOString() }),
    );
  } catch {
    /* ignore */
  }
}

// ---- Upgrade greeting target ----

export function loadUpgradeGreetingTargetOpenId(
  accountId: string,
  appId: string,
  log?: EngineLogger,
): string | undefined {
  try {
    const file = getUpgradeGreetingTargetFile(accountId, appId);
    if (!fs.existsSync(file)) {
      log?.info?.(`[qqbot:${accountId}] upgrade-greeting-target file not found: ${file}`);
      return undefined;
    }
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
      accountId?: string;
      appId?: string;
      openid?: string;
    };
    if (!data.openid) {
      log?.info?.(`[qqbot:${accountId}] upgrade-greeting-target file found but openid is empty`);
      return undefined;
    }
    if (data.appId && data.appId !== appId) {
      log?.info?.(
        `[qqbot:${accountId}] upgrade-greeting-target appId mismatch: file=${data.appId}, current=${appId}`,
      );
      return undefined;
    }
    if (data.accountId && data.accountId !== accountId) {
      log?.info?.(
        `[qqbot:${accountId}] upgrade-greeting-target accountId mismatch: file=${data.accountId}, current=${accountId}`,
      );
      return undefined;
    }
    log?.info?.(`[qqbot:${accountId}] upgrade-greeting-target loaded: openid=${data.openid}`);
    return data.openid;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.info?.(`[qqbot:${accountId}] upgrade-greeting-target file read error: ${msg}`);
    return undefined;
  }
}

export function clearUpgradeGreetingTargetOpenId(accountId: string, appId: string): void {
  try {
    const file = getUpgradeGreetingTargetFile(accountId, appId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    /* ignore */
  }
}

// ---- Admin resolution ----

/**
 * Resolve the admin openid:
 *  1. Prefer the persisted value ((accountId, appId))
 *  2. Otherwise fall back to the earliest C2C user and lock it in.
 */
export function resolveAdminOpenId(ctx: {
  accountId: string;
  appId: string;
  log?: EngineLogger;
}): string | undefined {
  const saved = loadAdminOpenId(ctx.accountId, ctx.appId);
  if (saved) {
    return saved;
  }
  const first = listKnownUsers({
    accountId: ctx.accountId,
    type: "c2c",
    sortBy: "firstSeenAt",
    sortOrder: "asc",
    limit: 1,
  })[0]?.openid;
  if (first) {
    saveAdminOpenId(ctx.accountId, ctx.appId, first);
    ctx.log?.info?.(`[qqbot:${ctx.accountId}] Auto-detected admin openid: ${first} (persisted)`);
  }
  return first;
}

// ---- Startup greeting dispatch ----

const GREETING_TIMEOUT_MS = 10_000;

/**
 * Async fire-and-forget startup greeting dispatcher.
 *
 * Sends the greeting to whoever triggered `/bot-upgrade` if the marker
 * file exists; otherwise quietly updates the startup marker without
 * sending anything. The latter is what happens in the fused build until
 * `/bot-upgrade` is ported — intentional parity with the standalone
 * "silently update marker" branch.
 */
export function sendStartupGreetings(
  ctx: AdminResolverContext,
  trigger: "READY" | "RESUMED",
): void {
  const { account, log } = ctx;
  const accountId = account.accountId;
  const appId = account.appId;
  void (async () => {
    const plan = getStartupGreetingPlan(accountId, appId);
    if (!plan.shouldSend || !plan.greeting) {
      log?.info?.(
        `[qqbot:${accountId}] Skipping startup greeting (${plan.reason ?? "debounced"}, trigger=${trigger})`,
      );
      return;
    }

    const upgradeTargetOpenId = loadUpgradeGreetingTargetOpenId(accountId, appId, log);
    if (!upgradeTargetOpenId) {
      markStartupGreetingSent(accountId, appId, plan.version);
      log?.info?.(
        `[qqbot:${accountId}] Version changed but no upgrade-greeting-target, silently updating marker (trigger=${trigger})`,
      );
      return;
    }

    try {
      log?.info?.(
        `[qqbot:${accountId}] Sending startup greeting to upgrade-requester (trigger=${trigger}): "${plan.greeting}"`,
      );
      const target = `qqbot:c2c:${upgradeTargetOpenId}`;
      await Promise.race([
        sendProactiveMessage(account, target, plan.greeting),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Startup greeting send timeout (10s)")),
            GREETING_TIMEOUT_MS,
          ),
        ),
      ]);
      markStartupGreetingSent(accountId, appId, plan.version);
      clearUpgradeGreetingTargetOpenId(accountId, appId);
      log?.info?.(
        `[qqbot:${accountId}] Sent startup greeting to upgrade-requester: ${upgradeTargetOpenId}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markStartupGreetingFailed(accountId, appId, plan.version, message);
      log?.error?.(`[qqbot:${accountId}] Failed to send startup greeting: ${message}`);
    }
  })();
}
