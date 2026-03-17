import { isRecord } from "./shared.js";
function hasExclusiveResultOrError(value) {
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  return hasResult !== hasError;
}
function isJsonRpcId(value) {
  return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
function normalizeJsonRpcId(value) {
  if (!isJsonRpcId(value) || value == null) {
    return null;
  }
  return String(value);
}
function isAcpJsonRpcMessage(value) {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return false;
  }
  const hasMethod = typeof value.method === "string" && value.method.length > 0;
  const hasId = Object.hasOwn(value, "id");
  if (hasMethod && !hasId) {
    return true;
  }
  if (hasMethod && hasId) {
    return isJsonRpcId(value.id);
  }
  if (!hasMethod && hasId) {
    return isJsonRpcId(value.id) && hasExclusiveResultOrError(value);
  }
  return false;
}
export {
  isAcpJsonRpcMessage,
  isJsonRpcId,
  normalizeJsonRpcId
};
