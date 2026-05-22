import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { o as isLocalDirectRequest } from "./auth-xLrfMZQL.js";
import { i as getRuntimeConfig } from "./io-SZbUWF4m.js";
import { n as authorizeOperatorScopesForMethod } from "./method-scopes-BwxgjVYa.js";
import { c as loadSessionEntry } from "./session-utils-Hmfko1cF.js";
import { o as getLatestSubagentRunByChildSessionKey } from "./subagent-registry-4fTqi9kr.js";
import { a as killSubagentRunAdmin, c as resolveSubagentController, i as killControlledSubagentRun } from "./subagent-control-YFLtu9ya.js";
import { a as sendMethodNotAllowed, i as sendJson, r as sendInvalidRequest } from "./http-common-CERJMbct.js";
import { d as resolveTrustedHttpOperatorScopes, t as authorizeGatewayHttpRequestOrReply } from "./http-auth-utils-CBXICEUh.js";
import "./http-utils-DY5IWFQh.js";
//#region src/gateway/session-kill-http.ts
const REQUESTER_SESSION_KEY_HEADER = "x-openclaw-requester-session-key";
function resolveSessionKeyFromPath(pathname) {
	const match = pathname.match(/^\/sessions\/([^/]+)\/kill$/);
	if (!match) return { matched: false };
	try {
		const decoded = decodeURIComponent(match[1] ?? "").trim();
		if (!decoded) return {
			error: "invalid-session-key",
			matched: true
		};
		return {
			matched: true,
			sessionKey: decoded
		};
	} catch {
		return {
			error: "invalid-session-key",
			matched: true
		};
	}
}
async function handleSessionKillHttpRequest(req, res, opts) {
	const cfg = getRuntimeConfig();
	const sessionKeyResolution = resolveSessionKeyFromPath(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname);
	if (!sessionKeyResolution.matched) return false;
	if ("error" in sessionKeyResolution) {
		sendInvalidRequest(res, "invalid session key");
		return true;
	}
	const { sessionKey } = sessionKeyResolution;
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
