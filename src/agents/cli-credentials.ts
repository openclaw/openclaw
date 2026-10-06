import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveOsHomeRelativePath } from "../infra/home-dir.js";
import { loadJsonFileThroughSymlink } from "../infra/json-file.js";
import type { OAuthProvider } from "./auth-profiles/types.js";

const CODEX_CLI_AUTH_FILENAME = "auth.json";
const MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH = ".minimax/oauth_creds.json";
const GEMINI_CLI_CREDENTIALS_RELATIVE_PATH = ".gemini/oauth_creds.json";
const CODEX_CLI_FALLBACK_EXPIRY_MS = 60 * 60 * 1000;

type CachedValue<T> = {
  value: T | null;
  readAt: number;
  cacheKey: string;
  sourceFingerprint?: number | string | null;
};

let codexCliCache: CachedValue<CodexCliCredential> | null = null;
let minimaxCliCache: CachedValue<MiniMaxCliCredential> | null = null;
let geminiCliCache: CachedValue<GeminiCliCredential> | null = null;

export type CodexCliCredential = {
  type: "oauth";
  provider: OAuthProvider;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  idToken?: string;
};

export type CodexCliApiKeyCredential = {
  type: "api_key";
  provider: "openai";
  key: string;
};

type MiniMaxCliCredential = {
  type: "oauth";
  provider: "minimax-portal";
  access: string;
  refresh: string;
  expires: number;
};

export type GeminiCliCredential = {
  type: "oauth";
  provider: "google-gemini-cli";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
};

type ExecSyncFn = typeof execSync;

export function resolveCodexCliHomePath(codexHome?: string, env: NodeJS.ProcessEnv = process.env) {
  const configured = codexHome ?? env.CODEX_HOME;
  // External CLI state belongs to the OS user, not OpenClaw's relocatable
  // home. Otherwise an isolated OPENCLAW_HOME hides an already logged-in CLI.
  const home = resolveOsHomeRelativePath(configured || "~/.codex", { env });
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function codexAuthJsonUsesChatGptTokens(data: Record<string, unknown>): boolean {
  const authMode = typeof data.auth_mode === "string" ? data.auth_mode.toLowerCase() : undefined;
  if (authMode) {
    return authMode === "chatgpt" || authMode === "chatgptauthtokens";
  }
  return typeof data.OPENAI_API_KEY !== "string";
}

function codexAuthJsonUsesApiKey(data: Record<string, unknown>): boolean {
  const authMode = typeof data.auth_mode === "string" ? data.auth_mode.toLowerCase() : undefined;
  if (authMode) {
    return authMode === "apikey" || authMode === "api_key";
  }
  return typeof data.OPENAI_API_KEY === "string";
}

function resolveMiniMaxCliCredentialsPath(homeDir?: string) {
  const baseDir = resolveOsHomeRelativePath(homeDir ?? "~");
  return path.join(baseDir, MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH);
}

function resolveGeminiCliCredentialsPath(homeDir?: string) {
  const baseDir = resolveOsHomeRelativePath(homeDir ?? "~");
  return path.join(baseDir, GEMINI_CLI_CREDENTIALS_RELATIVE_PATH);
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
    codexHome: resolveCodexCliHomePath(options?.codexHome),
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const encodedPayload = token.split(".").at(1);
  if (!encodedPayload) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    return asOptionalRecord(payload);
  } catch {
    return undefined;
  }
}

function decodeJwtExpiryMs(token: string): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp > 0
    ? (asDateTimestampMs(exp * 1000) ?? null)
    : null;
}

function readCodexKeychainAuthRecord(options?: {
  codexHome?: string;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
  allowKeychainPrompt?: boolean;
}): Record<string, unknown> | null {
  const { platform, execSyncImpl, codexHome } = resolveCodexKeychainParams(options);
  if (platform !== "darwin" || options?.allowKeychainPrompt === false) {
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

function resolveCodexFallbackExpiryMs(nowMs?: number): number | undefined {
  const baseMs = nowMs === undefined ? undefined : Math.floor(nowMs);
  return resolveExpiresAtMsFromDurationMs(CODEX_CLI_FALLBACK_EXPIRY_MS, { nowMs: baseMs });
}

function parseCodexOauthCredential(
  data: Record<string, unknown>,
  fallbackExpiry: number | undefined,
): CodexCliCredential | null {
  if (!codexAuthJsonUsesChatGptTokens(data)) {
    return null;
  }
  const tokens = data.tokens as Record<string, unknown> | undefined;
  const accessToken = tokens?.access_token;
  const refreshToken = tokens?.refresh_token;
  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return null;
  }

  const expires = decodeJwtExpiryMs(accessToken) ?? fallbackExpiry;
  if (expires === undefined) {
    return null;
  }
  return {
    type: "oauth",
    provider: "openai" as OAuthProvider,
    access: accessToken,
    refresh: refreshToken,
    expires,
    accountId: typeof tokens?.account_id === "string" ? tokens.account_id : undefined,
    idToken: typeof tokens?.id_token === "string" ? tokens.id_token : undefined,
  };
}

function parseCodexApiKeyCredential(
  data: Record<string, unknown>,
): CodexCliApiKeyCredential | null {
  if (!codexAuthJsonUsesApiKey(data)) {
    return null;
  }
  const key = typeof data.OPENAI_API_KEY === "string" ? data.OPENAI_API_KEY.trim() : "";
  return key ? { type: "api_key", provider: "openai", key } : null;
}

function readCliOauthTokenFields(
  data: Record<string, unknown>,
): { access: string; refresh: string; expires: number } | null {
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

  return { access: accessToken, refresh: refreshToken, expires: expiresAt };
}

function readMiniMaxCliCredentials(credPath: string): MiniMaxCliCredential | null {
  const raw = loadJsonFileThroughSymlink(credPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const tokens = readCliOauthTokenFields(raw as Record<string, unknown>);
  return tokens ? { type: "oauth", provider: "minimax-portal", ...tokens } : null;
}

function readGeminiCliCredentials(credPath: string): GeminiCliCredential | null {
  const raw = loadJsonFileThroughSymlink(credPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const tokens = readCliOauthTokenFields(data);
  if (!tokens) {
    return null;
  }

  // Non-secret Google identity changes the auth epoch when another account signs in,
  // retiring stale session bindings.
  const idTokenRaw = data.id_token;
  const identity =
    typeof idTokenRaw === "string" && idTokenRaw ? decodeJwtPayload(idTokenRaw) : undefined;

  return {
    type: "oauth",
    provider: "google-gemini-cli",
    ...tokens,
    ...(typeof identity?.email === "string" && identity.email ? { email: identity.email } : {}),
    ...(typeof identity?.sub === "string" && identity.sub ? { accountId: identity.sub } : {}),
  };
}

function formatCodexApiKeyForLoginStatus(key: string): string {
  return key.length <= 13 ? "***" : `${key.slice(0, 8)}***${key.slice(-5)}`;
}

/** Reads an API key only when Codex confirms that exact credential is active. */
export function readCodexCliActiveApiKey(options?: {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliApiKeyCredential | null {
  const { execSyncImpl, codexHome } = resolveCodexKeychainParams(options);
  let status: string;
  try {
    status = execSyncImpl("codex login status 2>&1", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHome },
    }).trim();
  } catch {
    return null;
  }
  const statusMatch = /^Logged in using an API key - (.+)$/mu.exec(status);
  const activeFingerprint = statusMatch?.[1]?.trim();
  const legacyApiKeyStatus = status.trim() === "Logged in using an API key";
  if (!activeFingerprint && !legacyApiKeyStatus) {
    return null;
  }

  const candidates: CodexCliApiKeyCredential[] = [];
  const authPath = path.join(codexHome, CODEX_CLI_AUTH_FILENAME);
  const raw = loadJsonFileThroughSymlink(authPath);
  if (raw && typeof raw === "object") {
    const fileCredential = parseCodexApiKeyCredential(raw as Record<string, unknown>);
    if (fileCredential) {
      candidates.push(fileCredential);
    }
  }
  const keychainRecord = readCodexKeychainAuthRecord({
    codexHome,
    allowKeychainPrompt: options?.allowKeychainPrompt,
    platform: options?.platform,
    execSync: options?.execSync,
  });
  if (keychainRecord) {
    const keychainCredential = parseCodexApiKeyCredential(keychainRecord);
    if (keychainCredential) {
      candidates.push(keychainCredential);
    }
  }

  const matchingKeys = new Set(
    candidates
      .filter(
        (candidate) =>
          legacyApiKeyStatus ||
          formatCodexApiKeyForLoginStatus(candidate.key) === activeFingerprint,
      )
      .map((candidate) => candidate.key),
  );
  if (matchingKeys.size !== 1) {
    return null;
  }
  const key = [...matchingKeys][0];
  return key ? { type: "api_key", provider: "openai", key } : null;
}

function readCodexCliCredentials(options?: {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliCredential | null {
  const keychainRecord = readCodexKeychainAuthRecord(options);
  if (keychainRecord) {
    const lastRefreshRaw = keychainRecord.last_refresh;
    const lastRefresh =
      typeof lastRefreshRaw === "string" || typeof lastRefreshRaw === "number"
        ? new Date(lastRefreshRaw).getTime()
        : Date.now();
    const keychainCredential = parseCodexOauthCredential(
      keychainRecord,
      resolveCodexFallbackExpiryMs(lastRefresh) ?? resolveCodexFallbackExpiryMs(),
    );
    if (keychainCredential) {
      return keychainCredential;
    }
  }

  const authPath = path.join(resolveCodexCliHomePath(options?.codexHome), CODEX_CLI_AUTH_FILENAME);
  const raw = loadJsonFileThroughSymlink(authPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  let fallbackExpiry: number | undefined;
  try {
    fallbackExpiry = resolveCodexFallbackExpiryMs(fs.statSync(authPath).mtimeMs);
  } catch {
    fallbackExpiry = resolveCodexFallbackExpiryMs();
  }
  return parseCodexOauthCredential(raw as Record<string, unknown>, fallbackExpiry);
}

export function readCodexCliCredentialsCached(options?: {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliCredential | null {
  const platform = options?.platform ?? process.platform;
  const ttlMs = options?.ttlMs ?? 0;
  const authPath = path.join(resolveCodexCliHomePath(options?.codexHome), CODEX_CLI_AUTH_FILENAME);
  const keychainIntent =
    platform === "darwin" && options?.allowKeychainPrompt !== false ? "keychain" : "file";
  return readCachedCliCredential({
    ttlMs,
    cache: codexCliCache,
    cacheKey: `${platform}|${authPath}:${keychainIntent}`,
    read: () =>
      readCodexCliCredentials({
        codexHome: options?.codexHome,
        allowKeychainPrompt: options?.allowKeychainPrompt,
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
    read: () => readMiniMaxCliCredentials(credPath),
    setCache: (next) => {
      minimaxCliCache = next;
    },
    readSourceFingerprint: () => readFileMtimeMs(credPath),
  });
}

export function readGeminiCliCredentialsCached(options?: {
  ttlMs?: number;
  homeDir?: string;
}): GeminiCliCredential | null {
  const credPath = resolveGeminiCliCredentialsPath(options?.homeDir);
  return readCachedCliCredential({
    ttlMs: options?.ttlMs ?? 0,
    cache: geminiCliCache,
    cacheKey: credPath,
    read: () => readGeminiCliCredentials(credPath),
    setCache: (next) => {
      geminiCliCache = next;
    },
    readSourceFingerprint: () => readFileMtimeMs(credPath),
  });
}
