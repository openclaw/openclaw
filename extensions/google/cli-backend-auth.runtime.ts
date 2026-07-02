import fs from "node:fs/promises";
import path from "node:path";
import type { CliBackendPreparedExecution } from "openclaw/plugin-sdk/cli-backend";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  GOOGLE_GEMINI_CLI_PROVIDER_ID,
  resolveGeminiCliProfileHome as resolveGeminiCliProfileHomePath,
} from "./gemini-cli-auth-home.js";

const GEMINI_CLI_PROVIDER_ID = GOOGLE_GEMINI_CLI_PROVIDER_ID;
const VERCEL_AI_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
const GEMINI_CLI_CREDENTIALS_FILENAME = "gemini-credentials.json";
const GEMINI_CLI_GCA_AUTH_ENV = [
  "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
  "GEMINI_FORCE_FILE_STORAGE",
];
const GEMINI_CLI_API_KEY_AUTH_ENV = [
  ...GEMINI_CLI_GCA_AUTH_ENV,
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_CLI_CUSTOM_HEADERS",
  "GEMINI_API_KEY_AUTH_MECHANISM",
];
const GEMINI_CLI_PROFILE_AUTH_ENV = [...GEMINI_CLI_API_KEY_AUTH_ENV, "GEMINI_API_KEY"];
const GEMINI_CLI_PROFILE_SETTINGS_ENV = ["GEMINI_CLI_SYSTEM_SETTINGS_PATH"];

type GeminiAuthProfileCredential = {
  kind?: "api_key" | "oauth" | "token";
  providerId?: string;
  type?: "api_key" | "oauth" | "token";
  provider?: string;
  key?: string;
  token?: string;
  access?: string;
  accessToken?: string;
  refresh?: string;
  refreshToken?: string;
  expires?: number;
  expiresAt?: number;
  idToken?: string;
  projectId?: string;
};

type GeminiOAuthCredential = GeminiAuthProfileCredential & {
  kind: "oauth";
  providerId: typeof GEMINI_CLI_PROVIDER_ID;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

type GeminiCliAuthHomeContext = {
  agentDir?: string;
  authProfileId?: string;
  systemSettingsPath?: string;
};

type GeminiCliAuthSelectedType = "oauth-personal" | "gemini-api-key";

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function throwUnsupportedGeminiCredential(credential: GeminiAuthProfileCredential): never {
  const provider = credential.providerId ?? credential.provider;
  if (provider === VERCEL_AI_GATEWAY_PROVIDER_ID) {
    throw new Error(
      "Gemini CLI execution cannot use a vercel-ai-gateway auth profile. Use the OpenClaw vercel-ai-gateway provider instead.",
    );
  }
  throw new Error("Gemini CLI execution requires a google-gemini-cli OAuth auth profile.");
}

function throwUnstageableSelectedGeminiProfile(
  ctx: GeminiCliAuthHomeContext,
  credential: GeminiAuthProfileCredential | undefined,
): never {
  const authProfileId = normalizeString(ctx.authProfileId);
  if (!authProfileId) {
    throw new Error("Gemini CLI execution requires a selected auth profile.");
  }
  if (!credential) {
    throw new Error(
      "Gemini CLI auth profile was selected but no credential material was found. Re-authenticate with `openclaw models auth login --provider google-gemini-cli --force`.",
    );
  }
  if ((credential.providerId ?? credential.provider) !== GEMINI_CLI_PROVIDER_ID) {
    throwUnsupportedGeminiCredential(credential);
  }
  throw new Error(
    "Gemini CLI execution supports google-gemini-cli OAuth auth profiles. Re-authenticate with `openclaw models auth login --provider google-gemini-cli --force`.",
  );
}

function requireGeminiOAuthCredential(
  credential: GeminiAuthProfileCredential | undefined,
): GeminiOAuthCredential | null {
  if (!credential) {
    return null;
  }
  const kind = credential.kind ?? credential.type;
  if (kind !== "oauth") {
    return null;
  }
  const providerId = credential.providerId ?? credential.provider;
  if (providerId !== GEMINI_CLI_PROVIDER_ID) {
    throwUnsupportedGeminiCredential(credential);
  }

  const accessToken = normalizeString(credential.accessToken ?? credential.access);
  const refreshToken = normalizeString(credential.refreshToken ?? credential.refresh);
  const expiresAt = credential.expiresAt ?? credential.expires;
  if (!accessToken) {
    throw new Error(
      "Gemini CLI OAuth profile is missing usable access token material. Re-authenticate with `openclaw models auth login --provider google-gemini-cli --force`.",
    );
  }

  return {
    ...credential,
    kind: "oauth",
    providerId: GEMINI_CLI_PROVIDER_ID,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(typeof expiresAt === "number" && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    projectId: normalizeString(credential.projectId),
  };
}

function resolveGeminiCliProfileHome(ctx: GeminiCliAuthHomeContext): {
  home: string;
  geminiDir: string;
} {
  const agentDir = normalizeString(ctx.agentDir);
  if (!agentDir) {
    throw new Error("Gemini CLI auth profile execution requires an agent directory.");
  }
  const authProfileId = normalizeString(ctx.authProfileId);
  if (!authProfileId) {
    throw new Error("Gemini CLI auth profile execution requires a selected auth profile.");
  }

  const home = resolveGeminiCliProfileHomePath(agentDir, authProfileId);
  return { home, geminiDir: path.join(home, ".gemini") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readGeminiAuthProfileCredential(
  credential: unknown,
): GeminiAuthProfileCredential | undefined {
  if (!isRecord(credential)) {
    return undefined;
  }
  return credential as GeminiAuthProfileCredential;
}

async function readGeminiCliJsonObject(
  filePath: string | undefined,
): Promise<Record<string, unknown>> {
  const normalized = normalizeString(filePath);
  if (!normalized) {
    return {};
  }
  try {
    const parsed = JSON.parse(await fs.readFile(normalized, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Gemini CLI system settings must be a JSON object: ${normalized}`);
    }
    return { ...parsed };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

function buildGeminiCliAuthSettings(
  selectedType: GeminiCliAuthSelectedType,
): Record<string, unknown> {
  return { security: { auth: { selectedType } } };
}

async function buildGeminiCliSystemSettings(
  ctx: GeminiCliAuthHomeContext,
  selectedType: GeminiCliAuthSelectedType,
): Promise<Record<string, unknown>> {
  const base = await readGeminiCliJsonObject(ctx.systemSettingsPath);
  const security = isRecord(base.security) ? { ...base.security } : {};
  const auth = isRecord(security.auth) ? { ...security.auth } : {};
  const enforcedType = normalizeString(
    typeof auth.enforcedType === "string" ? auth.enforcedType : undefined,
  );
  if (enforcedType && enforcedType !== selectedType) {
    throw new Error(
      `Gemini CLI system settings enforce ${enforcedType} auth, but the selected OpenClaw profile requires ${selectedType}.`,
    );
  }
  security.auth = { ...auth, selectedType };
  return {
    ...base,
    security,
  };
}

async function writeGeminiCliJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
}

async function prepareGeminiCliProfileHome(
  ctx: GeminiCliAuthHomeContext,
  selectedType: GeminiCliAuthSelectedType,
): Promise<{
  home: string;
  geminiDir: string;
  systemSettingsPath: string;
  cleanup: () => Promise<void>;
}> {
  const { home, geminiDir } = resolveGeminiCliProfileHome(ctx);
  await fs.mkdir(geminiDir, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  await fs.chmod(geminiDir, 0o700);
  const settings = buildGeminiCliAuthSettings(selectedType);
  const systemSettings = await buildGeminiCliSystemSettings(ctx, selectedType);
  const systemSettingsDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-gemini-cli-"),
  );
  await fs.chmod(systemSettingsDir, 0o700);
  const systemSettingsPath = path.join(systemSettingsDir, "settings.json");
  try {
    await Promise.all([
      writeGeminiCliJson(path.join(geminiDir, "settings.json"), settings),
      writeGeminiCliJson(path.join(home, "settings.json"), settings),
      writeGeminiCliJson(systemSettingsPath, systemSettings),
    ]);
  } catch (error) {
    await fs.rm(systemSettingsDir, { recursive: true, force: true });
    throw error;
  }
  return {
    home,
    geminiDir,
    systemSettingsPath,
    cleanup: async () => {
      await fs.rm(systemSettingsDir, { recursive: true, force: true });
    },
  };
}

async function clearGeminiCliCachedCredentials(geminiDir: string): Promise<void> {
  // Gemini prefers its token store over oauth_creds.json. Rebuild that store
  // from the selected OpenClaw profile each run so stale CLI auth cannot win.
  await fs.rm(path.join(geminiDir, GEMINI_CLI_CREDENTIALS_FILENAME), { force: true });
}

function buildGeminiCliProjectEnv(projectId: string | undefined): Record<string, string> {
  const normalized = normalizeString(projectId);
  if (!normalized) {
    return {};
  }
  return {
    GOOGLE_CLOUD_PROJECT: normalized,
    GOOGLE_CLOUD_PROJECT_ID: normalized,
    GOOGLE_CLOUD_QUOTA_PROJECT: normalized,
  };
}

async function prepareGeminiCliOAuthHome(
  ctx: GeminiCliAuthHomeContext,
  credential: GeminiAuthProfileCredential | undefined,
): Promise<CliBackendPreparedExecution | null> {
  const oauth = requireGeminiOAuthCredential(credential);
  if (!oauth) {
    return null;
  }

  const { home, geminiDir, systemSettingsPath, cleanup } = await prepareGeminiCliProfileHome(
    ctx,
    "oauth-personal",
  );
  await clearGeminiCliCachedCredentials(geminiDir);
  const idToken = normalizeString(oauth.idToken);
  const oauthCreds: Record<string, string | number> = {
    access_token: oauth.accessToken,
    ...(oauth.refreshToken ? { refresh_token: oauth.refreshToken } : {}),
    ...(typeof oauth.expiresAt === "number" ? { expiry_date: oauth.expiresAt } : {}),
    token_type: "Bearer",
  };
  if (idToken) {
    oauthCreds.id_token = idToken;
  }

  await writeGeminiCliJson(path.join(geminiDir, "oauth_creds.json"), oauthCreds);

  return {
    env: {
      GEMINI_CLI_HOME: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath,
      GEMINI_FORCE_FILE_STORAGE: "true",
      ...buildGeminiCliProjectEnv(oauth.projectId),
    },
    clearEnv: [...GEMINI_CLI_PROFILE_AUTH_ENV, ...GEMINI_CLI_PROFILE_SETTINGS_ENV],
    cleanup,
  };
}

export async function prepareGeminiCliAuthHome(
  ctx: GeminiCliAuthHomeContext,
  credential: unknown,
): Promise<CliBackendPreparedExecution | null> {
  const authCredential = readGeminiAuthProfileCredential(credential);
  const prepared = await prepareGeminiCliOAuthHome(ctx, authCredential);
  if (prepared) {
    return prepared;
  }
  if (normalizeString(ctx.authProfileId)) {
    throwUnstageableSelectedGeminiProfile(ctx, authCredential);
  }
  return null;
}
