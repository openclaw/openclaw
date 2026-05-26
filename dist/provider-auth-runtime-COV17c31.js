import { r as __exportAll } from "./chunk-CNf5ZN-e.js";
import { i as NON_ENV_SECRETREF_MARKER } from "./model-auth-markers-Cf78z2Zm.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CZ-LXyVa.js";
import { n as requireApiKey, r as resolveAwsSdkEnvVarName } from "./model-auth-runtime-shared-cdTr1v5l.js";
import { u as resolveApiKeyForProvider$1 } from "./model-auth-Db-JGIrg.js";
import { n as executeWithApiKeyRotation, t as collectProviderApiKeysForExecution } from "./api-key-rotation-Dhy-7cwS.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "node:http";
//#region src/plugin-sdk/provider-auth-runtime.ts
var provider_auth_runtime_exports = /* @__PURE__ */ __exportAll({
	NON_ENV_SECRETREF_MARKER: () => NON_ENV_SECRETREF_MARKER,
	buildOAuthCallbackOriginResolver: () => buildOAuthCallbackOriginResolver,
	collectProviderApiKeysForExecution: () => collectProviderApiKeysForExecution,
	executeWithApiKeyRotation: () => executeWithApiKeyRotation,
	generateOAuthState: () => generateOAuthState,
	getRuntimeAuthForModel: () => getRuntimeAuthForModel,
	parseOAuthCallbackInput: () => parseOAuthCallbackInput,
	requireApiKey: () => requireApiKey,
	resolveApiKeyForProvider: () => resolveApiKeyForProvider,
	resolveAwsSdkEnvVarName: () => resolveAwsSdkEnvVarName,
	resolveEnvApiKey: () => resolveEnvApiKey,
	waitForLocalOAuthCallback: () => waitForLocalOAuthCallback
});
function buildOAuthCallbackOriginResolver(allowedHosts) {
	if (!allowedHosts || allowedHosts.length === 0) return () => void 0;
	const normalized = new Set(allowedHosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0));
	if (normalized.size === 0) return () => void 0;
	return (originHeader) => {
		const value = Array.isArray(originHeader) ? originHeader[0] : originHeader;
		if (!value) return;
		try {
			const parsed = new URL(value);
			if (parsed.protocol !== "https:") return;
			return normalized.has(parsed.host.toLowerCase()) ? parsed.origin : void 0;
		} catch {
			return;
		}
	};
}
function generateOAuthState() {
	return crypto.randomBytes(32).toString("hex");
}
function parseOAuthCallbackInput(input, messages = {}) {
	const trimmed = input.trim();
	if (!trimmed) return { error: "No input provided" };
	try {
		const url = new URL(trimmed);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (!code) return { error: "Missing 'code' parameter in URL" };
		if (!state) return { error: messages.missingState ?? "Missing 'state' parameter in URL" };
		return {
			code,
			state
		};
	} catch {
		return { error: messages.invalidInput ?? "Paste the full redirect URL, not just the code." };
	}
}
async function waitForLocalOAuthCallback(params) {
	const hostname = params.hostname ?? "localhost";
	const escapedSuccessTitle = escapeHtmlText(params.successTitle);
	const resolveOAuthCallbackOrigin = buildOAuthCallbackOriginResolver(params.corsOriginAllowlist);
	const hasCorsOriginAllowlist = params.corsOriginAllowlist?.some((host) => host.trim().length > 0) ?? false;
	return new Promise((resolve, reject) => {
		let settled = false;
		let timeout = null;
		const server = createServer((req, res) => {
			try {
				applyOAuthCallbackCorsHeaders(req, res, hasCorsOriginAllowlist ? resolveOAuthCallbackOrigin : void 0);
				const requestUrl = new URL(req.url ?? "/", `http://${hostname}:${params.port}`);
				if (req.method === "OPTIONS") {
					res.statusCode = 204;
					res.end();
					return;
				}
				if (requestUrl.pathname !== params.callbackPath) {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/plain");
					res.end("Not found");
					return;
				}
				if (req.method !== "GET") {
					res.statusCode = 405;
					res.setHeader("Allow", "GET, OPTIONS");
					res.setHeader("Content-Type", "text/plain");
					res.end("Method not allowed");
					return;
				}
				const error = requestUrl.searchParams.get("error");
				const code = requestUrl.searchParams.get("code")?.trim();
				const state = requestUrl.searchParams.get("state")?.trim();
				if (error) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/plain");
					res.end(`Authentication failed: ${error}`);
					finish(/* @__PURE__ */ new Error(`OAuth error: ${error}`));
					return;
				}
				if (!code || !state) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/plain");
					res.end("Missing code or state");
					finish(/* @__PURE__ */ new Error("Missing OAuth code or state"));
					return;
				}
				if (state !== params.expectedState) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/plain");
					res.end("Invalid state");
					finish(/* @__PURE__ */ new Error("OAuth state mismatch"));
					return;
				}
				res.statusCode = 200;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(`<!doctype html><html><head><meta charset='utf-8'/></head><body><h2>${escapedSuccessTitle}</h2><p>You can close this window and return to OpenClaw.</p></body></html>`);
				finish(void 0, {
					code,
					state
				});
			} catch (err) {
				finish(err instanceof Error ? err : /* @__PURE__ */ new Error("OAuth callback failed"));
			}
		});
		const finish = (err, result) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			try {
				server.close();
			} catch {}
			if (err) reject(err);
			else if (result) resolve(result);
		};
		server.once("error", (err) => {
			finish(err instanceof Error ? err : /* @__PURE__ */ new Error("OAuth callback server error"));
		});
		server.listen(params.port, hostname, () => {
			params.onProgress?.(params.progressMessage ?? `Waiting for OAuth callback on ${params.redirectUri}...`);
		});
		timeout = setTimeout(() => {
			finish(/* @__PURE__ */ new Error("OAuth callback timeout"));
		}, params.timeoutMs);
	});
}
function applyOAuthCallbackCorsHeaders(req, res, resolveOrigin) {
	const origin = resolveOrigin === void 0 ? typeof req.headers.origin === "string" && isHttpOrigin(req.headers.origin) ? req.headers.origin : void 0 : resolveOrigin(req.headers.origin);
	if (origin) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
	}
	if (resolveOrigin !== void 0 && !origin) return;
	const requestedHeaders = req.headers["access-control-request-headers"];
	res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", typeof requestedHeaders === "string" && requestedHeaders.trim().length > 0 ? requestedHeaders : "content-type");
	res.setHeader("Access-Control-Allow-Private-Network", "true");
	res.setHeader("Access-Control-Max-Age", "600");
}
function isHttpOrigin(value) {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
	} catch {
		return false;
	}
}
function escapeHtmlText(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const RUNTIME_MODEL_AUTH_CANDIDATES = ["./runtime-model-auth.runtime", "../plugins/runtime/runtime-model-auth.runtime"];
const RUNTIME_MODEL_AUTH_EXTENSIONS = [
	".js",
	".ts",
	".mjs",
	".mts",
	".cjs",
	".cts"
];
function resolveRuntimeModelAuthModuleHref() {
	const baseDir = path.dirname(fileURLToPath(import.meta.url));
	for (const relativeBase of RUNTIME_MODEL_AUTH_CANDIDATES) for (const ext of RUNTIME_MODEL_AUTH_EXTENSIONS) {
		const candidate = path.resolve(baseDir, `${relativeBase}${ext}`);
		if (fs.existsSync(candidate)) return pathToFileURL(candidate).href;
	}
	throw new Error(`Unable to resolve runtime model auth module from ${import.meta.url}`);
}
async function loadRuntimeModelAuthModule() {
	return await import(resolveRuntimeModelAuthModuleHref());
}
async function resolveApiKeyForProvider(params) {
	const runtimeAuth = await loadRuntimeModelAuthModule();
	return (typeof runtimeAuth.resolveApiKeyForProvider === "function" ? runtimeAuth.resolveApiKeyForProvider : resolveApiKeyForProvider$1)(params);
}
async function getRuntimeAuthForModel(params) {
	const { getRuntimeAuthForModel } = await loadRuntimeModelAuthModule();
	return getRuntimeAuthForModel(params);
}
//#endregion
export { provider_auth_runtime_exports as a, parseOAuthCallbackInput as i, generateOAuthState as n, resolveApiKeyForProvider as o, getRuntimeAuthForModel as r, waitForLocalOAuthCallback as s, buildOAuthCallbackOriginResolver as t };
