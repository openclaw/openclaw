import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-3.1-flash-preview",
  "flash-lite": "gemini-3.1-flash-lite",
};
const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3-flash-preview";
const GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const VERCEL_AI_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
const GEMINI_CLI_CREDENTIALS_FILENAME = "gemini-credentials.json";
const GEMINI_CLI_GCA_AUTH_ENV = [
  "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
  "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
  "GEMINI_FORCE_FILE_STORAGE",
];
const GEMINI_CLI_API_KEY_AUTH_ENV = [
  ...GEMINI_CLI_GCA_AUTH_ENV,
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_CLI_CUSTOM_HEADERS",
  "GEMINI_API_KEY_AUTH_MECHANISM",
];
const GEMINI_CLI_PROFILE_AUTH_ENV = [...GEMINI_CLI_API_KEY_AUTH_ENV, "GEMINI_API_KEY"];

type PreparedGeminiCliExecution = {
  env: Record<string, string>;
  clearEnv: string[];
};

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

type GeminiAuthProfileCredential = {
  type: "api_key" | "oauth" | "token";
  provider: string;
  key?: string;
  token?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  idToken?: string;
};

type GeminiOAuthCredential = GeminiAuthProfileCredential & {
  type: "oauth";
  provider: typeof GEMINI_CLI_PROVIDER_ID;
  access: string;
  refresh: string;
  expires: number;
};

type GeminiApiKeyCredential = GeminiAuthProfileCredential & {
  type: "api_key";
  provider: typeof GEMINI_CLI_PROVIDER_ID;
  key: string;
};

type GeminiCliAuthHomeContext = {
  agentDir?: string;
  authProfileId?: string;
};

function throwUnsupportedGeminiCredential(credential: GeminiAuthProfileCredential): never {
  if (credential.provider === VERCEL_AI_GATEWAY_PROVIDER_ID) {
    throw new Error(
      "Gemini CLI execution cannot use a vercel-ai-gateway auth profile. Use the OpenClaw vercel-ai-gateway provider instead.",
    );
  }
  throw new Error("Gemini CLI execution requires a google-gemini-cli auth profile.");
}

function requireGeminiOAuthCredential(
  credential: GeminiAuthProfileCredential | undefined,
): GeminiOAuthCredential | null {
  if (!credential) {
    return null;
  }
  if (credential.type !== "oauth") {
    return null;
  }
  if (credential.provider !== GEMINI_CLI_PROVIDER_ID) {
    throwUnsupportedGeminiCredential(credential);
  }

  const access = normalizeString(credential.access);
  const refresh = normalizeString(credential.refresh);
  if (
    !access ||
    !refresh ||
    typeof credential.expires !== "number" ||
    !Number.isFinite(credential.expires)
  ) {
    throw new Error(
      "Gemini CLI OAuth profile is missing usable token material. Re-authenticate with `openclaw models auth login --provider google-gemini-cli --force`.",
    );
  }

  return {
    ...credential,
    type: "oauth",
    provider: GEMINI_CLI_PROVIDER_ID,
    access,
    refresh,
    expires: credential.expires,
    idToken: normalizeString(credential.idToken),
  };
}

function requireGeminiApiKeyCredential(
  credential: GeminiAuthProfileCredential | undefined,
): GeminiApiKeyCredential | null {
  if (!credential) {
    return null;
  }
  if (credential.type !== "api_key") {
    return null;
  }
  if (credential.provider !== GEMINI_CLI_PROVIDER_ID) {
    throwUnsupportedGeminiCredential(credential);
  }

  const key = normalizeString(credential.key);
  if (!key) {
    throw new Error("Gemini CLI API-key profile is missing usable key material.");
  }

  return {
    ...credential,
    type: "api_key",
    provider: GEMINI_CLI_PROVIDER_ID,
    key,
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

  const profileHash = crypto.createHash("sha256").update(authProfileId).digest("hex").slice(0, 24);
  const home = path.join(agentDir, "cli-runtimes", GEMINI_CLI_PROVIDER_ID, "profiles", profileHash);
  return { home, geminiDir: path.join(home, ".gemini") };
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
  settings: unknown,
): Promise<{
  home: string;
  geminiDir: string;
}> {
  const { home, geminiDir } = resolveGeminiCliProfileHome(ctx);
  await fs.mkdir(geminiDir, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  await fs.chmod(geminiDir, 0o700);
  await Promise.all([
    writeGeminiCliJson(path.join(geminiDir, "settings.json"), settings),
    writeGeminiCliJson(path.join(home, "settings.json"), settings),
  ]);
  return { home, geminiDir };
}

async function clearGeminiCliCachedCredentials(geminiDir: string): Promise<void> {
  // Gemini prefers its token store over oauth_creds.json. Rebuild that store
  // from the selected OpenClaw profile each run so stale CLI auth cannot win.
  await fs.rm(path.join(geminiDir, GEMINI_CLI_CREDENTIALS_FILENAME), { force: true });
}

async function prepareGeminiCliOAuthHome(
  ctx: GeminiCliAuthHomeContext,
  credential: GeminiAuthProfileCredential | undefined,
): Promise<PreparedGeminiCliExecution | null> {
  const oauth = requireGeminiOAuthCredential(credential);
  if (!oauth) {
    return null;
  }

  const { home, geminiDir } = await prepareGeminiCliProfileHome(ctx, {
    security: { auth: { selectedType: "oauth-personal" } },
  });
  await clearGeminiCliCachedCredentials(geminiDir);
  const idToken = normalizeString(oauth.idToken);
  const oauthCreds: Record<string, string | number> = {
    access_token: oauth.access,
    refresh_token: oauth.refresh,
    expiry_date: oauth.expires,
    token_type: "Bearer",
  };
  if (idToken) {
    oauthCreds.id_token = idToken;
  }

  await writeGeminiCliJson(path.join(geminiDir, "oauth_creds.json"), oauthCreds);

  return {
    env: {
      GEMINI_CLI_HOME: home,
      GEMINI_FORCE_FILE_STORAGE: "true",
    },
    clearEnv: [...GEMINI_CLI_PROFILE_AUTH_ENV],
  };
}

async function prepareGeminiCliApiKeyHome(
  ctx: GeminiCliAuthHomeContext,
  credential: GeminiAuthProfileCredential | undefined,
): Promise<PreparedGeminiCliExecution | null> {
  const apiKey = requireGeminiApiKeyCredential(credential);
  if (!apiKey) {
    return null;
  }

  const { home, geminiDir } = await prepareGeminiCliProfileHome(ctx, {
    security: { auth: { selectedType: "gemini-api-key" } },
  });
  await Promise.all([
    fs.rm(path.join(geminiDir, "oauth_creds.json"), { force: true }),
    clearGeminiCliCachedCredentials(geminiDir),
  ]);
  return {
    env: {
      GEMINI_CLI_HOME: home,
      GEMINI_FORCE_FILE_STORAGE: "true",
      GEMINI_API_KEY: apiKey.key,
    },
    clearEnv: [...GEMINI_CLI_PROFILE_AUTH_ENV],
  };
}

async function prepareGeminiCliAuthHome(
  ctx: GeminiCliAuthHomeContext,
  credential: GeminiAuthProfileCredential | undefined,
): Promise<PreparedGeminiCliExecution | null> {
  return (
    (await prepareGeminiCliOAuthHome(ctx, credential)) ??
    (await prepareGeminiCliApiKeyHome(ctx, credential))
  );
}

export function buildGoogleGeminiCliBackend(): CliBackendPlugin {
  return {
    id: "google-gemini-cli",
    modelProvider: "google",
    liveTest: {
      defaultModelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@google/gemini-cli",
        binaryName: "gemini",
      },
    },
    bundleMcp: true,
    bundleMcpMode: "gemini-system-settings",
    nativeToolMode: "always-on",
    authEpochMode: "profile-only",
    prepareExecution: async (ctx) =>
      await prepareGeminiCliAuthHome(
        {
          agentDir: ctx.agentDir,
          authProfileId: ctx.authProfileId,
        },
        (ctx as typeof ctx & { authCredential?: GeminiAuthProfileCredential }).authCredential,
      ),
    config: {
      command: "gemini",
      args: ["--skip-trust", "--output-format", "json", "--prompt", "{prompt}"],
      resumeArgs: [
        "--skip-trust",
        "--resume",
        "{sessionId}",
        "--output-format",
        "json",
        "--prompt",
        "{prompt}",
      ],
      output: "json",
      input: "arg",
      imageArg: "@",
      imagePathScope: "workspace",
      modelArg: "--model",
      modelAliases: GEMINI_MODEL_ALIASES,
      sessionMode: "existing",
      sessionIdFields: ["session_id", "sessionId"],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}
