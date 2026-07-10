// Imports OAuth credentials created and owned by the official Gemini CLI.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GeminiCliOAuthCredentials } from "./oauth.shared.js";

const GEMINI_DIR = ".gemini";
const OAUTH_FILE = "oauth_creds.json";
const GOOGLE_ACCOUNTS_FILE = "google_accounts.json";

type OfficialGeminiCliOAuthCredentials = GeminiCliOAuthCredentials & {
  idToken?: string;
  sourcePath: string;
};

type OfficialOAuthCacheFs = {
  existsSync: (path: Parameters<typeof existsSync>[0]) => ReturnType<typeof existsSync>;
  readFileSync: (path: Parameters<typeof readFileSync>[0], encoding: "utf8") => string;
  homedir: () => string;
};

const defaultFs: OfficialOAuthCacheFs = {
  existsSync,
  readFileSync,
  homedir,
};

let officialOAuthCacheFs: OfficialOAuthCacheFs = defaultFs;

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeEmail(value: unknown): string | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized?.includes("@") ? normalized : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveGeminiCliHome(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeString(env.GEMINI_CLI_HOME) ?? officialOAuthCacheFs.homedir();
}

export function resolveOfficialGeminiCliOAuthCachePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveGeminiCliHome(env), GEMINI_DIR, OAUTH_FILE);
}

function resolveOfficialGeminiCliAccountsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGeminiCliHome(env), GEMINI_DIR, GOOGLE_ACCOUNTS_FILE);
}

function parseOAuthCache(raw: string, sourcePath: string): OfficialGeminiCliOAuthCredentials {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Official Gemini CLI OAuth cache must be a JSON object: ${sourcePath}`);
  }

  const access = normalizeString(parsed.access_token ?? parsed.access);
  const refresh = normalizeString(parsed.refresh_token ?? parsed.refresh);
  const expires = normalizeNumber(parsed.expiry_date ?? parsed.expires ?? parsed.expiresAt);
  if (!access || !refresh || expires === undefined) {
    throw new Error(`Official Gemini CLI OAuth cache is missing token material: ${sourcePath}`);
  }

  const idToken = normalizeString(parsed.id_token ?? parsed.idToken);
  const email = normalizeEmail(
    parsed.email ?? parsed.account ?? parsed.user_email ?? parsed.userEmail,
  );
  return {
    access,
    refresh,
    expires,
    sourcePath,
    ...(idToken ? { idToken } : {}),
    ...(email ? { email } : {}),
  };
}

function readActiveGoogleAccount(env: NodeJS.ProcessEnv): string {
  const accountsPath = resolveOfficialGeminiCliAccountsPath(env);
  if (!officialOAuthCacheFs.existsSync(accountsPath)) {
    throw new Error(
      `Official Gemini CLI account identity was not found at ${accountsPath}. Run \`gemini\`, choose Sign in with Google, then retry.`,
    );
  }

  const parsed = JSON.parse(officialOAuthCacheFs.readFileSync(accountsPath, "utf8")) as unknown;
  const activeEmail = isRecord(parsed) ? normalizeEmail(parsed.active) : undefined;
  if (!activeEmail) {
    throw new Error(`Official Gemini CLI active account is missing or invalid: ${accountsPath}`);
  }
  return activeEmail;
}

function readProjectId(env: NodeJS.ProcessEnv): string | undefined {
  return normalizeString(env.GOOGLE_CLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT_ID);
}

export function importOfficialGeminiCliOAuthCredentials(
  env: NodeJS.ProcessEnv = process.env,
): OfficialGeminiCliOAuthCredentials | null {
  try {
    return requireOfficialGeminiCliOAuthCredentials(env);
  } catch {
    return null;
  }
}

export function requireOfficialGeminiCliOAuthCredentials(
  env: NodeJS.ProcessEnv = process.env,
): OfficialGeminiCliOAuthCredentials {
  const cachePath = resolveOfficialGeminiCliOAuthCachePath(env);
  if (!officialOAuthCacheFs.existsSync(cachePath)) {
    throw new Error(
      `Official Gemini CLI OAuth cache not found at ${cachePath}. Run \`gemini\`, choose Sign in with Google, then retry.`,
    );
  }

  const parsed = parseOAuthCache(officialOAuthCacheFs.readFileSync(cachePath, "utf8"), cachePath);
  const activeEmail = readActiveGoogleAccount(env);
  if (parsed.email && parsed.email !== activeEmail) {
    throw new Error(
      `Official Gemini CLI OAuth cache identity ${parsed.email} does not match active account ${activeEmail}.`,
    );
  }

  const projectId = readProjectId(env);
  return {
    ...parsed,
    email: activeEmail,
    ...(projectId ? { projectId } : {}),
  };
}

export function setOfficialGeminiCliOAuthCacheFsForTest(
  overrides?: Partial<OfficialOAuthCacheFs>,
): void {
  officialOAuthCacheFs = overrides ? { ...defaultFs, ...overrides } : defaultFs;
}
