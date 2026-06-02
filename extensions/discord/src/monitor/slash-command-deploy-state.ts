import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getDiscordRuntime } from "../runtime.js";

export const DISCORD_SLASH_COMMAND_DEPLOY_STORE_NAMESPACE = "slash-command-deploy-hashes";
export const DISCORD_SLASH_COMMAND_DEPLOY_MAX_ENTRIES = 256;
export const DISCORD_SLASH_COMMAND_DEPLOY_LEGACY_JSON_RELATIVE_PATH =
  "discord/slash-command-deploy-hashes.json";

type SlashCommandDeployHashesEntry = {
  version: 1;
  hashes: Record<string, string>;
};

function openSlashCommandDeployStore(env?: NodeJS.ProcessEnv) {
  return getDiscordRuntime().state.openKeyedStore<SlashCommandDeployHashesEntry>({
    namespace: DISCORD_SLASH_COMMAND_DEPLOY_STORE_NAMESPACE,
    maxEntries: DISCORD_SLASH_COMMAND_DEPLOY_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

export function buildDiscordSlashCommandDeployStoreKey(params: {
  applicationId: string;
  accountId: string;
}): string {
  const app = normalizeOptionalString(params.applicationId)?.trim() ?? "";
  const acct = normalizeAccountId(params.accountId);
  return `${app}:${acct}`;
}

export function sanitizeSlashCommandDeployScopeHashes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [scopeKey, hash] of Object.entries(raw)) {
    if (
      typeof scopeKey === "string" &&
      typeof hash === "string" &&
      scopeKey &&
      hash.match(/^[a-f0-9]{64}$/)
    ) {
      out[scopeKey] = hash;
    }
  }
  return out;
}

function sanitizeStoredEntry(value: unknown): SlashCommandDeployHashesEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const typed = value as { version?: unknown; hashes?: unknown };
  if (typed.version !== 1) {
    return undefined;
  }
  const hashes = sanitizeSlashCommandDeployScopeHashes(typed.hashes);
  if (Object.keys(hashes).length === 0) {
    return undefined;
  }
  return { version: 1, hashes };
}

export async function readDiscordSlashCommandDeployHashes(params: {
  applicationId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, string>> {
  const app = normalizeOptionalString(params.applicationId)?.trim() ?? "";
  if (!app) {
    return {};
  }
  const key = buildDiscordSlashCommandDeployStoreKey(params);
  try {
    const entry = await openSlashCommandDeployStore(params.env).lookup(key);
    return { ...sanitizeStoredEntry(entry)?.hashes };
  } catch {
    return {};
  }
}

export async function mergeDiscordSlashCommandDeployHashes(params: {
  applicationId: string;
  accountId: string;
  hashes: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const app = normalizeOptionalString(params.applicationId)?.trim() ?? "";
  if (!app) {
    return;
  }
  const snapshot = sanitizeSlashCommandDeployScopeHashes(params.hashes);
  if (Object.keys(snapshot).length === 0) {
    return;
  }
  const key = buildDiscordSlashCommandDeployStoreKey(params);
  try {
    await openSlashCommandDeployStore(params.env).update(key, (current) => {
      const prior = sanitizeStoredEntry(current)?.hashes ?? {};
      return { version: 1, hashes: { ...prior, ...snapshot } };
    });
  } catch {
    // Fingerprint cache is best-effort; deploy should never fail because persistence did.
  }
}

export async function clearDiscordSlashCommandDeployHashes(params: {
  applicationId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const app = normalizeOptionalString(params.applicationId)?.trim() ?? "";
  if (!app) {
    return;
  }
  const key = buildDiscordSlashCommandDeployStoreKey(params);
  try {
    await openSlashCommandDeployStore(params.env).delete(key);
  } catch {
    // Best-effort cache cleanup only.
  }
}
