import { formatCliCommand } from "../../../src/cli/command-format.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
let _currentListener = null;
const listeners = /* @__PURE__ */ new Map();
function resolveWebAccountId(accountId) {
  return (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
}
function requireActiveWebListener(accountId) {
  const id = resolveWebAccountId(accountId);
  const listener = listeners.get(id) ?? null;
  if (!listener) {
    throw new Error(
      `No active WhatsApp Web listener (account: ${id}). Start the gateway, then link WhatsApp with: ${formatCliCommand(`openclaw channels login --channel whatsapp --account ${id}`)}.`
    );
  }
  return { accountId: id, listener };
}
function setActiveWebListener(accountIdOrListener, maybeListener) {
  const { accountId, listener } = typeof accountIdOrListener === "string" ? { accountId: accountIdOrListener, listener: maybeListener ?? null } : {
    accountId: DEFAULT_ACCOUNT_ID,
    listener: accountIdOrListener ?? null
  };
  const id = resolveWebAccountId(accountId);
  if (!listener) {
    listeners.delete(id);
  } else {
    listeners.set(id, listener);
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    _currentListener = listener;
  }
}
function getActiveWebListener(accountId) {
  const id = resolveWebAccountId(accountId);
  return listeners.get(id) ?? null;
}
export {
  getActiveWebListener,
  requireActiveWebListener,
  resolveWebAccountId,
  setActiveWebListener
};
