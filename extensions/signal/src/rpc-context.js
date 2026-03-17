import { loadConfig } from "../../../src/config/config.js";
import { resolveSignalAccount } from "./accounts.js";
function resolveSignalRpcContext(opts, accountInfo) {
  const hasBaseUrl = Boolean(opts.baseUrl?.trim());
  const hasAccount = Boolean(opts.account?.trim());
  const resolvedAccount = accountInfo || (!hasBaseUrl || !hasAccount ? resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId
  }) : void 0);
  const baseUrl = opts.baseUrl?.trim() || resolvedAccount?.baseUrl;
  if (!baseUrl) {
    throw new Error("Signal base URL is required");
  }
  const account = opts.account?.trim() || resolvedAccount?.config.account?.trim();
  return { baseUrl, account };
}
export {
  resolveSignalRpcContext
};
