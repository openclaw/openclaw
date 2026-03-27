/**
 * Admin resolution helpers.
 * - Persist the admin openid
 * - Persist the upgrade greeting target
 * - Send startup greetings
 */

import * as fs from "node:fs";
import path from "node:path";
import { getAccessToken, sendProactiveC2CMessage } from "./api.js";
import { listKnownUsers } from "./known-users.js";
import {
  getStartupGreetingPlan,
  markStartupGreetingSent,
  markStartupGreetingFailed,
} from "./startup-greeting.js";
import { getQQBotDataDir } from "./utils/platform.js";

// Types.

export interface AdminResolverContext {
  accountId: string;
  appId: string;
  clientSecret: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// File paths.

function getAdminMarkerFile(accountId: string): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(getQQBotDataDir("data"), `admin-${safeAccountId}.json`);
}

function getUpgradeGreetingTargetFile(accountId: string, appId: string): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeAppId = appId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(
    getQQBotDataDir("data"),
    `upgrade-greeting-target-${safeAccountId}-${safeAppId}.json`,
  );
}

// Admin openid persistence.

export function loadAdminOpenId(accountId: string): string | undefined {
  try {
    const file = getAdminMarkerFile(accountId);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.openid) return data.openid;
    }
  } catch {
    /* Treat corrupted files as missing. */
  }
  return undefined;
}

export function saveAdminOpenId(accountId: string, openid: string): void {
  try {
    fs.writeFileSync(
      getAdminMarkerFile(accountId),
      JSON.stringify({ openid, savedAt: new Date().toISOString() }),
    );
  } catch {
    /* ignore */
  }
}

// Upgrade greeting target persistence.

export function loadUpgradeGreetingTargetOpenId(
  accountId: string,
  appId: string,
): string | undefined {
  try {
    const file = getUpgradeGreetingTargetFile(accountId, appId);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
        accountId?: string;
        appId?: string;
        openid?: string;
      };
      if (!data.openid) return undefined;
      if (data.appId && data.appId !== appId) return undefined;
      if (data.accountId && data.accountId !== accountId) return undefined;
      return data.openid;
    }
  } catch {
    /* Treat corrupted files as missing. */
  }
  return undefined;
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

// Admin resolution.

/**
 * Resolve the admin openid.
 * 1. Prefer the persisted marker file.
 * 2. Fall back to the first DM user and persist that choice.
 */
export function resolveAdminOpenId(
  ctx: Pick<AdminResolverContext, "accountId" | "log">,
): string | undefined {
  const saved = loadAdminOpenId(ctx.accountId);
  if (saved) return saved;
  const first = listKnownUsers({
    accountId: ctx.accountId,
    type: "c2c",
    sortBy: "firstSeenAt",
    sortOrder: "asc",
    limit: 1,
  })[0]?.openid;
  if (first) {
    saveAdminOpenId(ctx.accountId, first);
    ctx.log?.info(`[qqbot:${ctx.accountId}] Auto-detected admin openid: ${first} (persisted)`);
  }
  return first;
}

// Startup greeting delivery.

/** Send the startup greeting asynchronously to the admin target only. */
export function sendStartupGreetings(
  ctx: AdminResolverContext,
  trigger: "READY" | "RESUMED",
): void {
  (async () => {
    const plan = getStartupGreetingPlan();
    if (!plan.shouldSend || !plan.greeting) {
      ctx.log?.info(
        `[qqbot:${ctx.accountId}] Skipping startup greeting (${plan.reason ?? "debounced"}, trigger=${trigger})`,
      );
      return;
    }

    const upgradeTargetOpenId = loadUpgradeGreetingTargetOpenId(ctx.accountId, ctx.appId);
    const targetOpenId = upgradeTargetOpenId || resolveAdminOpenId(ctx);
    if (!targetOpenId) {
      markStartupGreetingFailed(plan.version, "no-admin");
      ctx.log?.info(`[qqbot:${ctx.accountId}] Skipping startup greeting (no admin or known user)`);
      return;
    }

    try {
      const receiverType = upgradeTargetOpenId ? "upgrade-requester" : "admin";
      ctx.log?.info(
        `[qqbot:${ctx.accountId}] Sending startup greeting to ${receiverType} (trigger=${trigger}): "${plan.greeting}"`,
      );
      const token = await getAccessToken(ctx.appId, ctx.clientSecret);
      const GREETING_TIMEOUT_MS = 10_000;
      await Promise.race([
        sendProactiveC2CMessage(ctx.appId, token, targetOpenId, plan.greeting),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Startup greeting send timeout (10s)")),
            GREETING_TIMEOUT_MS,
          ),
        ),
      ]);
      markStartupGreetingSent(plan.version);
      if (upgradeTargetOpenId) {
        clearUpgradeGreetingTargetOpenId(ctx.accountId, ctx.appId);
      }
      ctx.log?.info(
        `[qqbot:${ctx.accountId}] Sent startup greeting to ${receiverType}: ${targetOpenId}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markStartupGreetingFailed(plan.version, message);
      ctx.log?.error(`[qqbot:${ctx.accountId}] Failed to send startup greeting: ${message}`);
    }
  })();
}
