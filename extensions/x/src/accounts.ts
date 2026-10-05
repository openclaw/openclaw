import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import type { XAccountConfig } from "./config-schema.js";

const accounts = createAccountListHelpers<XAccountConfig>("x", {
  omitKeys: ["defaultAccount"],
  implicitDefaultAccount: { channelKeys: ["userId", "clientId", "refreshToken"] },
});
export const listXAccountIds = accounts.listAccountIds;
export const resolveDefaultXAccountId = accounts.resolveDefaultAccountId;
export function resolveXAccount(cfg: OpenClawConfig, requested?: string | null) {
  const accountId = normalizeAccountId(requested ?? resolveDefaultXAccountId(cfg));
  const config = accounts.resolveAccountConfig(cfg, accountId);
  const enabled = cfg.channels?.x?.enabled !== false && config.enabled !== false;
  const configured = Boolean(
    config.userId &&
    config.username &&
    config.clientId &&
    hasConfiguredSecretInput(config.clientSecret) &&
    hasConfiguredSecretInput(config.refreshToken),
  );
  return {
    accountId,
    config,
    enabled,
    configured,
    userId: config.userId ?? "",
    username: config.username ?? "",
    name: config.name,
  };
}
export type ResolvedXAccount = ReturnType<typeof resolveXAccount>;
