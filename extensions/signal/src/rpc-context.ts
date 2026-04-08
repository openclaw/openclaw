import { resolveSignalAccount } from "./accounts.js";

export function resolveSignalRpcContext(
  opts: { baseUrl?: string; account?: string; accountId?: string },
  accountInfo?: ReturnType<typeof resolveSignalAccount>,
) {
  const hasBaseUrl = Boolean(opts.baseUrl?.trim());
  const hasAccount = Boolean(opts.account?.trim());
  if ((!hasBaseUrl || !hasAccount) && !accountInfo) {
    throw new Error("Signal account config is required when baseUrl or account is missing");
  }
  const resolvedAccount = accountInfo;
  const baseUrl = opts.baseUrl?.trim() || resolvedAccount?.baseUrl;
  if (!baseUrl) {
    throw new Error("Signal base URL is required");
  }
  const account = opts.account?.trim() || resolvedAccount?.config.account?.trim();
  return { baseUrl, account };
}
