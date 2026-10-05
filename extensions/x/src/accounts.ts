import { createAccountListHelpers, mergeAccountConfig } from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import type { XAccountConfig } from "./config-schema.js";
import { resolveXCostLimits } from "./cost-limits.js";

const accounts = createAccountListHelpers<XAccountConfig>("x", {
  omitKeys: ["defaultAccount"],
  nestedObjectKeys: ["guests", "costLimits"],
  implicitDefaultAccount: { channelKeys: ["userId", "clientId", "refreshToken"] },
});
export const listXAccountIds = accounts.listAccountIds;
export const resolveDefaultXAccountId = accounts.resolveDefaultAccountId;
export function resolveXAccount(cfg: OpenClawConfig, requested?: string | null) {
  const accountId = normalizeAccountId(requested ?? resolveDefaultXAccountId(cfg));
  const config = accounts.resolveAccountConfig(cfg, accountId);
  if (config.guests) {
    config.guests = mergeAccountConfig({
      channelConfig: cfg.channels?.x?.guests,
      accountConfig: config.guests,
      nestedObjectKeys: ["tools"],
    });
  }
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
    costLimits: resolveXCostLimits(config.costLimits),
    enabled,
    configured,
    userId: config.userId ?? "",
    username: config.username ?? "",
    name: config.name,
  };
}
export type ResolvedXAccount = ReturnType<typeof resolveXAccount>;
