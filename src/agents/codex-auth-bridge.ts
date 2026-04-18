import crypto from "node:crypto";
import path from "node:path";
import { writePrivateSecretFileAtomic } from "../infra/secret-file.js";
import { loadAuthProfileStoreForSecretsRuntime } from "./auth-profiles/store.js";
import type { OAuthCredential } from "./auth-profiles/types.js";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const CODEX_AUTH_ENV_CLEAR_KEYS = ["OPENAI_API_KEY"] as const;

export function isCodexBridgeableOAuthCredential(value: unknown): value is OAuthCredential {
  return Boolean(
    value &&
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "provider" in value &&
    "access" in value &&
    "refresh" in value &&
    value.type === "oauth" &&
    value.provider === OPENAI_CODEX_PROVIDER_ID &&
    typeof value.access === "string" &&
    value.access.trim().length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.trim().length > 0,
  );
}

export function resolveCodexBridgeHome(
  agentDir: string,
  profileId: string,
  bridgeRoot: "cli-auth" | "harness-auth",
): string {
  const digest = crypto.createHash("sha256").update(profileId).digest("hex").slice(0, 16);
  return path.join(agentDir, bridgeRoot, "codex", digest);
}

export function buildCodexAuthFile(credential: OAuthCredential): string {
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

export async function prepareCodexAuthBridgeFromProfile(params: {
  agentDir: string;
  authProfileId: string;
  bridgeRoot: "cli-auth" | "harness-auth";
}): Promise<{ codexHome: string; clearEnv: string[] } | null> {
  const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
  const credential = store.profiles[params.authProfileId];
  if (!isCodexBridgeableOAuthCredential(credential)) {
    return null;
  }

  const codexHome = resolveCodexBridgeHome(
    params.agentDir,
    params.authProfileId,
    params.bridgeRoot,
  );
  await writePrivateSecretFileAtomic({
    rootDir: params.agentDir,
    filePath: path.join(codexHome, "auth.json"),
    content: buildCodexAuthFile(credential),
  });
  return {
    codexHome,
    clearEnv: [...CODEX_AUTH_ENV_CLEAR_KEYS],
  };
}
