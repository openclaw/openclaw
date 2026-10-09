import { statSync } from "node:fs";
import path from "node:path";
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  normalizeAccountId,
  resolveAccountEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { IMessageAccountConfig } from "./account-types.js";
import {
  expandIMessageUserPath,
  resolveIMessageHomeDir,
  resolveLocalIMessageChatDbPath,
} from "./cli-path.js";
import { getCachedIMessageRemoteHost } from "./remote-host.js";

export type ResolvedIMessageAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: IMessageAccountConfig;
  configured: boolean;
};

const {
  listAccountIds,
  resolveDefaultAccountId,
  resolveAccountConfig: resolveMergedIMessageAccountConfig,
} = createAccountListHelpers<IMessageAccountConfig>("imessage", {
  implicitDefaultAccount: {
    channelKeys: ["cliPath", "dbPath"],
  },
});
export const listIMessageAccountIds = listAccountIds;
export const resolveDefaultIMessageAccountId = resolveDefaultAccountId;

type IMessageStreamingConfig = NonNullable<IMessageAccountConfig["streaming"]>;

function mergeIMessageStreamingConfig(
  baseConfig: IMessageStreamingConfig | undefined,
  accountConfig: IMessageStreamingConfig | undefined,
): IMessageStreamingConfig | undefined {
  if (!baseConfig || !accountConfig) {
    return accountConfig ?? baseConfig;
  }
  return {
    ...baseConfig,
    ...accountConfig,
    ...(baseConfig.block || accountConfig.block
      ? {
          block: {
            ...baseConfig.block,
            ...accountConfig.block,
            ...(baseConfig.block?.coalesce || accountConfig.block?.coalesce
              ? {
                  coalesce: {
                    ...baseConfig.block?.coalesce,
                    ...accountConfig.block?.coalesce,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function mergeIMessageAccountConfig(cfg: OpenClawConfig, accountId: string): IMessageAccountConfig {
  const accountConfig = resolveAccountEntry(cfg.channels?.imessage?.accounts, accountId);
  const merged = resolveMergedIMessageAccountConfig(cfg, accountId);
  const streaming = mergeIMessageStreamingConfig(
    cfg.channels?.imessage?.streaming,
    accountConfig?.streaming,
  );
  return streaming !== undefined ? { ...merged, streaming } : merged;
}

export function resolveIMessageAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedIMessageAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultIMessageAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.imessage?.enabled !== false;
  const merged = mergeIMessageAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const configured = Boolean(
    merged.enabled === true ||
    merged.cliPath?.trim() ||
    merged.dbPath?.trim() ||
    merged.service ||
    merged.sendTransport ||
    merged.region?.trim() ||
    (merged.allowFrom && merged.allowFrom.length > 0) ||
    (merged.groupAllowFrom && merged.groupAllowFrom.length > 0) ||
    merged.dmPolicy ||
    merged.groupPolicy ||
    typeof merged.includeAttachments === "boolean" ||
    (merged.attachmentRoots && merged.attachmentRoots.length > 0) ||
    (merged.remoteAttachmentRoots && merged.remoteAttachmentRoots.length > 0) ||
    typeof merged.mediaMaxMb === "number" ||
    typeof merged.textChunkLimit === "number" ||
    (merged.groups && Object.keys(merged.groups).length > 0),
  );
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: normalizeOptionalString(merged.name),
    config: merged,
    configured,
  };
}

function normalizeIMessageCliPath(value: string | undefined | null): string {
  return value?.trim() || "imsg";
}

function normalizeIMessageDbPath(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

// Stable signature for the local Messages backend an iMessage account targets.
// Two enabled accounts that share a signature watch the same source, which
// caused duplicate inbound handling in openclaw/openclaw#65141.
function resolveIMessageAccountSourceSignature(account: ResolvedIMessageAccount): string {
  const cliPath = normalizeIMessageCliPath(account.config.cliPath);
  const dbPath = normalizeIMessageDbPath(account.config.dbPath);
  const remoteHost = getCachedIMessageRemoteHost({
    cliPath,
    remoteHost: account.config.remoteHost,
  });
  // A remote path belongs to the SSH host and must not expand against the local home.
  if (remoteHost) {
    return JSON.stringify([cliPath, dbPath, remoteHost]);
  }
  const home = resolveIMessageHomeDir();
  const localDbPath = dbPath
    ? expandIMessageUserPath(dbPath)
    : home
      ? path.join(home, "Library", "Messages", "chat.db")
      : undefined;
  // Preserve the exact executable: same-basename SSH wrappers can target different hosts.
  return JSON.stringify([cliPath, localDbPath ? path.resolve(localDbPath) : "", ""]);
}

function groupIMessageAccountsBySource(cfg: OpenClawConfig) {
  const groups = new Map<string, ResolvedIMessageAccount[]>();
  for (const accountId of listIMessageAccountIds(cfg)) {
    const account = resolveIMessageAccount({ cfg, accountId });
    if (!account.enabled || !account.configured) {
      continue;
    }
    const signature = resolveIMessageAccountSourceSignature(account);
    const accounts = groups.get(signature) ?? [];
    accounts.push(account);
    groups.set(signature, accounts);
  }
  return groups;
}

function resolveIMessageAccountSourceOwner(accounts: readonly ResolvedIMessageAccount[]) {
  // Named accounts precede the implicit default so their bindings remain usable.
  return accounts.find((account) => account.accountId !== DEFAULT_ACCOUNT_ID) ?? accounts[0];
}

function resolveIMessageDatabaseFileIdentity(dbPath: string): string | undefined {
  try {
    const stats = statSync(dbPath);
    return stats.isFile() ? `${stats.dev}:${stats.ino}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the owner account id when `account` is an enabled duplicate of
 * another enabled account that targets the same local Messages source. Used
 * by the iMessage gateway lifecycle to skip starting redundant `imsg rpc`
 * watchers (openclaw/openclaw#65141) without otherwise marking the duplicate
 * disabled — outbound selection, status surfaces, and capability listings
 * keep treating both accounts normally.
 */
export function resolveIMessageDuplicateSourceOwner(params: {
  cfg: OpenClawConfig;
  account: ResolvedIMessageAccount;
}): string | undefined {
  if (!params.account.enabled || !params.account.configured) {
    return undefined;
  }
  const signature = resolveIMessageAccountSourceSignature(params.account);
  const owner = resolveIMessageAccountSourceOwner(
    groupIMessageAccountsBySource(params.cfg).get(signature) ?? [],
  );
  return owner && owner.accountId !== params.account.accountId ? owner.accountId : undefined;
}

export function listEnabledIMessageAccounts(cfg: OpenClawConfig): ResolvedIMessageAccount[] {
  return listIMessageAccountIds(cfg)
    .map((accountId) => resolveIMessageAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

export function hasExclusiveIMessageLocalDatabase(params: {
  cfg: OpenClawConfig;
  account: ResolvedIMessageAccount;
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
}): boolean {
  if (params.remoteHost?.trim()) {
    return false;
  }
  const otherAccounts = listEnabledIMessageAccounts(params.cfg).filter(
    (candidate) => candidate.accountId !== params.account.accountId,
  );
  if (otherAccounts.length === 0) {
    return true;
  }

  const selectedDbPath = resolveLocalIMessageChatDbPath({
    cliPath: params.cliPath,
    dbPath: params.dbPath,
    remoteHost: params.remoteHost ?? params.account.config.remoteHost,
  });
  if (!selectedDbPath) {
    return false;
  }

  const selectedDbIdentity = resolveIMessageDatabaseFileIdentity(selectedDbPath);
  if (!selectedDbIdentity) {
    return false;
  }

  for (const candidate of otherAccounts) {
    if (candidate.config.remoteHost?.trim()) {
      continue;
    }
    const candidateDbPath = resolveLocalIMessageChatDbPath({
      cliPath: candidate.config.cliPath?.trim() || "imsg",
      dbPath: candidate.config.dbPath?.trim() || undefined,
    });
    if (!candidateDbPath) {
      return false;
    }
    const candidateDbIdentity = resolveIMessageDatabaseFileIdentity(candidateDbPath);
    if (!candidateDbIdentity || candidateDbIdentity === selectedDbIdentity) {
      return false;
    }
  }
  return true;
}

export function collectIMessageDuplicateAccountSourceWarnings(params: {
  cfg: OpenClawConfig;
}): string[] {
  const groups = groupIMessageAccountsBySource(params.cfg);
  const warnings: string[] = [];
  for (const collisions of groups.values()) {
    if (collisions.length < 2) {
      continue;
    }
    const owner = expectDefined(
      resolveIMessageAccountSourceOwner(collisions),
      "duplicate iMessage account source",
    );
    const duplicates = collisions.filter((a) => a.accountId !== owner.accountId);
    const dupIds = duplicates.map((a) => `"${a.accountId}"`).join(", ");
    const cliPath = normalizeIMessageCliPath(owner.config.cliPath);
    const dbPath = normalizeIMessageDbPath(owner.config.dbPath);
    const where = dbPath ? `cliPath=${cliPath}, dbPath=${dbPath}` : `cliPath=${cliPath}`;
    warnings.push(
      `- channels.imessage: accounts "${owner.accountId}" and ${dupIds} watch the same local Messages source (${where}). OpenClaw runs one watcher (owner: "${owner.accountId}") and idles the duplicate; the other accounts stay enabled for outbound sends and status. Inbound messages arrive tagged with accountId="${owner.accountId}", so bindings pinned to ${dupIds} should be re-pointed at "${owner.accountId}" (or set "enabled": false on "${owner.accountId}" to flip ownership). Set "enabled": false on the unused duplicates to silence this warning.`,
    );
  }
  return warnings;
}
