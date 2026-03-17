const gatewayRegistry = /* @__PURE__ */ new Map();
const DEFAULT_ACCOUNT_KEY = "\0__default__";
function resolveAccountKey(accountId) {
  return accountId ?? DEFAULT_ACCOUNT_KEY;
}
function registerGateway(accountId, gateway) {
  gatewayRegistry.set(resolveAccountKey(accountId), gateway);
}
function unregisterGateway(accountId) {
  gatewayRegistry.delete(resolveAccountKey(accountId));
}
function getGateway(accountId) {
  return gatewayRegistry.get(resolveAccountKey(accountId));
}
function clearGateways() {
  gatewayRegistry.clear();
}
export {
  clearGateways,
  getGateway,
  registerGateway,
  unregisterGateway
};
