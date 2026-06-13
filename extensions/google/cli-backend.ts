import fs from "node:fs/promises";
import path from "node:path";
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-3.1-flash-preview",
  "flash-lite": "gemini-3.1-flash-lite",
};
const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3-flash-preview";
const GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const VERCEL_AI_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
const GEMINI_CLI_GCA_AUTH_ENV = [
  "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
  "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
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

type PreparedGeminiCliExecution = {
  env: Record<string, string>;
  clearEnv: string[];
  cleanup: () => Promise<void>;
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

async function createIsolatedGeminiCliHome(settings: unknown): Promise<{
  tempHome: string;
  geminiDir: string;
}> {
  const tempHome = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "gemini-cli-home-"),
  );
  await fs.chmod(tempHome, 0o700);
  const geminiDir = path.join(tempHome, ".gemini");
  await fs.mkdir(geminiDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(geminiDir, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { tempHome, geminiDir };
}

async function prepareGeminiCliOAuthHome(
  credential: GeminiAuthProfileCredential | undefined,
): Promise<PreparedGeminiCliExecution | null> {
  const oauth = requireGeminiOAuthCredential(credential);
  if (!oauth) {
    return null;
  }

  const { tempHome, geminiDir } = await createIsolatedGeminiCliHome({
    security: { auth: { selectedType: "oauth-personal" } },
  });
  try {
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

    await fs.writeFile(
      path.join(geminiDir, "oauth_creds.json"),
      `${JSON.stringify(oauthCreds, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    return {
      env: {
        GEMINI_CLI_HOME: tempHome,
      },
      clearEnv: [...GEMINI_CLI_GCA_AUTH_ENV],
      cleanup: async () => {
        await fs.rm(tempHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(tempHome, { recursive: true, force: true });
    throw error;
  }
}

async function prepareGeminiCliApiKeyHome(
  credential: GeminiAuthProfileCredential | undefined,
): Promise<PreparedGeminiCliExecution | null> {
  const apiKey = requireGeminiApiKeyCredential(credential);
  if (!apiKey) {
    return null;
  }

  const { tempHome } = await createIsolatedGeminiCliHome({
    security: { auth: { selectedType: "gemini-api-key" } },
  });
  try {
    return {
      env: {
        GEMINI_CLI_HOME: tempHome,
        GEMINI_API_KEY: apiKey.key,
      },
      clearEnv: [...GEMINI_CLI_API_KEY_AUTH_ENV],
      cleanup: async () => {
        await fs.rm(tempHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(tempHome, { recursive: true, force: true });
    throw error;
  }
}

async function prepareGeminiCliAuthHome(
  credential: GeminiAuthProfileCredential | undefined,
): Promise<PreparedGeminiCliExecution | null> {
  return (
    (await prepareGeminiCliOAuthHome(credential)) ?? (await prepareGeminiCliApiKeyHome(credential))
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
