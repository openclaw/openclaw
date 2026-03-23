/**
 * 管理员解析器模块
 * - 管理员 openid 持久化读写
 * - 升级问候目标读写
 * - 启动问候语发送
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

// ---- 类型 ----

export interface AdminResolverContext {
  accountId: string;
  appId: string;
  clientSecret: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// ---- 文件路径 ----

function getAdminMarkerFile(accountId: string): string {
  return path.join(getQQBotDataDir("data"), `admin-${accountId}.json`);
}

function getUpgradeGreetingTargetFile(accountId: string, appId: string): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeAppId = appId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(
    getQQBotDataDir("data"),
    `upgrade-greeting-target-${safeAccountId}-${safeAppId}.json`,
  );
}

// ---- 管理员 openid 持久化 ----

export function loadAdminOpenId(accountId: string): string | undefined {
  try {
    const file = getAdminMarkerFile(accountId);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.openid) return data.openid;
    }
  } catch {
    /* 文件损坏视为无 */
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

// ---- 升级问候目标 ----

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
    /* 文件损坏视为无 */
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

// ---- 解析管理员 ----

/**
 * 解析管理员 openid：
 * 1. 优先读持久化文件（稳定）
 * 2. fallback 取第一个私聊用户，并写入文件锁定
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

// ---- 启动问候语 ----

/** 异步发送启动问候语（仅发给管理员） */
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
