import fs from "node:fs";
import path from "node:path";
import type { AuthProfileStore, OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { resolveRequiredHomeDir } from "openclaw/plugin-sdk/provider-auth";
import {
  resolveCodexAccessTokenExpiry,
  resolveCodexAuthIdentity,
} from "./openai-codex-auth-identity.js";

const PROVIDER_ID = "openai-codex";
const CODEX_CLI_MANAGED_BY = "codex-cli";

export const CODEX_CLI_PROFILE_ID = `${PROVIDER_ID}:codex-cli`;
export const OPENAI_CODEX_DEFAULT_PROFILE_ID = `${PROVIDER_ID}:default`;

type CodexCliAuthFile = {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
};

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveCodexCliHome(env: NodeJS.ProcessEnv): string {
  const configured = trimNonEmptyString(env.CODEX_HOME);
  if (!configured) {
    return path.join(resolveRequiredHomeDir(), ".codex");
  }
  if (configured === "~") {
    return resolveRequiredHomeDir();
  }
  if (configured.startsWith("~/")) {
    return path.join(resolveRequiredHomeDir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function readCodexCliAuthFile(env: NodeJS.ProcessEnv): CodexCliAuthFile | null {
  try {
    const authPath = path.join(resolveCodexCliHome(env), "auth.json");
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as CodexCliAuthFile) : null;
  } catch {
    return null;
  }
}

export function readOpenAICodexCliOAuthProfile(params: {
  env?: NodeJS.ProcessEnv;
  store: AuthProfileStore;
}): { profileId: string; credential: OAuthCredential } | null {
  const existing = params.store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID];
  if (
    existing?.type === "oauth" &&
    existing.provider === PROVIDER_ID &&
    existing.managedBy !== CODEX_CLI_MANAGED_BY
  ) {
    return null;
  }

  const authFile = readCodexCliAuthFile(params.env ?? process.env);
  if (!authFile || authFile.auth_mode !== "chatgpt") {
    return null;
  }

  const access = trimNonEmptyString(authFile.tokens?.access_token);
  const refresh = trimNonEmptyString(authFile.tokens?.refresh_token);
  if (!access || !refresh) {
    return null;
  }

  const accountId = trimNonEmptyString(authFile.tokens?.account_id);
  const identity = resolveCodexAuthIdentity({ accessToken: access });

  return {
    profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
    credential: {
      type: "oauth",
      provider: PROVIDER_ID,
      access,
      refresh,
      expires: resolveCodexAccessTokenExpiry(access) ?? 0,
      ...(accountId ? { accountId } : {}),
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.profileName ? { displayName: identity.profileName } : {}),
      managedBy: CODEX_CLI_MANAGED_BY,
    },
  };
}
