import os from "node:os";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const SLASH_COMMAND_DEPLOY_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 8,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 5_000,
    randomize: true,
  },
  stale: 15_000,
} as const;

type SlashCommandDeployStore = {
  version: 1;
  entries: Record<string, Record<string, string>>;
};

function resolveSlashCommandDeployStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "discord", "slash-command-deploy-hashes.json");
}

export function buildDiscordSlashCommandDeployStoreKey(params: {
  applicationId: string;
  accountId: string;
}): string {
  const app = normalizeOptionalString(params.applicationId)?.trim() ?? "";
  const acct = normalizeAccountId(params.accountId);
  return `${app}:${acct}`;
}

function sanitizeScopeHashes(raw: unknown): Record<string, string> {
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

async function readStore(filePath: string): Promise<SlashCommandDeployStore> {
  const { value } = await readJsonFileWithFallback(filePath, {
    version: 1,
    entries: {} as Record<string, Record<string, string>>,
  });
  if (!value || typeof value !== "object" || value.version !== 1) {
    return { version: 1, entries: {} };
  }
  const entries: Record<string, Record<string, string>> = {};
  if (value.entries && typeof value.entries === "object") {
    for (const [k, v] of Object.entries(value.entries)) {
      if (typeof k === "string") {
        entries[k] = sanitizeScopeHashes(v);
      }
    }
  }
  return { version: 1, entries };
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
  const filePath = resolveSlashCommandDeployStorePath(params.env);
  const store = await readStore(filePath);
  return { ...sanitizeScopeHashes(store.entries[key]) };
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
  const snapshot = sanitizeScopeHashes(params.hashes);
  if (Object.keys(snapshot).length === 0) {
    return;
  }
  const key = buildDiscordSlashCommandDeployStoreKey(params);
  const filePath = resolveSlashCommandDeployStorePath(params.env);

  await withFileLock(filePath, SLASH_COMMAND_DEPLOY_STORE_LOCK_OPTIONS, async () => {
    const store = await readStore(filePath);
    const prior = sanitizeScopeHashes(store.entries[key]);
    store.entries[key] = { ...prior, ...snapshot };
    await writeJsonFileAtomically(filePath, store);
  });
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
  const filePath = resolveSlashCommandDeployStorePath(params.env);

  await withFileLock(filePath, SLASH_COMMAND_DEPLOY_STORE_LOCK_OPTIONS, async () => {
    const store = await readStore(filePath);
    if (!store.entries[key]) {
      return;
    }
    const { [key]: _removed, ...rest } = store.entries;
    store.entries = rest;
    await writeJsonFileAtomically(filePath, store);
  });
}
