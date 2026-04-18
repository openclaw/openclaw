import crypto from "node:crypto";
import path from "node:path";
import { ensureAuthProfileStore, type OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { writePrivateSecretFileAtomic } from "openclaw/plugin-sdk/secret-file-runtime";
import type { CodexAppServerStartOptions } from "./config.js";

const DEFAULT_CODEX_AUTH_PROFILE_ID = "openai-codex:default";
const CODEX_AUTH_ENV_CLEAR_KEYS = ["OPENAI_API_KEY"] as const;

function isBridgeableCodexOAuthCredential(value: unknown): value is OAuthCredential {
  return Boolean(
    value &&
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "provider" in value &&
    "access" in value &&
    "refresh" in value &&
    value.type === "oauth" &&
    value.provider === "openai-codex" &&
    typeof value.access === "string" &&
    value.access.trim().length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.trim().length > 0,
  );
}

function resolveCodexBridgeHome(agentDir: string, profileId: string): string {
  const digest = crypto.createHash("sha256").update(profileId).digest("hex").slice(0, 16);
  return path.join(agentDir, "harness-auth", "codex", digest);
}

function buildCodexAuthFile(credential: OAuthCredential): string {
  return `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      tokens: {
        access_token: credential.access,
        refresh_token: credential.refresh,
        ...(credential.accountId ? { account_id: credential.accountId } : {}),
      },
    },
    null,
    2,
  )}\n`;
}

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId?: string;
}): Promise<CodexAppServerStartOptions> {
  const profileId = params.authProfileId?.trim() || DEFAULT_CODEX_AUTH_PROFILE_ID;
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const credential = store.profiles[profileId];
  if (!isBridgeableCodexOAuthCredential(credential)) {
    return params.startOptions;
  }

  const codexHome = resolveCodexBridgeHome(params.agentDir, profileId);
  await writePrivateSecretFileAtomic({
    rootDir: params.agentDir,
    filePath: path.join(codexHome, "auth.json"),
    content: buildCodexAuthFile(credential),
  });

  return {
    ...params.startOptions,
    env: {
      ...params.startOptions.env,
      CODEX_HOME: codexHome,
    },
    clearEnv: Array.from(
      new Set([...(params.startOptions.clearEnv ?? []), ...CODEX_AUTH_ENV_CLEAR_KEYS]),
    ),
  };
}
