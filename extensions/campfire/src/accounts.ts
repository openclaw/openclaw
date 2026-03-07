import type { OpenClawConfig } from "openclaw/plugin-sdk/campfire";
import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk/campfire";
import type { CampfireAccountConfig } from "./types.js";

export type CampfireCredentialSource = "inline" | "env" | "none";

export type ResolvedCampfireAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: CampfireAccountConfig;
  credentialSource: CampfireCredentialSource;
  /** Bot key in format {id}-{token} */
  botKey?: string;
  /** Base URL of the Campfire instance */
  baseUrl?: string;
};

const ENV_BOT_KEY = "CAMPFIRE_BOT_KEY";
const ENV_BASE_URL = "CAMPFIRE_BASE_URL";

const {
  listAccountIds: listCampfireAccountIds,
  resolveDefaultAccountId: resolveDefaultCampfireAccountId,
} = createAccountListHelpers("campfire");
export { listCampfireAccountIds, resolveDefaultCampfireAccountId };

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): CampfireAccountConfig | undefined {
  const accounts = (
    cfg.channels?.["campfire"] as { accounts?: Record<string, CampfireAccountConfig> } | undefined
  )?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function mergeCampfireAccountConfig(cfg: OpenClawConfig, accountId: string): CampfireAccountConfig {
  const raw = (cfg.channels?.["campfire"] ?? {}) as Record<string, unknown>;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as CampfireAccountConfig;
}

function resolveCredentialsFromConfig(params: {
  accountId: string;
  account: CampfireAccountConfig;
}): {
  botKey?: string;
  baseUrl?: string;
  source: CampfireCredentialSource;
} {
  const { account, accountId } = params;

  // Check for inline configuration
  const inlineBotKey = account.botKey?.trim();
  const inlineBaseUrl = account.baseUrl?.trim();
  if (inlineBotKey && inlineBaseUrl) {
    return { botKey: inlineBotKey, baseUrl: inlineBaseUrl, source: "inline" };
  }

  // For default account, check environment variables
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envBotKey = process.env[ENV_BOT_KEY]?.trim();
    const envBaseUrl = process.env[ENV_BASE_URL]?.trim();
    if (envBotKey && envBaseUrl) {
      return { botKey: envBotKey, baseUrl: envBaseUrl, source: "env" };
    }
    // Allow partial config (some from inline, some from env)
    const botKey = inlineBotKey || envBotKey;
    const baseUrl = inlineBaseUrl || envBaseUrl;
    if (botKey && baseUrl) {
      return { botKey, baseUrl, source: inlineBotKey ? "inline" : "env" };
    }
  }

  // Partial inline config
  if (inlineBotKey || inlineBaseUrl) {
    return { botKey: inlineBotKey, baseUrl: inlineBaseUrl, source: "inline" };
  }

  return { source: "none" };
}

export function resolveCampfireAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedCampfireAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled =
    (params.cfg.channels?.["campfire"] as { enabled?: boolean } | undefined)?.enabled !== false;
  const merged = mergeCampfireAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const credentials = resolveCredentialsFromConfig({ accountId, account: merged });

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
    credentialSource: credentials.source,
    botKey: credentials.botKey,
    baseUrl: credentials.baseUrl,
  };
}
