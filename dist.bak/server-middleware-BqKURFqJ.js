import { t as safeEqualSecret } from "./secret-equal-CQn9WoXt.js";
import { i as isLoopbackHost } from "./ws-zZ6eXqMi.js";
import express from "express";

//#region src/browser/csrf.ts
function firstHeader(value) {
	return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
function isMutatingMethod(method) {
	const m = (method || "").trim().toUpperCase();
	return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}
function isLoopbackUrl(value) {
	const v = value.trim();
	if (!v || v === "null") return false;
	try {
		return isLoopbackHost(new URL(v).hostname);
	} catch {
		return false;
	}
}
function shouldRejectBrowserMutation(params) {
	if (!isMutatingMethod(params.method)) return false;
	if ((params.secFetchSite ?? "").trim().toLowerCase() === "cross-site") return true;
	const origin = (params.origin ?? "").trim();
	if (origin) return !isLoopbackUrl(origin);
	const referer = (params.referer ?? "").trim();
	if (referer) return !isLoopbackUrl(referer);
	return false;
}
function browserMutationGuardMiddleware() {
	return (req, res, next) => {
		const method = (req.method || "").trim().toUpperCase();
		if (method === "OPTIONS") return next();
		if (shouldRejectBrowserMutation({
			method,
			origin: firstHeader(req.headers.origin),
			referer: firstHeader(req.headers.referer),
			secFetchSite: firstHeader(req.headers["sec-fetch-site"])
		})) {
			res.status(403).send("Forbidden");
			return;
		}
		next();
	};
}

//#endregion
//#region src/browser/http-auth.ts
function firstHeaderValue(value) {
	return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
function parseBearerToken(authorization) {
	if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) return;
	return authorization.slice(7).trim() || void 0;
}
function parseBasicPassword(authorization) {
	if (!authorization || !authorization.toLowerCase().startsWith("basic ")) return;
	const encoded = authorization.slice(6).trim();
	if (!encoded) return;
	try {
		const decoded = Buffer.from(encoded, "base64").toString("utf8");
		const sep = decoded.indexOf(":");
		if (sep < 0) return;
		return decoded.slice(sep + 1).trim() || void 0;
	} catch {
		return;
	}
}
function isAuthorizedBrowserRequest(req, auth) {
	const authorization = firstHeaderValue(req.headers.authorization).trim();
	if (auth.token) {
		const bearer = parseBearerToken(authorization);
		if (bearer && safeEqualSecret(bearer, auth.token)) return true;
	}
	if (auth.password) {
		const passwordHeader = firstHeaderValue(req.headers["x-openclaw-password"]).trim();
		if (passwordHeader && safeEqualSecret(passwordHeader, auth.password)) return true;
		const basicPassword = parseBasicPassword(authorization);
		if (basicPassword && safeEqualSecret(basicPassword, auth.password)) return true;
	}
	return false;
}

//#endregion
//#region src/browser/server-middleware.ts
function installBrowserCommonMiddleware(app) {
	app.use((req, res, next) => {
		const ctrl = new AbortController();
		const abort = () => ctrl.abort(/* @__PURE__ */ new Error("request aborted"));
		req.once("aborted", abort);
		res.once("close", () => {
			if (!res.writableEnded) abort();
		});
		req.signal = ctrl.signal;
		next();
	});
	app.use(express.json({ limit: "1mb" }));
	app.use(browserMutationGuardMiddleware());
}
function installBrowserAuthMiddleware(app, auth) {
	if (!auth.token && !auth.password) return;
	app.use((req, res, next) => {
		if (isAuthorizedBrowserRequest(req, auth)) return next();
		res.status(401).send("Unauthorized");
	});
}

//#endregion
export { installBrowserCommonMiddleware as n, installBrowserAuthMiddleware as t };