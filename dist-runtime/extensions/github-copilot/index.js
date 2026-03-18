import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import { a as init_types_secrets, r as coerceSecretRef } from "../../types.secrets-Br5ssFsN.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import { l as resolveStateDir, r as init_paths } from "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import { a as displayPath, l as init_utils } from "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../core-CUbPSeQH.js";
import { o as loadJsonFile, s as saveJsonFile } from "../../paths-DAoqckDF.js";
import { Kn as PROVIDER_LABELS, Mr as normalizeModelCompat, Wa as stylePromptTitle, fp as createConfigIO, qn as clampPercent } from "../../auth-profiles-B70DPAVa.js";
import { a as ensureAuthProfileStore, i as upsertAuthProfile, n as listProfilesForProvider } from "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import "../../onboard-auth.config-core-C8O7u8CI.js";
import "../../onboard-auth.models-DU-07n1Q.js";
import { t as applyAuthProfileConfig } from "../../auth-profile-config-llBi0KHf.js";
import "../../onboard-auth.config-minimax-BZLhwFh4.js";
import "../../onboard-auth.config-opencode-CPtsorYE.js";
import "../../onboard-auth-D_nBXMz2.js";
import { n as fetchJson, t as buildUsageHttpErrorSnapshot } from "../../provider-usage.fetch.shared-QRsQTGuu.js";
import { t as updateConfig } from "../../shared-0J96S80B.js";
import path from "node:path";
import { intro, note, outro, spinner } from "@clack/prompts";
//#region src/config/logging.ts
init_types_secrets();
init_utils();
function formatConfigPath(path = createConfigIO().configPath) {
	return displayPath(path);
}
function logConfigUpdated(runtime, opts = {}) {
	const path = formatConfigPath(opts.path ?? createConfigIO().configPath);
	const suffix = opts.suffix ? ` ${opts.suffix}` : "";
	runtime.log(`Updated ${path}${suffix}`);
}
//#endregion
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
//#region extensions/github-copilot/token.ts
init_paths();
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
function resolveCopilotTokenCachePath(env = process.env) {
	return path.join(resolveStateDir(env), "credentials", "github-copilot.token.json");
}
function isTokenUsable(cache, now = Date.now()) {
	return cache.expiresAt - now > 300 * 1e3;
}
function parseCopilotTokenResponse(value) {
	if (!value || typeof value !== "object") throw new Error("Unexpected response from GitHub Copilot token endpoint");
	const asRecord = value;
	const token = asRecord.token;
	const expiresAt = asRecord.expires_at;
	if (typeof token !== "string" || token.trim().length === 0) throw new Error("Copilot token response missing token");
	let expiresAtMs;
	if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) expiresAtMs = expiresAt > 1e10 ? expiresAt : expiresAt * 1e3;
	else if (typeof expiresAt === "string" && expiresAt.trim().length > 0) {
		const parsed = Number.parseInt(expiresAt, 10);
		if (!Number.isFinite(parsed)) throw new Error("Copilot token response has invalid expires_at");
		expiresAtMs = parsed > 1e10 ? parsed : parsed * 1e3;
	} else throw new Error("Copilot token response missing expires_at");
	return {
		token,
		expiresAt: expiresAtMs
	};
}
const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
function deriveCopilotApiBaseUrlFromToken(token) {
	const trimmed = token.trim();
	if (!trimmed) return null;
	const proxyEp = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)?.[1]?.trim();
	if (!proxyEp) return null;
	const host = proxyEp.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
	if (!host) return null;
	return `https://${host}`;
}
async function resolveCopilotApiToken(params) {
	const env = params.env ?? process.env;
	const cachePath = params.cachePath?.trim() || resolveCopilotTokenCachePath(env);
	const loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
	const saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;
	const cached = loadJsonFileFn(cachePath);
	if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
		if (isTokenUsable(cached)) return {
			token: cached.token,
			expiresAt: cached.expiresAt,
			source: `cache:${cachePath}`,
			baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? "https://api.individual.githubcopilot.com"
		};
	}
	const res = await (params.fetchImpl ?? fetch)(COPILOT_TOKEN_URL, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${params.githubToken}`
		}
	});
	if (!res.ok) throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
	const json = parseCopilotTokenResponse(await res.json());
	const payload = {
		token: json.token,
		expiresAt: json.expiresAt,
		updatedAt: Date.now()
	};
	saveJsonFileFn(cachePath, payload);
	return {
		token: payload.token,
		expiresAt: payload.expiresAt,
		source: `fetched:${COPILOT_TOKEN_URL}`,
		baseUrl: deriveCopilotApiBaseUrlFromToken(payload.token) ?? "https://api.individual.githubcopilot.com"
	};
}
//#endregion
//#region extensions/github-copilot/usage.ts
async function fetchCopilotUsage(token, timeoutMs, fetchFn) {
	const res = await fetchJson("https://api.github.com/copilot_internal/user", { headers: {
		Authorization: `token ${token}`,
		"Editor-Version": "vscode/1.96.2",
		"User-Agent": "GitHubCopilotChat/0.26.7",
		"X-Github-Api-Version": "2025-04-01"
	} }, timeoutMs, fetchFn);
	if (!res.ok) return buildUsageHttpErrorSnapshot({
		provider: "github-copilot",
		status: res.status
	});
	const data = await res.json();
	const windows = [];
	if (data.quota_snapshots?.premium_interactions) {
		const remaining = data.quota_snapshots.premium_interactions.percent_remaining;
		windows.push({
			label: "Premium",
			usedPercent: clampPercent(100 - (remaining ?? 0))
		});
	}
	if (data.quota_snapshots?.chat) {
		const remaining = data.quota_snapshots.chat.percent_remaining;
		windows.push({
			label: "Chat",
			usedPercent: clampPercent(100 - (remaining ?? 0))
		});
	}
	return {
		provider: "github-copilot",
		displayName: PROVIDER_LABELS["github-copilot"],
		windows,
		plan: data.copilot_plan
	};
}
//#endregion
//#region extensions/github-copilot/index.ts
const PROVIDER_ID = "github-copilot";
const COPILOT_ENV_VARS = [
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN"
];
const CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"];
const COPILOT_XHIGH_MODEL_IDS = ["gpt-5.2", "gpt-5.2-codex"];
function resolveFirstGithubToken(params) {
	const authStore = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
	const hasProfile = listProfilesForProvider(authStore, PROVIDER_ID).length > 0;
	const githubToken = (params.env.COPILOT_GITHUB_TOKEN ?? params.env.GH_TOKEN ?? params.env.GITHUB_TOKEN ?? "").trim();
	if (githubToken || !hasProfile) return {
		githubToken,
		hasProfile
	};
	const profileId = listProfilesForProvider(authStore, PROVIDER_ID)[0];
	const profile = profileId ? authStore.profiles[profileId] : void 0;
	if (profile?.type !== "token") return {
		githubToken: "",
		hasProfile
	};
	const directToken = profile.token?.trim() ?? "";
	if (directToken) return {
		githubToken: directToken,
		hasProfile
	};
	const tokenRef = coerceSecretRef(profile.tokenRef);
	if (tokenRef?.source === "env" && tokenRef.id.trim()) return {
		githubToken: (params.env[tokenRef.id] ?? process.env[tokenRef.id] ?? "").trim(),
		hasProfile
	};
	return {
		githubToken: "",
		hasProfile
	};
}
function resolveCopilotForwardCompatModel(ctx) {
	const trimmedModelId = ctx.modelId.trim();
	if (trimmedModelId.toLowerCase() !== CODEX_GPT_53_MODEL_ID) return;
	for (const templateId of CODEX_TEMPLATE_MODEL_IDS) {
		const template = ctx.modelRegistry.find(PROVIDER_ID, templateId);
		if (!template) continue;
		return normalizeModelCompat({
			...template,
			id: trimmedModelId,
			name: trimmedModelId
		});
	}
}
async function runGitHubCopilotAuth(ctx) {
	await ctx.prompter.note(["This will open a GitHub device login to authorize Copilot.", "Requires an active GitHub Copilot subscription."].join("\n"), "GitHub Copilot");
	if (!process.stdin.isTTY) {
		await ctx.prompter.note("GitHub Copilot login requires an interactive TTY.", "GitHub Copilot");
		return { profiles: [] };
	}
	try {
		await githubCopilotLoginCommand({
			yes: true,
			profileId: "github-copilot:github"
		}, ctx.runtime);
	} catch (err) {
		await ctx.prompter.note(`GitHub Copilot login failed: ${String(err)}`, "GitHub Copilot");
		return { profiles: [] };
	}
	const credential = ensureAuthProfileStore(void 0, { allowKeychainPrompt: false }).profiles["github-copilot:github"];
	if (!credential || credential.type !== "token") return { profiles: [] };
	return {
		profiles: [{
			profileId: "github-copilot:github",
			credential
		}],
		defaultModel: "github-copilot/gpt-4o"
	};
}
const githubCopilotPlugin = {
	id: "github-copilot",
	name: "GitHub Copilot Provider",
	description: "Bundled GitHub Copilot provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "GitHub Copilot",
			docsPath: "/providers/models",
			envVars: COPILOT_ENV_VARS,
			auth: [{
				id: "device",
				label: "GitHub device login",
				hint: "Browser device-code flow",
				kind: "device_code",
				run: async (ctx) => await runGitHubCopilotAuth(ctx)
			}],
			wizard: { setup: {
				choiceId: "github-copilot",
				choiceLabel: "GitHub Copilot",
				choiceHint: "Device login with your GitHub account",
				methodId: "device"
			} },
			catalog: {
				order: "late",
				run: async (ctx) => {
					const { githubToken, hasProfile } = resolveFirstGithubToken({
						agentDir: ctx.agentDir,
						env: ctx.env
					});
					if (!hasProfile && !githubToken) return null;
					let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
					if (githubToken) try {
						baseUrl = (await resolveCopilotApiToken({
							githubToken,
							env: ctx.env
						})).baseUrl;
					} catch {
						baseUrl = DEFAULT_COPILOT_API_BASE_URL;
					}
					return { provider: {
						baseUrl,
						models: []
					} };
				}
			},
			resolveDynamicModel: (ctx) => resolveCopilotForwardCompatModel(ctx),
			capabilities: { dropThinkingBlockModelHints: ["claude"] },
			supportsXHighThinking: ({ modelId }) => COPILOT_XHIGH_MODEL_IDS.includes(modelId.trim().toLowerCase()),
			prepareRuntimeAuth: async (ctx) => {
				const token = await resolveCopilotApiToken({
					githubToken: ctx.apiKey,
					env: ctx.env
				});
				return {
					apiKey: token.token,
					baseUrl: token.baseUrl,
					expiresAt: token.expiresAt
				};
			},
			resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
			fetchUsageSnapshot: async (ctx) => await fetchCopilotUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn)
		});
	}
};
//#endregion
export { githubCopilotPlugin as default };
