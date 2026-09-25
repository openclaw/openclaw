import {
  createAccountListHelpers,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedZalouserAccount, ZalouserAccountConfig, ZalouserConfig } from "./types.js";

const loadZalouserAccountsRuntime = createLazyRuntimeModule(() => import("./zalo-js.js"));

const {
  listAccountIds: listZalouserAccountIds,
  resolveDefaultAccountId: resolveDefaultZalouserAccountId,
  resolveAccountConfig: resolveMergedZalouserAccountConfig,
} = createAccountListHelpers<ZalouserAccountConfig>("zalouser", {
  omitKeys: ["defaultAccount"],
  implicitDefaultAccount: {
    channelKeys: ["profile"],
    envVars: ["ZALOUSER_PROFILE", "ZCA_PROFILE"],
  },
});
export { listZalouserAccountIds, resolveDefaultZalouserAccountId };

function resolveProfile(config: ZalouserAccountConfig, accountId: string): string {
  if (config.profile?.trim()) {
    return config.profile.trim();
  }
  if (process.env.ZALOUSER_PROFILE?.trim()) {
    return process.env.ZALOUSER_PROFILE.trim();
  }
  if (process.env.ZCA_PROFILE?.trim()) {
    return process.env.ZCA_PROFILE.trim();
  }
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return accountId;
  }
  return "default";
}

export function resolveZalouserAccountSync(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZalouserAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultZalouserAccountId(params.cfg),
  );
  const baseEnabled =
    (params.cfg.channels?.zalouser as ZalouserConfig | undefined)?.enabled !== false;
  const accountConfig = resolveMergedZalouserAccountConfig(params.cfg, accountId);
  const merged = {
    ...accountConfig,
    // Groups stay allowlisted unless explicitly opened.
    groupPolicy: accountConfig.groupPolicy ?? "allowlist",
  };

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled: baseEnabled && merged.enabled !== false,
    profile: resolveProfile(merged, accountId),
    authenticated: false,
    mediaMaxBytes: resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId,
      resolveChannelLimitMb: () => merged.mediaMaxMb,
    }),
    config: merged,
  };
}

export async function checkZcaAuthenticated(
  profile: string,
  options?: { credentialPersistence?: "persist" | "read-only" },
): Promise<boolean> {
  return await (await loadZalouserAccountsRuntime()).checkZaloAuthenticated(profile, options);
}

export type { ResolvedZalouserAccount } from "./types.js";
