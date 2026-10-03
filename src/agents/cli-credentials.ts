/**
 * Reads and refreshes credentials stored by external CLI runtimes such as
 * Codex, Gemini, and MiniMax.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import { resolveOsHomeRelativePath } from "../infra/home-dir.js";
import { loadJsonFileThroughSymlink } from "../infra/json-file.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import type { OAuthProvider } from "./auth-profiles/types.js";

const CODEX_CLI_AUTH_FILENAME = "auth.json";
const MINIMAX_CLI_CREDENTIALS_RELATIVE_PATH = ".minimax/oauth_creds.json";
const GEMINI_CLI_CREDENTIALS_RELATIVE_PATH = ".gemini/oauth_creds.json";
const CODEX_CLI_FALLBACK_EXPIRY_MS = 60 * 60 * 1000;
// `codex login status` exits 1 both when logged out and when the check fails;
// only this exact message means Codex has no login.
const CODEX_NOT_LOGGED_IN_STATUS = "Not logged in";
// `security` exits 44 (errSecItemNotFound) when Codex has no Keychain login.
const SECURITY_ITEM_NOT_FOUND_EXIT_CODE = 44;
// Codex's own failure lines name the failed step; their details can quote auth
// data, so only the known prefix is surfaced.
const CODEX_LOGIN_STATUS_FAILURES = [
  ["Error checking login status:", "Codex could not check its login status"],
  ["Unexpected error retrieving API key:", "Codex could not read its saved API key"],
] as const;

type CachedValue<T> = {
  value: T | null;
  readAt: number;
  cacheKey: string;
  sourceFingerprint?: number | string | null;
};

let codexCliCache: CachedValue<CodexCliCredential> | null = null;
let minimaxCliCache: CachedValue<MiniMaxCliCredential> | null = null;
let geminiCliCache: CachedValue<GeminiCliCredential> | null = null;

/** Credential shape parsed from Codex CLI storage. */
export type CodexCliCredential = {
  type: "oauth";
  provider: OAuthProvider;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  idToken?: string;
};

/** API-key credential parsed from the active Codex CLI auth mode. */
type CodexCliApiKeyCredential = {
  type: "api_key";
  provider: "openai";
  key: string;
};

/**
 * Outcome of reusing the API key that Codex reports as active. `unreadable`
 * means a Codex login may exist but could not be confirmed or read, so callers
 * must not treat it as logged out.
 */
export type CodexCliActiveApiKeyResult =
  | { status: "active"; credential: CodexCliApiKeyCredential }
  | { status: "none" }
  | { status: "unreadable"; reason: string };

type CodexKeychainAuthRead =
  | { status: "found"; record: Record<string, unknown> }
  | { status: "none" }
  | { status: "unreadable"; reason: string };

/** Credential shape parsed from MiniMax portal CLI storage. */
type MiniMaxCliCredential = {
  type: "oauth";
  provider: "minimax-portal";
  access: string;
  refresh: string;
  expires: number;
};

/** Credential shape parsed from Gemini CLI storage. */
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

/** Describes a failed CLI invocation without echoing its output, which may hold secrets. */
function describeCliExecFailure(command: string, failure: Record<string, unknown> | undefined) {
  if (failure?.code === "ETIMEDOUT") {
    return `\`${command}\` timed out`;
  }
  if (typeof failure?.status === "number") {
    return `\`${command}\` exited with code ${failure.status}`;
  }
  return `\`${command}\` could not run`;
}

function readCodexKeychainAuth(options?: {
  codexHome?: string;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
  allowKeychainPrompt?: boolean;
}): CodexKeychainAuthRead {
  const { platform, execSyncImpl, codexHome } = resolveCodexKeychainParams(options);
  if (platform !== "darwin" || options?.allowKeychainPrompt === false) {
    return { status: "none" };
  }
  const account = computeCodexKeychainAccount(codexHome);

  let secret: string;
  try {
    secret = execSyncImpl(`security find-generic-password -s "Codex Auth" -a "${account}" -w`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = asOptionalRecord(error);
    if (failure?.status === SECURITY_ITEM_NOT_FOUND_EXIT_CODE) {
      return { status: "none" };
    }
    return {
      status: "unreadable",
      reason: `the macOS Keychain did not return the Codex login (${describeCliExecFailure("security", failure)})`,
    };
  }
  let record: Record<string, unknown> | undefined;
  try {
    record = asOptionalRecord(JSON.parse(secret));
  } catch {
    record = undefined;
  }
  return record
    ? { status: "found", record }
    : { status: "unreadable", reason: "the Codex login in the macOS Keychain is not valid JSON" };
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

function readPortalCliOauthCredentials<TProvider extends string>(
  credPath: string,
  provider: TProvider,
): { type: "oauth"; provider: TProvider; access: string; refresh: string; expires: number } | null {
  const raw = loadJsonFileThroughSymlink(credPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const tokens = readCliOauthTokenFields(raw as Record<string, unknown>);
  return tokens ? { type: "oauth", provider, ...tokens } : null;
}

function readMiniMaxCliCredentials(options?: { homeDir?: string }): MiniMaxCliCredential | null {
  const credPath = resolveMiniMaxCliCredentialsPath(options?.homeDir);
  return readPortalCliOauthCredentials(credPath, "minimax-portal");
}

function readGeminiCliCredentials(options?: { homeDir?: string }): GeminiCliCredential | null {
  const credPath = resolveGeminiCliCredentialsPath(options?.homeDir);
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

/**
 * Reads Codex's top-level `cli_auth_credentials_store` from its user config.
 * Unset, unreadable, or table-scoped values mean Codex's default `file` store.
 */
function readCodexCredentialsStoreMode(codexHome: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      // Top-level keys precede the first table header; later ones are profile-scoped.
      return undefined;
    }
    const match = /^cli_auth_credentials_store\s*=\s*["']([a-z]+)["']/u.exec(trimmed);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Reads the credential store Codex itself resolved, including system, managed, and
 * command-line configuration that config.toml alone cannot show. `codex doctor` exits 1
 * whenever any check fails but still prints its report, so stdout is read either way.
 */
function readCodexEffectiveStoreMode(execSyncImpl: ExecSyncFn, codexHome: string) {
  let output: string;
  try {
    output = execSyncImpl("codex doctor --json", {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHome },
    });
  } catch (error) {
    const stdout = asOptionalRecord(error)?.stdout;
    output = typeof stdout === "string" ? stdout : "";
  }
  try {
    const report = asOptionalRecord(JSON.parse(output.slice(Math.max(output.indexOf("{"), 0))));
    const credentials = asOptionalRecord(asOptionalRecord(report?.checks)?.["auth.credentials"]);
    const mode = asOptionalRecord(credentials?.details)?.["auth storage mode"];
    return typeof mode === "string" ? mode.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

// cmd.exe exits 1 with a localized message for a missing command, so a failed
// status check alone cannot tell "not installed" from "installed but failing".
function isCodexCliOnPath(): boolean {
  const pathEnv = resolveEnvironmentValue(process.env, "PATH") ?? "";
  // A removed working directory holds no codex to find, so search PATH alone.
  const cwd = tryProcessCwd();
  // cmd.exe also searches the working directory before PATH.
  const searchPath = process.platform === "win32" && cwd ? `${cwd};${pathEnv}` : pathEnv;
  return Boolean(
    resolveExecutableFromPathEnv("codex", searchPath, process.env, {
      ...(cwd ? { cwd } : {}),
      useCache: false,
    }),
  );
}

function readCodexLoginStatus(
  execSyncImpl: ExecSyncFn,
  codexHome: string,
):
  | { status: "reported"; output: string }
  | { status: "logged-out" }
  | Exclude<CodexCliActiveApiKeyResult, { status: "active" }> {
  try {
    const output = execSyncImpl("codex login status 2>&1", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHome },
    }).trim();
    return { status: "reported", output };
  } catch (error) {
    const failure = asOptionalRecord(error);
    const lines = typeof failure?.stdout === "string" ? failure.stdout.split(/\r?\n/u) : [];
    if (lines.some((line) => line.trim() === CODEX_NOT_LOGGED_IN_STATUS)) {
      return { status: "logged-out" };
    }
    if (!isCodexCliOnPath()) {
      return { status: "none" };
    }
    const codexFailure = CODEX_LOGIN_STATUS_FAILURES.find(([prefix]) =>
      lines.some((line) => line.trim().startsWith(prefix)),
    );
    return {
      status: "unreadable",
      reason: codexFailure?.[1] ?? describeCliExecFailure("codex login status", failure),
    };
  }
}

/** Reads an API key only when Codex confirms that exact credential is active. */
export function readCodexCliActiveApiKey(options?: {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliActiveApiKeyResult {
  const { execSyncImpl, codexHome } = resolveCodexKeychainParams(options);
  const loginStatus = readCodexLoginStatus(execSyncImpl, codexHome);
  if (loginStatus.status === "logged-out") {
    // Only Codex's `auto` store falls back to an empty auth.json after a failed Keychain read
    // and then reports "Not logged in"; in `file` mode (the default) the Keychain is irrelevant.
    const keychain = readCodexKeychainAuth({
      codexHome,
      allowKeychainPrompt: options?.allowKeychainPrompt,
      platform: options?.platform,
      execSync: options?.execSync,
    });
    if (keychain.status !== "unreadable") {
      return { status: "none" };
    }
    const storeMode =
      readCodexEffectiveStoreMode(execSyncImpl, codexHome) ??
      readCodexCredentialsStoreMode(codexHome);
    return storeMode === "auto"
      ? { status: "unreadable", reason: keychain.reason }
      : { status: "none" };
  }
  if (loginStatus.status !== "reported") {
    return loginStatus;
  }
  const status = loginStatus.output;
  const statusMatch = /^Logged in using an API key - (.+)$/mu.exec(status);
  const activeFingerprint = statusMatch?.[1]?.trim();
  const legacyApiKeyStatus = status.trim() === "Logged in using an API key";
  if (!activeFingerprint && !legacyApiKeyStatus) {
    return { status: "none" };
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
  const keychain = readCodexKeychainAuth({
    codexHome,
    allowKeychainPrompt: options?.allowKeychainPrompt,
    platform: options?.platform,
    execSync: options?.execSync,
  });
  if (keychain.status === "found") {
    const keychainCredential = parseCodexApiKeyCredential(keychain.record);
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
  const [key] = matchingKeys;
  if (matchingKeys.size === 1 && key) {
    return { status: "active", credential: { type: "api_key", provider: "openai", key } };
  }
  if (matchingKeys.size > 1) {
    return {
      status: "unreadable",
      reason: "Codex reports an API key login, but more than one saved key could be that key",
    };
  }
  // Codex confirmed an API-key login, so a missing key is a read failure, not a logout.
  return {
    status: "unreadable",
    reason:
      keychain.status === "unreadable"
        ? keychain.reason
        : "Codex reports an API key login, but OpenClaw could not find that key where Codex stores it",
  };
}

/** Reads Codex CLI OAuth credentials from Keychain or CODEX_HOME auth.json. */
function readCodexCliCredentials(options?: {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliCredential | null {
  // Keychain read failures fall back to auth.json; only the active-key reader reports them.
  const keychain = readCodexKeychainAuth(options);
  const keychainRecord = keychain.status === "found" ? keychain.record : null;
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

/** Reads Codex CLI credentials with optional short-lived cache and file fingerprinting. */
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

/** Reads MiniMax CLI credentials with optional short-lived cache. */
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

/** Reads Gemini CLI credentials with optional short-lived cache. */
export function readGeminiCliCredentialsCached(options?: {
  ttlMs?: number;
  homeDir?: string;
}): GeminiCliCredential | null {
  const credPath = resolveGeminiCliCredentialsPath(options?.homeDir);
  return readCachedCliCredential({
    ttlMs: options?.ttlMs ?? 0,
    cache: geminiCliCache,
    cacheKey: credPath,
    read: () => readGeminiCliCredentials({ homeDir: options?.homeDir }),
    setCache: (next) => {
      geminiCliCache = next;
    },
    readSourceFingerprint: () => readFileMtimeMs(credPath),
  });
}
