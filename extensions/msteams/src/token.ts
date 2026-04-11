import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MSTeamsConfig } from "../runtime-api.js";
import type { MSTeamsDelegatedTokens } from "./oauth.shared.js";
import { refreshMSTeamsDelegatedTokens } from "./oauth.token.js";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";
import { resolveMSTeamsStorePath } from "./storage.js";

export type MSTeamsCredentials = {
  appId: string;
  appPassword: string;
  tenantId: string;
};

export function hasConfiguredMSTeamsCredentials(cfg?: MSTeamsConfig): boolean {
  return Boolean(
    normalizeSecretInputString(cfg?.appId) &&
    hasConfiguredSecretInput(cfg?.appPassword) &&
    normalizeSecretInputString(cfg?.tenantId),
  );
}

export function resolveMSTeamsCredentials(cfg?: MSTeamsConfig): MSTeamsCredentials | undefined {
  const appId =
    normalizeSecretInputString(cfg?.appId) ||
    normalizeSecretInputString(process.env.MSTEAMS_APP_ID);
  const appPassword =
    normalizeResolvedSecretInputString({
      value: cfg?.appPassword,
      path: "channels.msteams.appPassword",
    }) || normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD);
  const tenantId =
    normalizeSecretInputString(cfg?.tenantId) ||
    normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID);

  if (!appId || !appPassword || !tenantId) {
    return undefined;
  }

  return { appId, appPassword, tenantId };
}

// ---------------------------------------------------------------------------
// Delegated token storage / resolution
// ---------------------------------------------------------------------------

const DELEGATED_TOKEN_FILENAME = "msteams-delegated.json";

export function resolveDelegatedTokenPath(): string {
  return resolveMSTeamsStorePath({ filename: DELEGATED_TOKEN_FILENAME });
}

export function loadDelegatedTokens(): MSTeamsDelegatedTokens | undefined {
  try {
    const content = readFileSync(resolveDelegatedTokenPath(), "utf8");
    return JSON.parse(content) as MSTeamsDelegatedTokens;
  } catch {
    return undefined;
  }
}

export function saveDelegatedTokens(tokens: MSTeamsDelegatedTokens): void {
  const tokenPath = resolveDelegatedTokenPath();
  const dir = dirname(tokenPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), "utf8");
}

export async function resolveDelegatedAccessToken(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}): Promise<string | undefined> {
  const tokens = loadDelegatedTokens();
  if (!tokens) {
    return undefined;
  }

  // Token still valid (5-min buffer already baked into expiresAt)
  if (tokens.expiresAt > Date.now()) {
    return tokens.accessToken;
  }

  // Attempt refresh
  try {
    const refreshed = await refreshMSTeamsDelegatedTokens({
      tenantId: params.tenantId,
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
    });
    saveDelegatedTokens(refreshed);
    return refreshed.accessToken;
  } catch {
    return undefined;
  }
}
