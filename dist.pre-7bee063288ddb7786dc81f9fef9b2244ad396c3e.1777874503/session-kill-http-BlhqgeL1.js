import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { o as isLocalDirectRequest } from "./auth-Df9rmkQ_.js";
import { i as getRuntimeConfig } from "./io-BD1XQ5lD.js";
import { n as authorizeOperatorScopesForMethod } from "./method-scopes-BHFmOSiN.js";
import { c as loadSessionEntry } from "./session-utils-l6vzGR0v.js";
import { o as getLatestSubagentRunByChildSessionKey } from "./subagent-registry-BASIIbFV.js";
import { a as killSubagentRunAdmin, c as resolveSubagentController, i as killControlledSubagentRun } from "./subagent-control-CpXlAvU9.js";
import { a as sendMethodNotAllowed, i as sendJson } from "./http-common-BB7WaGsT.js";
import { d as resolveTrustedHttpOperatorScopes, t as authorizeGatewayHttpRequestOrReply } from "./http-auth-utils-CSzJtk0F.js";
import "./http-utils-C62qpDBq.js";
//#region src/gateway/session-kill-http.ts
const REQUESTER_SESSION_KEY_HEADER = "x-openclaw-requester-session-key";
function resolveSessionKeyFromPath(pathname) {
	const match = pathname.match(/^\/sessions\/([^/]+)\/kill$/);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1] ?? "").trim() || null;
	} catch {
		return null;
	}
}
async function handleSessionKillHttpRequest(req, res, opts) {
	const cfg = getRuntimeConfig();
	const sessionKey = resolveSessionKeyFromPath(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname);
	if (!sessionKey) return false;
	if (req.method !== "POST") {
		sendMethodNotAllowed(res, "POST");
		return true;
	}
	const requestAuth = await authorizeGatewayHttpRequestOrReply({
		req,
		res,
		auth: opts.auth,
		trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
		rateLimiter: opts.rateLimiter
	});
	if (!requestAuth) return true;
	const trustedProxies = opts.trustedProxies ?? cfg.gateway?.trustedProxies;
	const allowRealIpFallback = opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback;
	const requesterSessionKey = normalizeOptionalString(req.headers[REQUESTER_SESSION_KEY_HEADER]?.toString());
	const allowLocalAdminKill = isLocalDirectRequest(req, trustedProxies, allowRealIpFallback);
	const requestedScopes = resolveTrustedHttpOperatorScopes(req, requestAuth);
	if (!requesterSessionKey && !allowLocalAdminKill) {
		sendJson(res, 403, {
			ok: false,
			error: {
				type: "forbidden",
				message: "Session kills require a local admin request or requester session ownership."
			}
		});
		return true;
	}
	const scopeAuth = authorizeOperatorScopesForMethod(requesterSessionKey && !allowLocalAdminKill ? "sessions.abort" : "sessions.delete", requestedScopes);
	if (!scopeAuth.allowed) {
		sendJson(res, 403, {
			ok: false,
			error: {
				type: "forbidden",
				message: `missing scope: ${scopeAuth.missingScope}`
			}
		});
		return true;
	}
	const { entry, canonicalKey } = loadSessionEntry(sessionKey);
	if (!entry) {
		sendJson(res, 404, {
			ok: false,
			error: {
				type: "not_found",
				message: `Session not found: ${sessionKey}`
			}
		});
		return true;
	}
	let killed = false;
	if (!allowLocalAdminKill && requesterSessionKey) {
		const runEntry = getLatestSubagentRunByChildSessionKey(canonicalKey);
		if (runEntry) {
			const result = await killControlledSubagentRun({
				cfg,
				controller: resolveSubagentController({
					cfg,
					agentSessionKey: requesterSessionKey
				}),
				entry: runEntry
			});
			if (result.status === "forbidden") {
				sendJson(res, 403, {
					ok: false,
					error: {
						type: "forbidden",
						message: result.error
					}
				});
				return true;
			}
			killed = result.status === "ok";
		}
	} else killed = (await killSubagentRunAdmin({
		cfg,
		sessionKey: canonicalKey
	})).killed;
	sendJson(res, 200, {
		ok: true,
		killed
	});
	return true;
}
//#endregion
export { handleSessionKillHttpRequest };
