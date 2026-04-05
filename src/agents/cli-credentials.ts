import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import type { OAuthCredentials, OAuthProvider } from "./auth-profiles/types.js";

const log = createSubsystemLogger("agents/auth-profiles");

const CODEX_CLI_AUTH_FILENAME = "auth.json";
const MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH = ".minimax/oauth_creds.json";

type CachedValue<T> = {
  value: T | null;
  readAt: number;
  cacheKey: string;
  sourceFingerprint?: number | string | null;
};

let codexCliCache: CachedValue<CodexCliCredential> | null = null;
let minimaxCliCache: CachedValue<MiniMaxCliCredential> | null = null;

export function resetCliCredentialCachesForTest(): void {
  codexCliCache = null;
  minimaxCliCache = null;
}

export type CodexCliCredential = {
  type: "oauth";
  provider: OAuthProvider;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

export type MiniMaxCliCredential = {
  type: "oauth";
  provider: "minimax-portal";
  access: string;
  refresh: string;
  expires: number;
};

type CodexCliFileOptions = {
  codexHome?: string;
};

type CodexCliWriteOptions = CodexCliFileOptions & {
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
  execFileSync?: ExecFileSyncFn;
  writeKeychain?: (
    credentials: OAuthCredentials,
    options?: {
      codexHome?: string;
      platform?: NodeJS.Platform;
      execSync?: ExecSyncFn;
      execFileSync?: ExecFileSyncFn;
    },
  ) => boolean;
  writeFile?: (credentials: OAuthCredentials, options?: CodexCliFileOptions) => boolean;
};

type ExecSyncFn = typeof execSync;
type ExecFileSyncFn = typeof execFileSync;

function resolveCodexHomePath(codexHome?: string) {
  const configured = codexHome ?? process.env.CODEX_HOME;
  const home = configured ? resolveUserPath(configured) : resolveUserPath("~/.codex");
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function resolveMiniMaxCliCredentialsPath(homeDir?: string) {
  const baseDir = homeDir ?? resolveUserPath("~");
  return path.join(baseDir, MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH);
}

function readFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function readCachedCliCredential<T>(options: {
  ttlMs: number;
  cache: CachedValue<T> | null;
  cacheKey: string;
  read: () => T | null;
  setCache: (next: CachedValue<T> | null) => void;
  readSourceFingerprint?: () => number | string | null;
}): T | null {
  const { ttlMs, cache, cacheKey, read, setCache, readSourceFingerprint } = options;
  if (ttlMs <= 0) {
    return read();
  }

  const now = Date.now();
  const sourceFingerprint = readSourceFingerprint?.();
  if (
    cache &&
    cache.cacheKey === cacheKey &&
    cache.sourceFingerprint === sourceFingerprint &&
    now - cache.readAt < ttlMs
  ) {
    return cache.value;
  }

  const value = read();
  const cachedSourceFingerprint = readSourceFingerprint?.();
  if (!readSourceFingerprint || cachedSourceFingerprint === sourceFingerprint) {
    setCache({
      value,
      readAt: now,
      cacheKey,
      sourceFingerprint: cachedSourceFingerprint,
    });
  } else {
    setCache(null);
  }
  return value;
}

function computeCodexKeychainAccount(codexHome: string) {
  const hash = createHash("sha256").update(codexHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function resolveCodexKeychainParams(options?: {
  codexHome?: string;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}) {
  return {
    platform: options?.platform ?? process.platform,
    execSyncImpl: options?.execSync ?? execSync,
    codexHome: resolveCodexHomePath(options?.codexHome),
  };
}

function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payloadRaw = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

function readCodexKeychainAuthRecord(options?: {
  codexHome?: string;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): Record<string, unknown> | null {
  const { platform, execSyncImpl, codexHome } = resolveCodexKeychainParams(options);
  if (platform !== "darwin") {
    return null;
  }
  const account = computeCodexKeychainAccount(codexHome);

  try {
    const secret = execSyncImpl(
      `security find-generic-password -s "Codex Auth" -a "${account}" -w`,
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();

    const parsed = JSON.parse(secret) as Record<string, unknown>;
    return parsed;
  } catch {
    return null;
  }
}

function readCodexKeychainCredentials(options?: {
  codexHome?: string;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliCredential | null {
  const parsed = readCodexKeychainAuthRecord(options);
  if (!parsed) {
    return null;
  }
  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  try {
    const accessToken = tokens?.access_token;
    const refreshToken = tokens?.refresh_token;
    if (typeof accessToken !== "string" || !accessToken) {
      return null;
    }
    if (typeof refreshToken !== "string" || !refreshToken) {
      return null;
    }

    // No explicit expiry stored; treat as fresh for an hour from last_refresh or now.
    const lastRefreshRaw = parsed.last_refresh;
    const lastRefresh =
      typeof lastRefreshRaw === "string" || typeof lastRefreshRaw === "number"
        ? new Date(lastRefreshRaw).getTime()
        : Date.now();
    const fallbackExpiry = Number.isFinite(lastRefresh)
      ? lastRefresh + 60 * 60 * 1000
      : Date.now() + 60 * 60 * 1000;
    const expires = decodeJwtExpiryMs(accessToken) ?? fallbackExpiry;
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;

    log.info("read codex credentials from keychain", {
      source: "keychain",
      expires: new Date(expires).toISOString(),
    });

    return {
      type: "oauth",
      provider: "openai-codex" as OAuthProvider,
      access: accessToken,
      refresh: refreshToken,
      expires,
      accountId,
    };
  } catch {
    return null;
  }
}

function readPortalCliOauthCredentials<TProvider extends string>(
  credPath: string,
  provider: TProvider,
): { type: "oauth"; provider: TProvider; access: string; refresh: string; expires: number } | null {
  const raw = loadJsonFile(credPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresAt = data.expiry_date;

  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return null;
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return null;
  }

  return {
    type: "oauth",
    provider,
    access: accessToken,
    refresh: refreshToken,
    expires: expiresAt,
  };
}

function readMiniMaxCliCredentials(options?: { homeDir?: string }): MiniMaxCliCredential | null {
  const credPath = resolveMiniMaxCliCredentialsPath(options?.homeDir);
  return readPortalCliOauthCredentials(credPath, "minimax-portal");
}

function buildUpdatedCodexAuthRecord(
  existing: Record<string, unknown> | null,
  newCredentials: OAuthCredentials,
): Record<string, unknown> {
  const next = existing ? { ...existing } : {};
  const existingTokens =
    next.tokens && typeof next.tokens === "object" ? (next.tokens as Record<string, unknown>) : {};
  next.auth_mode = next.auth_mode ?? "chatgpt";
  next.tokens = {
    ...existingTokens,
    access_token: newCredentials.access,
    refresh_token: newCredentials.refresh,
    ...(typeof newCredentials.accountId === "string" && newCredentials.accountId.trim().length > 0
      ? { account_id: newCredentials.accountId }
      : {}),
  };
  next.last_refresh = new Date().toISOString();
  return next;
}

export function writeCodexCliKeychainCredentials(
  newCredentials: OAuthCredentials,
  options?: {
    codexHome?: string;
    platform?: NodeJS.Platform;
    execSync?: ExecSyncFn;
    execFileSync?: ExecFileSyncFn;
  },
): boolean {
  const { platform, codexHome } = resolveCodexKeychainParams(options);
  if (platform !== "darwin") {
    return false;
  }
  const existing = readCodexKeychainAuthRecord(options);
  if (!existing) {
    return false;
  }

  const execFileSyncImpl = options?.execFileSync ?? execFileSync;
  const account = computeCodexKeychainAccount(codexHome);
  const next = buildUpdatedCodexAuthRecord(existing, newCredentials);

  try {
    execFileSyncImpl(
      "security",
      ["add-generic-password", "-U", "-s", "Codex Auth", "-a", account, "-w", JSON.stringify(next)],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    codexCliCache = null;
    log.info("wrote refreshed credentials to codex cli keychain", {
      expires: new Date(newCredentials.expires).toISOString(),
    });
    return true;
  } catch (error) {
    log.warn("failed to write credentials to codex cli keychain", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function writeCodexCliFileCredentials(
  newCredentials: OAuthCredentials,
  options?: CodexCliFileOptions,
): boolean {
  const codexHome = resolveCodexHomePath(options?.codexHome);
  const authPath = path.join(codexHome, CODEX_CLI_AUTH_FILENAME);
  if (!fs.existsSync(authPath)) {
    return false;
  }

  try {
    const raw = loadJsonFile(authPath);
    if (!raw || typeof raw !== "object") {
      return false;
    }
    const next = buildUpdatedCodexAuthRecord(raw as Record<string, unknown>, newCredentials);
    saveJsonFile(authPath, next);
    codexCliCache = null;
    log.info("wrote refreshed credentials to codex cli file", {
      expires: new Date(newCredentials.expires).toISOString(),
    });
    return true;
  } catch (error) {
    log.warn("failed to write credentials to codex cli file", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function writeCodexCliCredentials(
  newCredentials: OAuthCredentials,
  options?: CodexCliWriteOptions,
): boolean {
  const platform = options?.platform ?? process.platform;
  const writeKeychain = options?.writeKeychain ?? writeCodexCliKeychainCredentials;
  const writeFile =
    options?.writeFile ??
    ((credentials, fileOptions) => writeCodexCliFileCredentials(credentials, fileOptions));

  if (
    platform === "darwin" &&
    writeKeychain(newCredentials, {
      codexHome: options?.codexHome,
      platform,
      execSync: options?.execSync,
      execFileSync: options?.execFileSync,
    })
  ) {
    return true;
  }

  return writeFile(newCredentials, { codexHome: options?.codexHome });
}

export function readCodexCliCredentials(options?: {
  codexHome?: string;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliCredential | null {
  const keychain = readCodexKeychainCredentials({
    codexHome: options?.codexHome,
    platform: options?.platform,
    execSync: options?.execSync,
  });
  if (keychain) {
    return keychain;
  }

  const authPath = path.join(resolveCodexHomePath(options?.codexHome), CODEX_CLI_AUTH_FILENAME);
  const raw = loadJsonFile(authPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const data = raw as Record<string, unknown>;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== "object") {
    return null;
  }

  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;

  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return null;
  }

  let fallbackExpiry: number;
  try {
    const stat = fs.statSync(authPath);
    fallbackExpiry = stat.mtimeMs + 60 * 60 * 1000;
  } catch {
    fallbackExpiry = Date.now() + 60 * 60 * 1000;
  }
  const expires = decodeJwtExpiryMs(accessToken) ?? fallbackExpiry;

  return {
    type: "oauth",
    provider: "openai-codex" as OAuthProvider,
    access: accessToken,
    refresh: refreshToken,
    expires,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
  };
}

export function readCodexCliCredentialsCached(options?: {
  codexHome?: string;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliCredential | null {
  const authPath = path.join(resolveCodexHomePath(options?.codexHome), CODEX_CLI_AUTH_FILENAME);
  return readCachedCliCredential({
    ttlMs: options?.ttlMs ?? 0,
    cache: codexCliCache,
    cacheKey: `${options?.platform ?? process.platform}|${authPath}`,
    read: () =>
      readCodexCliCredentials({
        codexHome: options?.codexHome,
        platform: options?.platform,
        execSync: options?.execSync,
      }),
    setCache: (next) => {
      codexCliCache = next;
    },
    readSourceFingerprint: () => readFileMtimeMs(authPath),
  });
}

export function readMiniMaxCliCredentialsCached(options?: {
  ttlMs?: number;
  homeDir?: string;
}): MiniMaxCliCredential | null {
  const credPath = resolveMiniMaxCliCredentialsPath(options?.homeDir);
  return readCachedCliCredential({
    ttlMs: options?.ttlMs ?? 0,
    cache: minimaxCliCache,
    cacheKey: credPath,
    read: () => readMiniMaxCliCredentials({ homeDir: options?.homeDir }),
    setCache: (next) => {
      minimaxCliCache = next;
    },
    readSourceFingerprint: () => readFileMtimeMs(credPath),
  });
}
