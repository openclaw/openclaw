import { Av as upsertAuthProfile, jv as ensureAuthProfileStore } from "./reply-kqyKJg4x.js";
import { r as stylePromptTitle } from "./prompt-style-DxRe6Qmy.js";
import { an as updateConfig, s as createVpsAwareOAuthHandlers, y as applyAuthProfileConfig } from "./provider-auth-helpers-ZFf3jF1w.js";
import { n as logConfigUpdated } from "./logging-nVXls4VL.js";
import { r as runOpenAIOAuthTlsPreflight, t as formatOpenAIOAuthTlsPreflightFix } from "./oauth-tls-preflight-D-pVBj7x.js";
import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";
import { intro, note, outro, spinner } from "@clack/prompts";
//#region src/providers/github-copilot-auth.ts
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
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
		if (err === "expired_token") throw new Error("GitHub device code expired; run login again");
		if (err === "access_denied") throw new Error("GitHub login cancelled");
		throw new Error(`GitHub device flow error: ${err}`);
	}
	throw new Error("GitHub device code expired; run login again");
}
async function githubCopilotLoginCommand(opts, runtime) {
	if (!process.stdin.isTTY) throw new Error("github-copilot login requires an interactive TTY.");
	intro(stylePromptTitle("GitHub Copilot login"));
	const profileId = opts.profileId?.trim() || "github-copilot:github";
	if (ensureAuthProfileStore(void 0, { allowKeychainPrompt: false }).profiles[profileId] && !opts.yes) note(`Auth profile already exists: ${profileId}\nRe-running will overwrite it.`, stylePromptTitle("Existing credentials"));
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
		}
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
//#region src/commands/openai-codex-oauth.ts
async function loginOpenAICodexOAuth(params) {
	const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;
	const preflight = await runOpenAIOAuthTlsPreflight();
	if (!preflight.ok && preflight.kind === "tls-cert") {
		const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
		runtime.error(hint);
		await prompter.note(hint, "OAuth prerequisites");
		throw new Error(preflight.message);
	}
	await prompter.note(isRemote ? [
		"You are running in a remote/VPS environment.",
		"A URL will be shown for you to open in your LOCAL browser.",
		"After signing in, paste the redirect URL back here."
	].join("\n") : [
		"Browser will open for OpenAI authentication.",
		"If the callback doesn't auto-complete, paste the redirect URL.",
		"OpenAI OAuth uses localhost:1455 for the callback."
	].join("\n"), "OpenAI Codex OAuth");
	const spin = prompter.progress("Starting OAuth flow…");
	try {
		const { onAuth: baseOnAuth, onPrompt } = createVpsAwareOAuthHandlers({
			isRemote,
			prompter,
			runtime,
			spin,
			openUrl,
			localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…"
		});
		const creds = await loginOpenAICodex({
			onAuth: baseOnAuth,
			onPrompt,
			onProgress: (msg) => spin.update(msg)
		});
		spin.stop("OpenAI OAuth complete");
		return creds ?? null;
	} catch (err) {
		spin.stop("OpenAI OAuth failed");
		runtime.error(String(err));
		await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
		throw err;
	}
}
//#endregion
export { githubCopilotLoginCommand as n, loginOpenAICodexOAuth as t };
