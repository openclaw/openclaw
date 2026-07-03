// Google plugin module imports official Gemini CLI OAuth cache files.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GeminiCliOAuthCredentials } from "./oauth.shared.js";

const GEMINI_DIR = ".gemini";
const OAUTH_FILE = "oauth_creds.json";
const GOOGLE_ACCOUNTS_FILE = "google_accounts.json";

type GeminiCliOfficialOAuthCredentials = GeminiCliOAuthCredentials & {
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
let cachedOfficialOAuthCredentials: GeminiCliOfficialOAuthCredentials | null = null;
let officialOAuthCacheImportError: string | null = null;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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

function resolveGeminiCliHome(): string {
  const envHome = normalizeString(process.env.GEMINI_CLI_HOME);
  return envHome ?? officialOAuthCacheFs.homedir();
}

function resolveOfficialGeminiCliOAuthCachePath(): string {
  return join(resolveGeminiCliHome(), GEMINI_DIR, OAUTH_FILE);
}

function resolveOfficialGeminiCliAccountsPath(): string {
  return join(resolveGeminiCliHome(), GEMINI_DIR, GOOGLE_ACCOUNTS_FILE);
}

function parseOfficialGeminiCliOAuthCache(
  raw: string,
  sourcePath: string,
): GeminiCliOfficialOAuthCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const access = normalizeString(parsed.access_token ?? parsed.access);
  const refresh = normalizeString(parsed.refresh_token ?? parsed.refresh);
  if (!access || !refresh) {
    return null;
  }

  const expires =
    normalizeNumber(parsed.expiry_date ?? parsed.expires ?? parsed.expiresAt) ?? Date.now();
  const idToken = normalizeString(parsed.id_token ?? parsed.idToken);

  return {
    access,
    refresh,
    expires,
    sourcePath,
    ...(idToken ? { idToken } : {}),
  };
}

function readActiveGoogleAccount(): string | undefined {
  const accountsPath = resolveOfficialGeminiCliAccountsPath();
  if (!officialOAuthCacheFs.existsSync(accountsPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(officialOAuthCacheFs.readFileSync(accountsPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return normalizeString(parsed.active);
  } catch {
    return undefined;
  }
}

function readProjectIdFromEnv(): string | undefined {
  return normalizeString(process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT_ID);
}

export function clearOfficialGeminiCliOAuthCacheImportForTest(): void {
  cachedOfficialOAuthCredentials = null;
  officialOAuthCacheImportError = null;
}

export function setOfficialGeminiCliOAuthCacheFsForTest(
  overrides?: Partial<OfficialOAuthCacheFs>,
): void {
  officialOAuthCacheFs = overrides ? { ...defaultFs, ...overrides } : defaultFs;
  clearOfficialGeminiCliOAuthCacheImportForTest();
}

export function importOfficialGeminiCliOAuthCredentials(): GeminiCliOfficialOAuthCredentials | null {
  if (cachedOfficialOAuthCredentials) {
    return cachedOfficialOAuthCredentials;
  }

  officialOAuthCacheImportError = null;
  const cachePath = resolveOfficialGeminiCliOAuthCachePath();
  if (!officialOAuthCacheFs.existsSync(cachePath)) {
    officialOAuthCacheImportError = `Official Gemini CLI OAuth cache not found at ${cachePath}.`;
    return null;
  }

  try {
    const parsed = parseOfficialGeminiCliOAuthCache(
      officialOAuthCacheFs.readFileSync(cachePath, "utf8"),
      cachePath,
    );
    if (!parsed) {
      officialOAuthCacheImportError = `Official Gemini CLI OAuth cache is not a usable OAuth credential file: ${cachePath}.`;
      return null;
    }

    const email = readActiveGoogleAccount();
    const projectId = readProjectIdFromEnv();
    cachedOfficialOAuthCredentials = {
      ...parsed,
      ...(email ? { email } : {}),
      ...(projectId ? { projectId } : {}),
    };
    return cachedOfficialOAuthCredentials;
  } catch (error) {
    officialOAuthCacheImportError = `Failed to import official Gemini CLI OAuth cache from ${cachePath}: ${formatError(error)}`;
    return null;
  }
}

export function requireOfficialGeminiCliOAuthCredentials(): GeminiCliOfficialOAuthCredentials {
  const credentials = importOfficialGeminiCliOAuthCredentials();
  if (credentials) {
    return credentials;
  }

  const detail = officialOAuthCacheImportError ? ` Details: ${officialOAuthCacheImportError}` : "";
  throw new Error(
    [
      "No usable official Gemini CLI OAuth cache was found.",
      "Run `gemini`, choose Sign in with Google, complete the browser flow, then retry OpenClaw setup.",
      "For headless use, configure GEMINI_API_KEY and use the `google` provider instead, or configure Vertex AI separately.",
      detail.trim(),
    ]
      .filter(Boolean)
      .join(" "),
  );
}
