//#region extensions/codex/src/app-server/protocol.ts
function isJsonObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isRpcResponse(message) {
	return "id" in message && !("method" in message);
}
//#endregion
export { isRpcResponse as n, isJsonObject as t };
