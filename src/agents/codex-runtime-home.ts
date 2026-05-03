import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveApiKeyForProfile } from "./auth-profiles/oauth.js";
import {
  ensureAuthProfileStore,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "./auth-profiles/store.js";
import type { AuthProfileCredential, OAuthCredential } from "./auth-profiles/types.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

const CODEX_AUTH_PROVIDER = "openai-codex";
export const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
const CODEX_HOME_ENV_VAR = "CODEX_HOME";
const CODEX_API_KEY_ENV_VAR = "CODEX_API_KEY";
const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
const CODEX_AUTH_FILE = "auth.json";
const CODEX_RUNTIME_STORE_OPTIONS = {
  allowKeychainPrompt: false,
  syncExternalCli: false,
} as const;

export type PreparedCodexRuntimeHome = {
  codexHome: string;
  authPath?: string;
  env: Record<string, string>;
  clearEnv: string[];
  cleanup: () => Promise<void>;
};

export async function prepareIsolatedCodexRuntimeHome(
  params: {
    agentDir?: string;
    authProfileId?: string;
    writeAuthJson?: boolean;
  } = {},
): Promise<PreparedCodexRuntimeHome> {
  const codexHome = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-home-"),
  );
  await fs.chmod(codexHome, 0o700).catch(() => undefined);

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    await fs.rm(codexHome, { recursive: true, force: true });
  };

  const env: Record<string, string> = {
    [CODEX_HOME_ENV_VAR]: codexHome,
  };
  const clearEnv = [CODEX_HOME_ENV_VAR, CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR];
  const profileId = params.authProfileId?.trim();
  if (!profileId || !params.agentDir) {
    return { codexHome, env, clearEnv, cleanup };
  }

  try {
    const credential = resolveCodexRuntimeCredential(params.agentDir, profileId);
    if (!credential) {
      return { codexHome, env, clearEnv, cleanup };
    }

    if (credential.type === "oauth" && params.writeAuthJson !== false) {
      const resolved = await resolveCodexOAuthRuntimeCredential(
        params.agentDir,
        profileId,
        credential,
      );
      if (!resolved.refresh.trim()) {
        return { codexHome, env, clearEnv, cleanup };
      }
      const authPath = path.join(codexHome, CODEX_AUTH_FILE);
      await fs.writeFile(
        `${authPath}`,
        `${JSON.stringify(buildCodexAuthFile(resolved), null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
      return { codexHome, authPath, env, clearEnv, cleanup };
    }

    const resolved = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(params.agentDir, CODEX_RUNTIME_STORE_OPTIONS),
      profileId,
      agentDir: params.agentDir,
    });
    const apiKey = resolved?.apiKey?.trim();
    if (apiKey) {
      env[CODEX_API_KEY_ENV_VAR] = apiKey;
      env[OPENAI_API_KEY_ENV_VAR] = apiKey;
    }
    return { codexHome, env, clearEnv, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

function resolveCodexRuntimeCredential(
  agentDir: string,
  profileId: string,
): AuthProfileCredential | undefined {
  const store = ensureAuthProfileStore(agentDir, CODEX_RUNTIME_STORE_OPTIONS);
  const credential = store.profiles[profileId];
  if (!credential) {
    return undefined;
  }
  if (resolveProviderIdForAuth(credential.provider) !== CODEX_AUTH_PROVIDER) {
    throw new Error(
      `Codex runtime auth profile "${profileId}" must belong to provider "openai-codex" or a supported alias.`,
    );
  }
  return credential;
}

async function resolveCodexOAuthRuntimeCredential(
  agentDir: string,
  profileId: string,
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
    agentDir,
    profileId,
  });
  const store = ensureAuthProfileStore(ownerAgentDir, CODEX_RUNTIME_STORE_OPTIONS);
  const ownerCredential = store.profiles[profileId];
  const credentialForOwner =
    ownerCredential?.type === "oauth" &&
    resolveProviderIdForAuth(ownerCredential.provider) === CODEX_AUTH_PROVIDER
      ? ownerCredential
      : credential;
  const resolved = await resolveApiKeyForProfile({
    store,
    profileId,
    agentDir: ownerAgentDir,
  });
  const refreshedCredential = store.profiles[profileId];
  const candidate =
    refreshedCredential?.type === "oauth" &&
    resolveProviderIdForAuth(refreshedCredential.provider) === CODEX_AUTH_PROVIDER
      ? refreshedCredential
      : credentialForOwner;
  return resolved?.apiKey ? { ...candidate, access: resolved.apiKey } : candidate;
}

function buildCodexAuthFile(credential: OAuthCredential): Record<string, unknown> {
  return {
    OPENAI_API_KEY: null,
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: credential.access,
      refresh_token: credential.refresh,
      ...(credential.accountId?.trim() ? { account_id: credential.accountId.trim() } : {}),
      ...(credential.idToken?.trim() ? { id_token: credential.idToken.trim() } : {}),
    },
  };
}
