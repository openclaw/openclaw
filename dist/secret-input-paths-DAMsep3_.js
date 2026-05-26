//#region src/gateway/secret-input-paths.ts
const ALL_GATEWAY_SECRET_INPUT_PATHS = [
	"gateway.auth.token",
	"gateway.auth.password",
	"gateway.remote.token",
	"gateway.remote.password"
];
function isSupportedGatewaySecretInputPath(path) {
	return ALL_GATEWAY_SECRET_INPUT_PATHS.includes(path);
}
function readGatewaySecretInputValue(config, path) {
	if (path === "gateway.auth.token") return config.gateway?.auth?.token;
	if (path === "gateway.auth.password") return config.gateway?.auth?.password;
	if (path === "gateway.remote.token") return config.gateway?.remote?.token;
	return config.gateway?.remote?.password;
}
function assignResolvedGatewaySecretInput(params) {
	const { config, path, value } = params;
	if (path === "gateway.auth.token") {
		if (config.gateway?.auth) config.gateway.auth.token = value;
		return;
	}
	if (path === "gateway.auth.password") {
		if (config.gateway?.auth) config.gateway.auth.password = value;
		return;
	}
	if (path === "gateway.remote.token") {
		if (config.gateway?.remote) config.gateway.remote.token = value;
		return;
	}
	if (config.gateway?.remote) config.gateway.remote.password = value;
}
function isTokenGatewaySecretInputPath(path) {
	return path === "gateway.auth.token" || path === "gateway.remote.token";
}
//#endregion
export { readGatewaySecretInputValue as a, isTokenGatewaySecretInputPath as i, assignResolvedGatewaySecretInput as n, isSupportedGatewaySecretInputPath as r, ALL_GATEWAY_SECRET_INPUT_PATHS as t };
