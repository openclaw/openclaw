/**
 * Proactive messaging helpers — core/ version.
 *
 * Migrated from `src/proactive.ts` with these changes:
 * 1. `resolveDefaultQQBotAccountId` / `resolveQQBotAccount` → injected via `ProactiveDeps`
 * 2. `type OpenClawConfig` → `unknown` (opaque to core/)
 * 3. `ResolvedQQBotAccount` → `GatewayAccount`
 */

import {
  getAccessToken,
  sendC2CImageMessage,
  sendGroupImageMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
} from "../api/facade.js";
import type { GatewayAccount } from "../gateway/types.js";
import {
  clearKnownUsers as clearKnownUsersImpl,
  getKnownUser as getKnownUserImpl,
  listKnownUsers as listKnownUsersImpl,
  removeKnownUser as removeKnownUserImpl,
} from "../session/known-users.js";
import { debugError, debugLog } from "../utils/debug-log.js";
import { formatErrorMessage } from "../utils/error-format.js";

// Re-export known-user types and functions.
export {
  clearKnownUsers as clearKnownUsersFromStore,
  flushKnownUsers,
  getKnownUser as getKnownUserFromStore,
  listKnownUsers as listKnownUsersFromStore,
  recordKnownUser,
  removeKnownUser as removeKnownUserFromStore,
} from "../session/known-users.js";
export type { KnownUser } from "../session/known-users.js";

// ---- Injected dependencies ----

/** Config resolver — injected from the outer layer. */
export interface ProactiveDeps {
  resolveDefaultAccountId: (cfg: unknown) => string;
  resolveAccount: (
    cfg: unknown,
    accountId: string,
  ) => GatewayAccount & { appId: string; clientSecret: string };
}

// ---- Exported types ----

export interface ProactiveSendOptions {
  to: string;
  text: string;
  type?: "c2c" | "group" | "channel";
  imageUrl?: string;
  accountId?: string;
}

export interface ProactiveSendResult {
  success: boolean;
  messageId?: string;
  timestamp?: number | string;
  error?: string;
}

export interface ListKnownUsersOptions {
  type?: "c2c" | "group" | "channel";
  accountId?: string;
  sortByLastInteraction?: boolean;
  limit?: number;
}

// ---- Known-user adapters ----

export function getKnownUser(
  type: string,
  openid: string,
  accountId: string,
): ReturnType<typeof getKnownUserImpl> {
  return getKnownUserImpl(accountId, openid, type as "c2c" | "group");
}

export function listKnownUsers(
  options?: ListKnownUsersOptions,
): ReturnType<typeof listKnownUsersImpl> {
  const type = options?.type;
  return listKnownUsersImpl({
    type: type === "channel" ? undefined : type,
    accountId: options?.accountId,
    limit: options?.limit,
    sortBy: options?.sortByLastInteraction !== false ? "lastSeenAt" : undefined,
    sortOrder: "desc",
  });
}

export function removeKnownUser(type: string, openid: string, accountId: string): boolean {
  return removeKnownUserImpl(accountId, openid, type as "c2c" | "group");
}

export function clearKnownUsers(accountId?: string): number {
  return clearKnownUsersImpl(accountId);
}

// ---- Proactive sending ----

/** Resolve account config and send a proactive message. */
export async function sendProactive(
  options: ProactiveSendOptions,
  cfg: unknown,
  deps: ProactiveDeps,
): Promise<ProactiveSendResult> {
  const {
    to,
    text,
    type = "c2c",
    imageUrl,
    accountId = deps.resolveDefaultAccountId(cfg),
  } = options;

  const account = deps.resolveAccount(cfg, accountId);

  if (!account.appId || !account.clientSecret) {
    return {
      success: false,
      error: "QQBot not configured (missing appId or clientSecret)",
    };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);

    if (imageUrl) {
      try {
        if (type === "c2c") {
          await sendC2CImageMessage(account.appId, accessToken, to, imageUrl, undefined, undefined);
        } else if (type === "group") {
          await sendGroupImageMessage(
            account.appId,
            accessToken,
            to,
            imageUrl,
            undefined,
            undefined,
          );
        }
        debugLog(`[qqbot:proactive] Sent image to ${type}:${to}`);
      } catch (err) {
        debugError(`[qqbot:proactive] Failed to send image: ${String(err)}`);
      }
    }

    let result: { id: string; timestamp: number | string };

    if (type === "c2c") {
      result = await sendProactiveC2CMessage(account.appId, accessToken, to, text);
    } else if (type === "group") {
      result = await sendProactiveGroupMessage(account.appId, accessToken, to, text);
    } else if (type === "channel") {
      return {
        success: false,
        error: "Channel proactive messages are not supported. Please use group or c2c.",
      };
    } else {
      return {
        success: false,
        error: `Unknown message type: ${String(type)}`,
      };
    }

    debugLog(`[qqbot:proactive] Sent message to ${type}:${to}, id: ${result.id}`);

    return {
      success: true,
      messageId: result.id,
      timestamp: result.timestamp,
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    debugError(`[qqbot:proactive] Failed to send message: ${message}`);

    return {
      success: false,
      error: message,
    };
  }
}

/** Send one proactive message to each recipient. */
export async function sendBulkProactiveMessage(
  recipients: string[],
  text: string,
  type: "c2c" | "group",
  cfg: unknown,
  deps: ProactiveDeps,
  accountId = deps.resolveDefaultAccountId(cfg),
): Promise<Array<{ to: string; result: ProactiveSendResult }>> {
  const results: Array<{ to: string; result: ProactiveSendResult }> = [];

  for (const to of recipients) {
    const result = await sendProactive({ to, text, type, accountId }, cfg, deps);
    results.push({ to, result });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return results;
}

/** Send a message to all known users. */
export async function broadcastMessage(
  text: string,
  cfg: unknown,
  deps: ProactiveDeps,
  options?: {
    type?: "c2c" | "group";
    accountId?: string;
    limit?: number;
  },
): Promise<{
  total: number;
  success: number;
  failed: number;
  results: Array<{ to: string; result: ProactiveSendResult }>;
}> {
  const users = listKnownUsers({
    type: options?.type,
    accountId: options?.accountId,
    limit: options?.limit,
    sortByLastInteraction: true,
  });

  const validUsers = users.filter((u) => u.type === "c2c" || u.type === "group");

  const results: Array<{ to: string; result: ProactiveSendResult }> = [];
  let success = 0;
  let failed = 0;

  for (const user of validUsers) {
    const targetId = user.type === "group" ? (user.groupOpenid ?? user.openid) : user.openid;
    const result = await sendProactive(
      {
        to: targetId,
        text,
        type: user.type,
        accountId: user.accountId,
      },
      cfg,
      deps,
    );

    results.push({ to: targetId, result });

    if (result.success) {
      success++;
    } else {
      failed++;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    total: validUsers.length,
    success,
    failed,
    results,
  };
}

/** Send a proactive message using a resolved account without a full config object. */
export async function sendProactiveMessageDirect(
  account: GatewayAccount & { appId: string; clientSecret: string },
  to: string,
  text: string,
  type: "c2c" | "group" = "c2c",
): Promise<ProactiveSendResult> {
  if (!account.appId || !account.clientSecret) {
    return {
      success: false,
      error: "QQBot not configured (missing appId or clientSecret)",
    };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);

    let result: { id: string; timestamp: number | string };

    if (type === "c2c") {
      result = await sendProactiveC2CMessage(account.appId, accessToken, to, text);
    } else {
      result = await sendProactiveGroupMessage(account.appId, accessToken, to, text);
    }

    return {
      success: true,
      messageId: result.id,
      timestamp: result.timestamp,
    };
  } catch (err) {
    return {
      success: false,
      error: formatErrorMessage(err),
    };
  }
}

/** Return known-user counts for the selected account. */
export function getKnownUsersStats(accountId?: string): {
  total: number;
  c2c: number;
  group: number;
  channel: number;
} {
  const users = listKnownUsers({ accountId });

  return {
    total: users.length,
    c2c: users.filter((u) => u.type === "c2c").length,
    group: users.filter((u) => u.type === "group").length,
    channel: 0,
  };
}
