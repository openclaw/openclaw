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

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

type GeminiAuthProfileCredential = {
  type: "api_key" | "oauth" | "token";
  provider: string;
  access?: string;
  refresh?: string;
  expires?: number;
  idToken?: string;
};

type GeminiOAuthCredential = GeminiAuthProfileCredential & {
  type: "oauth";
  provider: "google-gemini-cli";
  access: string;
  refresh: string;
  expires: number;
};

function requireGeminiOAuthCredential(
  credential: GeminiAuthProfileCredential | undefined,
): GeminiOAuthCredential | null {
  if (!credential) {
    return null;
  }
  if (credential.type !== "oauth" || credential.provider !== "google-gemini-cli") {
    throw new Error("Gemini CLI execution requires a google-gemini-cli OAuth profile.");
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
    provider: "google-gemini-cli",
    access,
    refresh,
    expires: credential.expires,
    idToken: normalizeString(credential.idToken),
  };
}

async function prepareGeminiCliOAuthHome(
  credential: GeminiAuthProfileCredential | undefined,
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> } | null> {
  const oauth = requireGeminiOAuthCredential(credential);
  if (!oauth) {
    return null;
  }

  const tempHome = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "gemini-cli-home-"),
  );
  try {
    await fs.chmod(tempHome, 0o700);
    const geminiDir = path.join(tempHome, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true, mode: 0o700 });

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
      cleanup: async () => {
        await fs.rm(tempHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(tempHome, { recursive: true, force: true });
    throw error;
  }
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
      await prepareGeminiCliOAuthHome(
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
