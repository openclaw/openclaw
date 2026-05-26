import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { c as generateHexPkceVerifierChallenge } from "./provider-auth-BtRKd5us.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { i as parseOAuthCallbackInput, n as generateOAuthState, s as waitForLocalOAuthCallback } from "./provider-auth-runtime-COV17c31.js";
//#region extensions/google-meet/src/oauth.ts
const GOOGLE_MEET_REDIRECT_URI = "http://localhost:8085/oauth2callback";
const GOOGLE_MEET_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_MEET_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_MEET_TOKEN_HOST = "oauth2.googleapis.com";
const GOOGLE_MEET_SCOPES = [
	"https://www.googleapis.com/auth/meetings.space.created",
	"https://www.googleapis.com/auth/meetings.space.readonly",
	"https://www.googleapis.com/auth/meetings.space.settings",
	"https://www.googleapis.com/auth/meetings.conference.media.readonly",
	"https://www.googleapis.com/auth/calendar.events.readonly",
	"https://www.googleapis.com/auth/drive.meet.readonly"
];
function buildGoogleMeetAuthUrl(params) {
	return `${GOOGLE_MEET_AUTH_URL}?${new URLSearchParams({
		client_id: params.clientId,
		response_type: "code",
		redirect_uri: params.redirectUri ?? GOOGLE_MEET_REDIRECT_URI,
		scope: (params.scopes ?? GOOGLE_MEET_SCOPES).join(" "),
		code_challenge: params.challenge,
		code_challenge_method: "S256",
		access_type: "offline",
		prompt: "consent",
		state: params.state
	}).toString()}`;
}
async function executeGoogleTokenRequest(body) {
	const { response, release } = await fetchWithSsrFGuard({
		url: GOOGLE_MEET_TOKEN_URL,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
				Accept: "application/json"
			},
			body
		},
		policy: { allowedHostnames: [GOOGLE_MEET_TOKEN_HOST] },
		auditContext: "google-meet.oauth.token"
	});
	try {
		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`Google OAuth token request failed (${response.status}): ${detail}`);
		}
		const payload = await response.json();
		const accessToken = payload.access_token?.trim();
		if (!accessToken) throw new Error("Google OAuth token response was missing access_token");
		const expiresInSeconds = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
		return {
			accessToken,
			expiresAt: Date.now() + expiresInSeconds * 1e3,
			refreshToken: payload.refresh_token?.trim() || void 0,
			scope: payload.scope?.trim() || void 0,
			tokenType: payload.token_type?.trim() || void 0
		};
	} finally {
		await release();
	}
}
function tokenRequestBody(values) {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) if (value?.trim()) body.set(key, value);
	return body;
}
async function exchangeGoogleMeetAuthCode(params) {
	return await executeGoogleTokenRequest(tokenRequestBody({
		client_id: params.clientId,
		client_secret: params.clientSecret,
		code: params.code,
		grant_type: "authorization_code",
		redirect_uri: params.redirectUri ?? GOOGLE_MEET_REDIRECT_URI,
		code_verifier: params.verifier
	}));
}
async function refreshGoogleMeetAccessToken(params) {
	return await executeGoogleTokenRequest(tokenRequestBody({
		client_id: params.clientId,
		client_secret: params.clientSecret,
		grant_type: "refresh_token",
		refresh_token: params.refreshToken
	}));
}
function shouldUseCachedGoogleMeetAccessToken(params) {
	const now = params.now ?? Date.now();
	const safetyWindowMs = params.safetyWindowMs ?? 6e4;
	return Boolean(params.accessToken?.trim() && typeof params.expiresAt === "number" && Number.isFinite(params.expiresAt) && params.expiresAt > now + safetyWindowMs);
}
async function resolveGoogleMeetAccessToken(params) {
	if (shouldUseCachedGoogleMeetAccessToken(params)) return {
		accessToken: params.accessToken.trim(),
		expiresAt: params.expiresAt,
		refreshed: false
	};
	if (!params.clientId?.trim() || !params.refreshToken?.trim()) throw new Error("Missing Google Meet OAuth credentials. Configure oauth.clientId and oauth.refreshToken, or pass --client-id and --refresh-token.");
	const refreshed = await refreshGoogleMeetAccessToken({
		clientId: params.clientId,
		clientSecret: params.clientSecret,
		refreshToken: params.refreshToken
	});
	return {
		accessToken: refreshed.accessToken,
		expiresAt: refreshed.expiresAt,
		refreshed: true
	};
}
function createGoogleMeetPkce() {
	const { verifier, challenge } = generateHexPkceVerifierChallenge();
	return {
		verifier,
		challenge
	};
}
function createGoogleMeetOAuthState() {
	return generateOAuthState();
}
async function waitForGoogleMeetAuthCode(params) {
	params.writeLine(`Open this URL in your browser:\n\n${params.authUrl}\n`);
	if (params.manual) {
		const parsed = parseOAuthCallbackInput(await params.promptInput("Paste the full redirect URL here: "), {
			missingState: "Missing 'state' parameter. Paste the full redirect URL.",
			invalidInput: "Paste the full redirect URL, not just the code."
		});
		if ("error" in parsed) throw new Error(parsed.error);
		if (parsed.state !== params.state) throw new Error("OAuth state mismatch - please try again");
		return parsed.code;
	}
	return (await waitForLocalOAuthCallback({
		expectedState: params.state,
		timeoutMs: params.timeoutMs,
		port: 8085,
		callbackPath: "/oauth2callback",
		redirectUri: GOOGLE_MEET_REDIRECT_URI,
		successTitle: "Google Meet OAuth complete"
	})).code;
}
//#endregion
export { refreshGoogleMeetAccessToken as a, exchangeGoogleMeetAuthCode as i, createGoogleMeetOAuthState as n, resolveGoogleMeetAccessToken as o, createGoogleMeetPkce as r, waitForGoogleMeetAuthCode as s, buildGoogleMeetAuthUrl as t };
