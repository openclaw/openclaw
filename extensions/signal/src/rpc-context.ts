// Signal plugin module implements rpc context behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalAccount } from "./accounts.js";

export type SignalRpcAccountOpts = {
  cfg: OpenClawConfig;
  baseUrl?: string;
  account?: string;
  accountId?: string;
};

export function resolveSignalRpcAccountInfo(opts: SignalRpcAccountOpts) {
  if (opts.baseUrl?.trim() && opts.account?.trim() && !opts.accountId?.trim()) {
    return undefined;
  }
  if (!opts.cfg) {
    throw new Error(
      "Signal RPC account resolution requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const cfg = requireRuntimeConfig(opts.cfg, "Signal RPC account resolution");
  return resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
}

export function resolveSignalRpcApiMode(
  cfg: OpenClawConfig,
  accountInfo: ReturnType<typeof resolveSignalRpcAccountInfo>,
) {
  return accountInfo?.config.apiMode ?? cfg.channels?.signal?.apiMode;
}

export function resolveSignalRpcContext(
  opts: { baseUrl?: string; account?: string; accountId?: string },
  accountInfo?: ReturnType<typeof resolveSignalAccount>,
) {
  const hasBaseUrl = Boolean(normalizeOptionalString(opts.baseUrl));
  const hasAccount = Boolean(normalizeOptionalString(opts.account));
  if ((!hasBaseUrl || !hasAccount) && !accountInfo) {
    throw new Error("Signal account config is required when baseUrl or account is missing");
  }
  const resolvedAccount = accountInfo;
  const baseUrl = normalizeOptionalString(opts.baseUrl) ?? resolvedAccount?.baseUrl;
  if (!baseUrl) {
    throw new Error("Signal base URL is required");
  }
  const account =
    normalizeOptionalString(opts.account) ??
    normalizeOptionalString(resolvedAccount?.config.account);
  return { baseUrl, account };
}
