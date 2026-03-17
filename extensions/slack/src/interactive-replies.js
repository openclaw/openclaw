import { listSlackAccountIds, resolveSlackAccount } from "./accounts.js";
function resolveInteractiveRepliesFromCapabilities(capabilities) {
  if (!capabilities) {
    return false;
  }
  if (Array.isArray(capabilities)) {
    return capabilities.some(
      (entry) => String(entry).trim().toLowerCase() === "interactivereplies"
    );
  }
  if (typeof capabilities === "object") {
    return capabilities.interactiveReplies === true;
  }
  return false;
}
function isSlackInteractiveRepliesEnabled(params) {
  if (params.accountId) {
    const account2 = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
    return resolveInteractiveRepliesFromCapabilities(account2.config.capabilities);
  }
  const accountIds = listSlackAccountIds(params.cfg);
  if (accountIds.length === 0) {
    return resolveInteractiveRepliesFromCapabilities(params.cfg.channels?.slack?.capabilities);
  }
  if (accountIds.length > 1) {
    return false;
  }
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: accountIds[0] });
  return resolveInteractiveRepliesFromCapabilities(account.config.capabilities);
}
export {
  isSlackInteractiveRepliesEnabled
};
