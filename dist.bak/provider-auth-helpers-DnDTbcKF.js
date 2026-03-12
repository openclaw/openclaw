import { s as createSubsystemLogger } from "./entry.js";
import { Vn as normalizeProviderId, _n as upsertAuthProfile, bn as ensureAuthProfileStore } from "./auth-profiles-D6H-HVV8.js";
import { _ as loadOpenClawPlugins, g as createPluginLoaderLogger } from "./subagent-registry-BrzwRDvR.js";
import { r as isWSLEnv } from "./wsl-D9-kubbW.js";
import { r as stylePromptTitle } from "./prompt-style-wsroINzm.js";
import { f as updateConfig } from "./shared-BR_F1Bso.js";
import { d as applyAuthProfileConfig } from "./auth-token-1wFUIrL0.js";
import { n as logConfigUpdated } from "./logging-Bi2fXy2a.js";
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
//#region src/plugins/providers.ts
const log = createSubsystemLogger("plugins");
function resolvePluginProviders(params) {
	return loadOpenClawPlugins({
		config: params.config,
		workspaceDir: params.workspaceDir,
		logger: createPluginLoaderLogger(log)
	}).providers.map((entry) => entry.provider);
}

//#endregion
//#region src/commands/oauth-env.ts
function isRemoteEnvironment() {
	if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) return true;
	if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) return true;
	if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWSLEnv()) return true;
	return false;
}

//#endregion
//#region src/commands/oauth-flow.ts
const validateRequiredInput = (value) => value.trim().length > 0 ? void 0 : "Required";
function createVpsAwareOAuthHandlers(params) {
	const manualPromptMessage = params.manualPromptMessage ?? "Paste the redirect URL";
	let manualCodePromise;
	return {
		onAuth: async ({ url }) => {
			if (params.isRemote) {
				params.spin.stop("OAuth URL ready");
				params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
				manualCodePromise = params.prompter.text({
					message: manualPromptMessage,
					validate: validateRequiredInput
				}).then((value) => String(value));
				return;
			}
			params.spin.update(params.localBrowserMessage);
			await params.openUrl(url);
			params.runtime.log(`Open: ${url}`);
		},
		onPrompt: async (prompt) => {
			if (manualCodePromise) return manualCodePromise;
			const code = await params.prompter.text({
				message: prompt.message,
				placeholder: prompt.placeholder,
				validate: validateRequiredInput
			});
			return String(code);
		}
	};
}

//#endregion
//#region src/commands/provider-auth-helpers.ts
function resolveProviderMatch(providers, rawProvider) {
	const raw = rawProvider?.trim();
	if (!raw) return null;
	const normalized = normalizeProviderId(raw);
	return providers.find((provider) => normalizeProviderId(provider.id) === normalized) ?? providers.find((provider) => provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false) ?? null;
}
function pickAuthMethod(provider, rawMethod) {
	const raw = rawMethod?.trim();
	if (!raw) return null;
	const normalized = raw.toLowerCase();
	return provider.auth.find((method) => method.id.toLowerCase() === normalized) ?? provider.auth.find((method) => method.label.toLowerCase() === normalized) ?? null;
}
function isPlainRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function mergeConfigPatch(base, patch) {
	if (!isPlainRecord(base) || !isPlainRecord(patch)) return patch;
	const next = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const existing = next[key];
		if (isPlainRecord(existing) && isPlainRecord(value)) next[key] = mergeConfigPatch(existing, value);
		else next[key] = value;
	}
	return next;
}
function applyDefaultModel(cfg, model) {
	const models = { ...cfg.agents?.defaults?.models };
	models[model] = models[model] ?? {};
	const existingModel = cfg.agents?.defaults?.model;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models,
				model: {
					...existingModel && typeof existingModel === "object" && "fallbacks" in existingModel ? { fallbacks: existingModel.fallbacks } : void 0,
					primary: model
				}
			}
		}
	};
}

//#endregion
export { createVpsAwareOAuthHandlers as a, githubCopilotLoginCommand as c, resolveProviderMatch as i, mergeConfigPatch as n, isRemoteEnvironment as o, pickAuthMethod as r, resolvePluginProviders as s, applyDefaultModel as t };