import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
const activeClients = /* @__PURE__ */ new Map();
function setActiveMatrixClient(client, accountId) {
  const key = normalizeAccountId(accountId);
  if (client) {
    activeClients.set(key, client);
  } else {
    activeClients.delete(key);
  }
}
function getActiveMatrixClient(accountId) {
  const key = normalizeAccountId(accountId);
  return activeClients.get(key) ?? null;
}
function getAnyActiveMatrixClient() {
  const first = activeClients.values().next();
  return first.done ? null : first.value;
}
function clearAllActiveMatrixClients() {
  activeClients.clear();
}
export {
  clearAllActiveMatrixClients,
  getActiveMatrixClient,
  getAnyActiveMatrixClient,
  setActiveMatrixClient
};
