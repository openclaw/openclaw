/**
 * Multi-account resolution layer.
 *
 * Design: dictionary-based — each key under `channels.wecom` is an account ID,
 * and its value contains the full per-account config (token, encodingAesKey,
 * agent, webhooks, etc.).
 *
 * Legacy single-account configs (where `token` exists directly under `wecom`)
 * are auto-detected and treated as accountId = "default".
 *
 * ── Multi-account config ───────────────────────────────────────────
 *
 *   channels:
 *     wecom:
 *       bot1:
 *         token: "bot-token-a"
 *         encodingAesKey: "..."
 *         agent:
 *           corpId: "ww1234"
 *           corpSecret: "secret-a"
 *           agentId: 1000001
 *         webhooks:
 *           ops-group: "key-xxx"
 *       bot2:
 *         token: "bot-token-b"
 *         encodingAesKey: "..."
 *         agent:
 *           corpId: "ww5678"
 *           corpSecret: "secret-b"
 *           agentId: 1000002
 *
 * ── Legacy single-account config (auto-detected, fully compatible) ─
 *
 *   channels:
 *     wecom:
 *       token: "bot-token-a"
 *       encodingAesKey: "..."
 *       agent:
 *         corpId: "ww1234"
 *         corpSecret: "secret-a"
 *         agentId: 1000001
 */

import { logger } from "../logger.js";
import { DEFAULT_ACCOUNT_ID } from "./constants.js";

// Keys that belong to the top-level wecom config and are NOT account IDs.
const RESERVED_KEYS = new Set([
  "enabled",
  "token",
  "encodingAesKey",
  "agent",
  "webhooks",
  "webhookPath",
  "name",
  "allowFrom",
  "commandAllowlist",
  "commandBlockMessage",
  "dm",
  "groupChat",
  "dynamicAgents",
  "adminUsers",
  "commands",
  "kf",
  "workspaceTemplate",
]);

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Detect whether the wecom config block is legacy (single-account) format.
 * Heuristic: if `token` exists directly under `channels.wecom`, it's legacy.
 */
function isLegacyConfig(wecom) {
  return typeof wecom?.token === "string";
}

/**
 * Build a resolved account object from a per-account config block.
 */
function buildAccount(accountId, accountCfg) {
  const agent = accountCfg?.agent;
  const webhooks = accountCfg?.webhooks;
  const agentConfigured = Boolean(
    agent?.corpId && agent?.corpSecret && agent?.agentId,
  );
  const agentInboundConfigured = Boolean(
    agent?.corpId &&
    agent?.corpSecret &&
    agent?.agentId &&
    agent?.token &&
    agent?.encodingAesKey,
  );

  return {
    accountId,
    name: accountCfg?.name || accountId,
    enabled: accountCfg?.enabled !== false,
    configured:
      Boolean(accountCfg?.token && accountCfg?.encodingAesKey) ||
      agentConfigured,
    token: accountCfg?.token || "",
    encodingAesKey: accountCfg?.encodingAesKey || "",
    webhookPath:
      accountCfg?.webhookPath ||
      (accountId === DEFAULT_ACCOUNT_ID
        ? "/webhooks/wecom"
        : `/webhooks/wecom/${accountId}`),
    config: accountCfg || {},
    agentConfigured,
    agentInboundConfigured,
    webhooksConfigured: Boolean(webhooks && Object.keys(webhooks).length > 0),
    agentCredentials: agentConfigured
      ? {
          corpId: agent.corpId,
          corpSecret: agent.corpSecret,
          agentId: agent.agentId,
        }
      : null,
  };
}

/**
 * Normalize a raw account key → canonical ID (lowercase, safe chars only).
 */
function normalizeAccountKey(key) {
  return String(key)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

/**
 * Extract top-level wecom keys that act as shared defaults for all instances
 * (e.g. dm, groupChat, dynamicAgents, adminUsers, etc.).
 * Only picks non-reserved, non-account object keys and scalar values.
 */
function extractTopLevelDefaults(wecom) {
  const defaults = {};
  const sharedKeys = [
    "dm",
    "groupChat",
    "dynamicAgents",
    "adminUsers",
    "commands",
    "kf",
    "workspaceTemplate",
  ];
  for (const k of sharedKeys) {
    if (wecom[k] !== undefined) {
      defaults[k] = wecom[k];
    }
  }
  return defaults;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * List all configured account IDs.
 * Returns `["default"]` for legacy single-account configs.
 */
export function listAccountIds(cfg) {
  const wecom = cfg?.channels?.wecom;
  if (!wecom || wecom.enabled === false) return [];

  // Legacy single-account → just "default".
  if (isLegacyConfig(wecom)) return [DEFAULT_ACCOUNT_ID];

  // Dictionary mode — each non-reserved key is an account.
  const ids = [];
  for (const key of Object.keys(wecom)) {
    if (RESERVED_KEYS.has(key)) continue;
    const val = wecom[key];
    // Support `instances` array: each entry has a `name` that becomes the accountId.
    if (key === "instances" && Array.isArray(val)) {
      for (const entry of val) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof entry.name === "string"
        ) {
          const id = normalizeAccountKey(entry.name);
          if (id && !ids.includes(id)) ids.push(id);
        }
      }
      continue;
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const id = normalizeAccountKey(key);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }

  if (ids.length === 0) {
    logger.warn(
      "[accounts] wecom config has no account entries and no legacy token — returning empty",
    );
  }
  return ids;
}

/**
 * Resolve a single account by its ID.
 */
export function resolveAccount(cfg, accountId) {
  const wecom = cfg?.channels?.wecom;
  if (!wecom) return null;

  const resolvedId = accountId || DEFAULT_ACCOUNT_ID;

  // Legacy single-account: the entire wecom block IS the account config.
  if (isLegacyConfig(wecom)) {
    if (resolvedId !== DEFAULT_ACCOUNT_ID) {
      logger.warn(
        `[accounts] legacy config does not have account "${resolvedId}"`,
      );
      return buildAccount(resolvedId, { enabled: false });
    }
    return buildAccount(DEFAULT_ACCOUNT_ID, wecom);
  }

  // Dictionary mode: look up key (case-insensitive).
  const normalizedId = normalizeAccountKey(resolvedId);
  for (const key of Object.keys(wecom)) {
    if (RESERVED_KEYS.has(key)) continue;
    // Support `instances` array lookup.
    if (key === "instances" && Array.isArray(wecom[key])) {
      for (const entry of wecom[key]) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof entry.name === "string"
        ) {
          if (normalizeAccountKey(entry.name) === normalizedId) {
            // Merge top-level wecom defaults (dm, groupChat, etc.) under the
            // instance entry so shared config is inherited automatically.
            const merged = { ...extractTopLevelDefaults(wecom), ...entry };
            return buildAccount(normalizedId, merged);
          }
        }
      }
      continue;
    }
    if (normalizeAccountKey(key) === normalizedId) {
      const val = wecom[key];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const merged = { ...extractTopLevelDefaults(wecom), ...val };
        return buildAccount(normalizedId, merged);
      }
    }
  }

  // Not found.
  return buildAccount(resolvedId, { enabled: false });
}

/**
 * Resolve all accounts as a Map<accountId, account>.
 */
export function resolveAllAccounts(cfg) {
  const ids = listAccountIds(cfg);
  const accounts = new Map();
  for (const id of ids) {
    accounts.set(id, resolveAccount(cfg, id));
  }
  return accounts;
}

/**
 * Extract Agent API credentials for a given accountId.
 * Returns `{ corpId, corpSecret, agentId }` or null.
 */
export function resolveAgentConfigForAccount(cfg, accountId) {
  const account = resolveAccount(cfg, accountId);
  return account?.agentCredentials ?? null;
}

/**
 * Detect duplicate tokens / agentIds across accounts.
 * Returns an array of conflict descriptions (empty = no conflicts).
 */
export function detectAccountConflicts(cfg) {
  const accounts = resolveAllAccounts(cfg);
  const conflicts = [];

  const tokenOwners = new Map();
  const agentIdOwners = new Map();

  for (const [id, account] of accounts) {
    if (!account.enabled) continue;

    // Check bot token uniqueness.
    const token = account.token?.trim();
    if (token) {
      const key = token.toLowerCase();
      if (tokenOwners.has(key)) {
        const owner = tokenOwners.get(key);
        conflicts.push({
          type: "duplicate_token",
          accounts: [owner, id],
          message: `账号 "${id}" 与 "${owner}" 使用了相同的 Bot Token，会导致消息错乱。`,
        });
      } else {
        tokenOwners.set(key, id);
      }
    }

    // Check agent corpId+agentId uniqueness.
    const creds = account.agentCredentials;
    if (creds) {
      const key = `${creds.corpId}:${creds.agentId}`;
      if (agentIdOwners.has(key)) {
        const owner = agentIdOwners.get(key);
        conflicts.push({
          type: "duplicate_agent",
          accounts: [owner, id],
          message: `账号 "${id}" 与 "${owner}" 使用了相同的 Agent 配置 (${creds.corpId}/${creds.agentId})。`,
        });
      } else {
        agentIdOwners.set(key, id);
      }
    }
  }

  return conflicts;
}

/**
 * Find which accountId owns a given bot token.
 * Useful for inbound routing when the request carries a token.
 */
export function findAccountByToken(cfg, token) {
  if (!token) return null;
  const key = token.trim().toLowerCase();
  const accounts = resolveAllAccounts(cfg);
  for (const [id, account] of accounts) {
    if (account.enabled && account.token?.trim().toLowerCase() === key) {
      return id;
    }
  }
  return null;
}
