//#region extensions/file-transfer/src/shared/errors.ts
function throwFromNodePayload(operation, payload) {
	const code = typeof payload.code === "string" ? payload.code : "ERROR";
	const message = typeof payload.message === "string" ? payload.message : `${operation} failed`;
	const canonical = typeof payload.canonicalPath === "string" ? ` (canonical=${payload.canonicalPath})` : "";
	throw new Error(`${operation} ${code}: ${message}${canonical}`);
}
//#endregion
//#region extensions/file-transfer/src/shared/params.ts
function readGatewayCallOptions(params) {
	const opts = {};
	if (typeof params.gatewayUrl === "string" && params.gatewayUrl.trim()) opts.gatewayUrl = params.gatewayUrl.trim();
	if (typeof params.gatewayToken === "string" && params.gatewayToken.trim()) opts.gatewayToken = params.gatewayToken.trim();
	if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) opts.timeoutMs = params.timeoutMs;
	return opts;
}
function readTrimmedString(params, key) {
	const value = params[key];
	return typeof value === "string" ? value.trim() : "";
}
function readBoolean(params, key, defaultValue = false) {
	const value = params[key];
	if (typeof value === "boolean") return value;
	return defaultValue;
}
function readClampedInt(params) {
	const value = params.input[params.key];
	const requested = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : params.defaultValue;
	return Math.max(params.hardMin, Math.min(requested, params.hardMax));
}
function humanSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
//#endregion
export { readTrimmedString as a, readGatewayCallOptions as i, readBoolean as n, throwFromNodePayload as o, readClampedInt as r, humanSize as t };
