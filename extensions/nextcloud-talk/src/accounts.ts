import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_ID, isTruthyEnvValue, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, NextcloudTalkAccountConfig } from "./types.js";

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_NEXTCLOUD_TALK_ACCOUNTS)) {
    console.warn("[nextcloud-talk:accounts]", ...args);
  }
};

export type ResolvedNextcloudTalkAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  secret: string;
  secretSource: "env" | "secretFile" | "config" | "none";
  config: NextcloudTalkAccountConfig;
};

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.["nextcloud-talk"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (!key) {
      continue;
    }
    ids.add(normalizeAccountId(key));
  }
  return [...ids];
}

export function listNextcloudTalkAccountIds(cfg: CoreConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  debugAccounts("listNextcloudTalkAccountIds", ids);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultNextcloudTalkAccountId(cfg: CoreConfig): string {
  const ids = listNextcloudTalkAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): NextcloudTalkAccountConfig | undefined {
  const accounts = cfg.channels?.["nextcloud-talk"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as NextcloudTalkAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as NextcloudTalkAccountConfig | undefined) : undefined;
}

function mergeNextcloudTalkAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): NextcloudTalkAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.["nextcloud-talk"] ??
    {}) as NextcloudTalkAccountConfig & { accounts?: unknown };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveNextcloudTalkSecret(
  cfg: CoreConfig,
  opts: { accountId?: string },
): { secret: string; source: ResolvedNextcloudTalkAccount["secretSource"] } {
  const merged = mergeNextcloudTalkAccountConfig(cfg, opts.accountId ?? DEFAULT_ACCOUNT_ID);

  const envSecret = process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim();
  if (envSecret && (!opts.accountId || opts.accountId === DEFAULT_ACCOUNT_ID)) {
    return { secret: envSecret, source: "env" };
  }

  if (merged.botSecretFile) {
    try {
      const fileSecret = readFileSync(merged.botSecretFile, "utf-8").trim();
      if (fileSecret) {
        return { secret: fileSecret, source: "secretFile" };
      }
    } catch {
      // File not found or unreadable, fall through.
    }
  }

  if (merged.botSecret?.trim()) {
    return { secret: merged.botSecret.trim(), source: "config" };
  }

  return { secret: "", source: "none" };
}

export function resolveNextcloudTalkAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedNextcloudTalkAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.["nextcloud-talk"]?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeNextcloudTalkAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const secretResolution = resolveNextcloudTalkSecret(params.cfg, { accountId });
    const baseUrl = merged.baseUrl?.trim()?.replace(/\/$/, "") ?? "";

    debugAccounts("resolve", {
      accountId,
      enabled,
      secretSource: secretResolution.source,
      baseUrl: baseUrl ? "[set]" : "[missing]",
    });

    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      baseUrl,
      secret: secretResolution.secret,
      secretSource: secretResolution.source,
      config: merged,
    } satisfies ResolvedNextcloudTalkAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.secretSource !== "none") {
    return primary;
  }

  const fallbackId = resolveDefaultNextcloudTalkAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (fallback.secretSource === "none") {
    return primary;
  }
  return fallback;
}

export function listEnabledNextcloudTalkAccounts(cfg: CoreConfig): ResolvedNextcloudTalkAccount[] {
  return listNextcloudTalkAccountIds(cfg)
    .map((accountId) => resolveNextcloudTalkAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
