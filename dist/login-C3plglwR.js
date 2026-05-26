import { n as ensureAuthProfileStore } from "./store-a4exFSck.js";
import { a as upsertAuthProfile } from "./profiles-Bj_dclxz.js";
import { t as applyAuthProfileConfig } from "./provider-auth-helpers-Hp3hWZu2.js";
import "./provider-auth-D5QGE8z6.js";
import { r as stylePromptTitle } from "./prompt-style-CIp8kcUv.js";
import { n as logConfigUpdated } from "./logging-BIVQbiBA.js";
import { u as updateConfig } from "./shared-klZNy1Fm.js";
import "./config-mutation-BJc61hPG.js";
import "./cli-runtime-BuPrSAIi.js";
import { intro, note, outro, spinner } from "@clack/prompts";
//#region extensions/github-copilot/login.ts
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_DEVICE_VERIFICATION_URL = "https://github.com/login/device";
const GITHUB_DEVICE_ACCESS_DENIED = Symbol("github-device-access-denied");
const GITHUB_DEVICE_EXPIRED = Symbol("github-device-expired");
var GitHubDeviceFlowError = class extends Error {
	constructor(kind, message) {
		super(message);
		this.kind = kind;
		this.name = "GitHubDeviceFlowError";
	}
};
function isGitHubDeviceAccessDeniedError(err) {
	return err instanceof GitHubDeviceFlowError && err.kind === GITHUB_DEVICE_ACCESS_DENIED;
}
function isGitHubDeviceExpiredError(err) {
	return err instanceof GitHubDeviceFlowError && err.kind === GITHUB_DEVICE_EXPIRED;
}
function parseJsonResponse(value) {
	if (!value || typeof value !== "object") throw new Error("Unexpected response from GitHub");
	return value;
}
async function requestDeviceCode(params) {
	const body = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: params.scope
	});
	const res = await fetch(DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded"
		},
		body
	});
	if (!res.ok) throw new Error(`GitHub device code failed: HTTP ${res.status}`);
	const json = parseJsonResponse(await res.json());
	if (!json.device_code || !json.user_code || !json.verification_uri) throw new Error("GitHub device code response missing fields");
	return json;
}
async function pollForAccessToken(params) {
	const bodyBase = new URLSearchParams({
		client_id: CLIENT_ID,
		device_code: params.deviceCode,
		grant_type: "urn:ietf:params:oauth:grant-type:device_code"
	});
	while (Date.now() < params.expiresAt) {
		const res = await fetch(ACCESS_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded"
			},
			body: bodyBase
		});
		if (!res.ok) throw new Error(`GitHub device token failed: HTTP ${res.status}`);
		const json = parseJsonResponse(await res.json());
		if ("access_token" in json && typeof json.access_token === "string") return json.access_token;
		const err = "error" in json ? json.error : "unknown";
		if (err === "authorization_pending") {
			await new Promise((r) => setTimeout(r, params.intervalMs));
			continue;
		}
		if (err === "slow_down") {
			await new Promise((r) => setTimeout(r, params.intervalMs + 2e3));
			continue;
		}
		if (err === "expired_token") throw new GitHubDeviceFlowError(GITHUB_DEVICE_EXPIRED, "GitHub device code expired; run login again");
		if (err === "access_denied") throw new GitHubDeviceFlowError(GITHUB_DEVICE_ACCESS_DENIED, "GitHub login cancelled");
		throw new Error(`GitHub device flow error: ${err}`);
	}
	throw new GitHubDeviceFlowError(GITHUB_DEVICE_EXPIRED, "GitHub device code expired; run login again");
}
function normalizeGitHubDeviceVerificationUrl(raw) {
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("GitHub device flow returned an invalid verification URL");
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.pathname !== "/login/device" || parsed.username || parsed.password) throw new Error("GitHub device flow returned an unexpected verification URL");
	return GITHUB_DEVICE_VERIFICATION_URL;
}
function normalizeGitHubDeviceUserCode(raw) {
	const userCode = raw.trim();
	if (!userCode || userCode.length > 64) throw new Error("GitHub device flow returned an invalid user code");
	return userCode;
}
async function runGitHubCopilotDeviceFlow(io) {
	const device = await requestDeviceCode({ scope: "read:user" });
	const verificationUrl = normalizeGitHubDeviceVerificationUrl(device.verification_uri);
	const userCode = normalizeGitHubDeviceUserCode(device.user_code);
	const expiresInMs = device.expires_in * 1e3;
	const expiresAt = Date.now() + expiresInMs;
	await io.showCode({
		verificationUrl,
		userCode,
		expiresInMs
	});
	try {
		await io.openUrl?.(verificationUrl);
	} catch {}
	try {
		return {
			status: "authorized",
			accessToken: await pollForAccessToken({
				deviceCode: device.device_code,
				intervalMs: Math.max(1e3, device.interval * 1e3),
				expiresAt
			})
		};
	} catch (err) {
		if (isGitHubDeviceAccessDeniedError(err)) return { status: "access_denied" };
		if (isGitHubDeviceExpiredError(err)) return { status: "expired" };
		throw err;
	}
}
async function githubCopilotLoginCommand(opts, runtime) {
	if (!process.stdin.isTTY) throw new Error("github-copilot login requires an interactive TTY.");
	intro(stylePromptTitle("GitHub Copilot login"));
	const profileId = opts.profileId?.trim() || "github-copilot:github";
	if (ensureAuthProfileStore(opts.agentDir, { allowKeychainPrompt: false }).profiles[profileId] && !opts.yes) note(`Auth profile already exists: ${profileId}\nRe-running will overwrite it.`, stylePromptTitle("Existing credentials"));
	const spin = spinner();
	spin.start("Requesting device code from GitHub...");
	const device = await requestDeviceCode({ scope: "read:user" });
	spin.stop("Device code ready");
	note([`Visit: ${device.verification_uri}`, `Code: ${device.user_code}`].join("\n"), stylePromptTitle("Authorize"));
	const expiresAt = Date.now() + device.expires_in * 1e3;
	const intervalMs = Math.max(1e3, device.interval * 1e3);
	const polling = spinner();
	polling.start("Waiting for GitHub authorization...");
	const accessToken = await pollForAccessToken({
		deviceCode: device.device_code,
		intervalMs,
		expiresAt
	});
	polling.stop("GitHub access token acquired");
	upsertAuthProfile({
		profileId,
		credential: {
			type: "token",
			provider: "github-copilot",
			token: accessToken
		},
		agentDir: opts.agentDir
	});
	await updateConfig((cfg) => applyAuthProfileConfig(cfg, {
		provider: "github-copilot",
		profileId,
		mode: "token"
	}));
	logConfigUpdated(runtime);
	runtime.log(`Auth profile: ${profileId} (github-copilot/token)`);
	outro("Done");
}
//#endregion
export { runGitHubCopilotDeviceFlow as n, githubCopilotLoginCommand as t };
