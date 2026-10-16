import type { ResolvedSignalAccount } from "./accounts.js";

export function resolveSignalRpcContext(
  opts: { baseUrl?: string; account?: string; accountId?: string },
  accountInfo: ResolvedSignalAccount,
) {
  const baseUrlOverride = opts.baseUrl?.trim();
  const accountOverride = opts.account?.trim();
  const baseUrl = baseUrlOverride || accountInfo.baseUrl;
  if (!baseUrl) {
    throw new Error("Signal base URL is required");
  }
  const account = accountOverride || accountInfo.config.account?.trim() || undefined;
  return { baseUrl, account };
}
