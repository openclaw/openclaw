import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { s as upsertAuthProfileWithLock } from "./profiles-9GB1thhi.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { t as applyAuthProfileConfig } from "./provider-auth-helpers-BZ5Z8RV6.js";
import "./provider-auth-BtRKd5us.js";
import { r as stylePromptTitle } from "./prompt-style-DH7LpiPN.js";
import { r as logConfigUpdated } from "./logging-t-RUPR6R.js";
import { u as updateConfig } from "./shared-CXerptPG.js";
import "./config-mutation-C9bUHI1l.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./cli-runtime-hT2uaCvo.js";
import { intro, note, outro, spinner } from "@clack/prompts";
//#region extensions/github-copilot/login.ts
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_DEVICE_VERIFICATION_URL = "https://github.com/login/device";
const GITHUB_AUTH_SSRF_POLICY = { hostnameAllowlist: ["github.com"] };
const GITHUB_DEVICE_ACCESS_DENIED = Symbol("github-device-access-denied");
const GITHUB_DEVICE_EXPIRED = Symbol("github-device-expired");
var GitHubDeviceFlowError = class extends Error {
	constructor(kind, message) {
		super(message);
		this.kind = kind;
		this.name = "GitHubDeviceFlowError";
	}
};
let githubDeviceFlowFetchGuard = fetchWithSsrFGuard;
function setGitHubCopilotDeviceFlowFetchGuardForTesting(impl) {
	githubDeviceFlowFetchGuard = impl ?? fetchWithSsrFGuard;
}
async function upsertAuthProfileWithLockOrThrow(params) {
	if (!await upsertAuthProfileWithLock(params)) throw new Error("Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.");
}
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
async function postGitHubDeviceFlowForm(params) {
	const { response, release } = await githubDeviceFlowFetchGuard({
		url: params.url,
		init: {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded"
			},
			body: params.body
		},
		requireHttps: true,
		policy: GITHUB_AUTH_SSRF_POLICY,
		auditContext: "github-copilot-device-flow"
	});
	try {
		if (!response.ok) throw new Error(`${params.failureLabel}: HTTP ${response.status}`);
		return parseJsonResponse(await response.json());
	} finally {
		await release();
	}
}
async function requestDeviceCode(params) {
	const json = await postGitHubDeviceFlowForm({
		url: DEVICE_CODE_URL,
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: params.scope
		}),
		failureLabel: "GitHub device code failed"
	});
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
		const json = await postGitHubDeviceFlowForm({
			url: ACCESS_TOKEN_URL,
			body: bodyBase,
			failureLabel: "GitHub device token failed"
		});
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
	await upsertAuthProfileWithLockOrThrow({
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
export { runGitHubCopilotDeviceFlow as n, setGitHubCopilotDeviceFlowFetchGuardForTesting as r, githubCopilotLoginCommand as t };
