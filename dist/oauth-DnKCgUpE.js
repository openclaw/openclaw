import { r as ensureGlobalUndiciEnvProxyDispatcher } from "./undici-global-dispatcher-B3DjrQKu.js";
import "./runtime-env-BtvWnLRh.js";
import { l as generatePkceVerifierChallenge, u as toFormUrlEncoded } from "./provider-auth-BtRKd5us.js";
import { randomBytes, randomUUID } from "node:crypto";
//#region extensions/minimax/oauth.ts
const MINIMAX_OAUTH_CONFIG = {
	cn: {
		baseUrl: "https://api.minimaxi.com",
		clientId: "78257093-7e40-4613-99e0-527b14b39113"
	},
	global: {
		baseUrl: "https://api.minimax.io",
		clientId: "78257093-7e40-4613-99e0-527b14b39113"
	}
};
const MINIMAX_OAUTH_SCOPE = "group_id profile model.completion";
const MINIMAX_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:user_code";
function getOAuthEndpoints(region) {
	const config = MINIMAX_OAUTH_CONFIG[region];
	return {
		codeEndpoint: `${config.baseUrl}/oauth/code`,
		tokenEndpoint: `${config.baseUrl}/oauth/token`,
		clientId: config.clientId,
		baseUrl: config.baseUrl
	};
}
function generatePkce() {
	const { verifier, challenge } = generatePkceVerifierChallenge();
	return {
		verifier,
		challenge,
		state: randomBytes(16).toString("base64url")
	};
}
async function requestOAuthCode(params) {
	const endpoints = getOAuthEndpoints(params.region);
	const response = await fetch(endpoints.codeEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"x-request-id": randomUUID()
		},
		body: toFormUrlEncoded({
			response_type: "code",
			client_id: endpoints.clientId,
			scope: MINIMAX_OAUTH_SCOPE,
			code_challenge: params.challenge,
			code_challenge_method: "S256",
			state: params.state
		})
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`MiniMax OAuth authorization failed: ${text || response.statusText}`);
	}
	const payload = await response.json();
	if (!payload.user_code || !payload.verification_uri) throw new Error(payload.error ?? "MiniMax OAuth authorization returned an incomplete payload (missing user_code or verification_uri).");
	if (payload.state !== params.state) throw new Error("MiniMax OAuth state mismatch: possible CSRF attack or session corruption.");
	return payload;
}
async function pollOAuthToken(params) {
	const endpoints = getOAuthEndpoints(params.region);
	const response = await fetch(endpoints.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		},
		body: toFormUrlEncoded({
			grant_type: MINIMAX_OAUTH_GRANT_TYPE,
			client_id: endpoints.clientId,
			user_code: params.userCode,
			code_verifier: params.verifier
		})
	});
	const text = await response.text();
	let payload;
	if (text) try {
		payload = JSON.parse(text);
	} catch {
		payload = void 0;
	}
	if (!response.ok) return {
		status: "error",
		message: (payload?.base_resp?.status_msg ?? text) || "MiniMax OAuth failed to parse response."
	};
	if (!payload) return {
		status: "error",
		message: "MiniMax OAuth failed to parse response."
	};
	const tokenPayload = payload;
	if (tokenPayload.status === "error") return {
		status: "error",
		message: "An error occurred. Please try again later"
	};
	if (tokenPayload.status !== "success") return {
		status: "pending",
		message: "current user code is not authorized"
	};
	if (!tokenPayload.access_token || !tokenPayload.refresh_token || !tokenPayload.expired_in) return {
		status: "error",
		message: "MiniMax OAuth returned incomplete token payload."
	};
	return {
		status: "success",
		token: {
			access: tokenPayload.access_token,
			refresh: tokenPayload.refresh_token,
			expires: tokenPayload.expired_in,
			resourceUrl: tokenPayload.resource_url,
			notification_message: tokenPayload.notification_message
		}
	};
}
async function loginMiniMaxPortalOAuth(params) {
	ensureGlobalUndiciEnvProxyDispatcher();
	const region = params.region ?? "global";
	const { verifier, challenge, state } = generatePkce();
	const oauth = await requestOAuthCode({
		challenge,
		state,
		region
	});
	const verificationUrl = oauth.verification_uri;
	const noteLines = [
		`Open ${verificationUrl} to approve access.`,
		`If prompted, enter the code ${oauth.user_code}.`,
		`Interval: ${oauth.interval ?? "default (2000ms)"}, Expires at: ${oauth.expired_in} unix timestamp`
	];
	await params.note(noteLines.join("\n"), "MiniMax OAuth");
	try {
		await params.openUrl(verificationUrl);
	} catch {}
	let pollIntervalMs = oauth.interval ? oauth.interval : 2e3;
	const expireTimeMs = oauth.expired_in;
	while (Date.now() < expireTimeMs) {
		params.progress.update("Waiting for MiniMax OAuth approval…");
		const result = await pollOAuthToken({
			userCode: oauth.user_code,
			verifier,
			region
		});
		if (result.status === "success") return result.token;
		if (result.status === "error") throw new Error(result.message);
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		pollIntervalMs = Math.max(pollIntervalMs, 2e3);
	}
	throw new Error("MiniMax OAuth timed out before authorization completed.");
}
//#endregion
export { loginMiniMaxPortalOAuth as t };
