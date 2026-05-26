import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as resolveGatewayAuth } from "./auth-resolve-BEn3Se6k.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as ensureGatewayStartupAuth } from "./startup-auth-CWNnB8iD.js";
import "./sdk-security-runtime-C8OhDycR.js";
import "./config-CblF4FCf.js";
import { r as persistBrowserControlCredential } from "./config-mutations-DKye8C0d.js";
import crypto from "node:crypto";
//#region extensions/browser/src/browser/control-auth.ts
function resolveBrowserControlAuth(cfg, env = process.env) {
	const auth = resolveGatewayAuth({
		authConfig: cfg?.gateway?.auth,
		env,
		tailscaleMode: cfg?.gateway?.tailscale?.mode
	});
	const token = normalizeOptionalString(auth.token) ?? "";
	const password = normalizeOptionalString(auth.password) ?? "";
	switch (auth.mode) {
		case "password":
		case "trusted-proxy": return { password: password || void 0 };
		case "token":
		case "none": return { token: token || void 0 };
		default: return {};
	}
}
function shouldAutoGenerateBrowserAuth(env) {
	if (normalizeLowercaseStringOrEmpty(env.NODE_ENV) === "test") return false;
	const vitest = normalizeLowercaseStringOrEmpty(env.VITEST);
	if (vitest && vitest !== "0" && vitest !== "false" && vitest !== "off") return false;
	return true;
}
function hasExplicitNonStringGatewayCredentialForMode(params) {
	const { cfg, mode } = params;
	const auth = cfg?.gateway?.auth;
	if (!auth) return false;
	if (mode === "none") return auth.token != null && typeof auth.token !== "string";
	return auth.password != null && typeof auth.password !== "string";
}
function generateBrowserControlToken() {
	return crypto.randomBytes(24).toString("hex");
}
async function generateAndPersistBrowserControlToken(params) {
	const token = generateBrowserControlToken();
	await persistBrowserControlCredential({
		kind: "token",
		value: token
	});
	const persistedAuth = resolveBrowserControlAuth(getRuntimeConfig(), params.env);
	if (persistedAuth.token || persistedAuth.password) return {
		auth: persistedAuth,
		generatedToken: persistedAuth.token === token ? token : void 0
	};
	return {
		auth: { token },
		generatedToken: token
	};
}
async function generateAndPersistBrowserControlPassword(params) {
	const password = generateBrowserControlToken();
	await persistBrowserControlCredential({
		kind: "password",
		value: password
	});
	const persistedAuth = resolveBrowserControlAuth(getRuntimeConfig(), params.env);
	if (persistedAuth.token || persistedAuth.password) return {
		auth: persistedAuth,
		generatedToken: persistedAuth.password === password ? password : void 0
	};
	return {
		auth: { password },
		generatedToken: password
	};
}
async function ensureBrowserControlAuth(params) {
	const env = params.env ?? process.env;
	const auth = resolveBrowserControlAuth(params.cfg, env);
	if (auth.token || auth.password) return { auth };
	if (!shouldAutoGenerateBrowserAuth(env)) return { auth };
	if (params.cfg.gateway?.auth?.mode === "password") return { auth };
	const latestCfg = getRuntimeConfig();
	const latestAuth = resolveBrowserControlAuth(latestCfg, env);
	if (latestAuth.token || latestAuth.password) return { auth: latestAuth };
	if (latestCfg.gateway?.auth?.mode === "password") return { auth: latestAuth };
	const latestMode = latestCfg.gateway?.auth?.mode;
	if (latestMode === "none" || latestMode === "trusted-proxy") {
		if (hasExplicitNonStringGatewayCredentialForMode({
			cfg: latestCfg,
			mode: latestMode
		})) return { auth: latestAuth };
		if (latestMode === "trusted-proxy") return await generateAndPersistBrowserControlPassword({
			cfg: latestCfg,
			env
		});
		return await generateAndPersistBrowserControlToken({
			cfg: latestCfg,
			env
		});
	}
	const ensured = await ensureGatewayStartupAuth({
		cfg: latestCfg,
		env,
		persist: true
	});
	return {
		auth: {
			token: ensured.auth.token,
			password: ensured.auth.password
		},
		generatedToken: ensured.generatedToken
	};
}
//#endregion
export { resolveBrowserControlAuth as n, shouldAutoGenerateBrowserAuth as r, ensureBrowserControlAuth as t };
