import { createHash } from "node:crypto";
//#region src/gateway/server/ws-shared-generation.ts
function resolveSharedSecret(auth) {
	if (auth.mode === "token" && typeof auth.token === "string" && auth.token.trim().length > 0) return {
		mode: "token",
		secret: auth.token
	};
	if (auth.mode === "password" && typeof auth.password === "string" && auth.password.trim().length > 0) return {
		mode: "password",
		secret: auth.password
	};
	return null;
}
function normalizeTrustedProxyConfig(trustedProxy) {
	return {
		userHeader: trustedProxy?.userHeader,
		requiredHeaders: [...trustedProxy?.requiredHeaders ?? []].toSorted(),
		allowUsers: [...trustedProxy?.allowUsers ?? []].toSorted(),
		allowLoopback: trustedProxy?.allowLoopback
	};
}
function resolveSharedGatewaySessionGeneration(auth, trustedProxies) {
	const shared = resolveSharedSecret(auth);
	if (shared) return createHash("sha256").update(`${shared.mode}\u0000${shared.secret}`, "utf8").digest("base64url");
	if (auth.mode === "trusted-proxy") return createHash("sha256").update(JSON.stringify({
		mode: auth.mode,
		trustedProxy: normalizeTrustedProxyConfig(auth.trustedProxy),
		trustedProxies: [...trustedProxies ?? []].toSorted()
	}), "utf8").digest("base64url");
}
//#endregion
export { resolveSharedGatewaySessionGeneration as t };
