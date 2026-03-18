import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import { t as formatCliCommand } from "../../command-format-ZZqKRRhR.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import { t as buildOauthProviderAuthResult } from "../../provider-auth-result-BwNanZxe.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../paths-DAoqckDF.js";
import "../../auth-profiles-B70DPAVa.js";
import { a as ensureAuthProfileStore, n as listProfilesForProvider } from "../../profiles-BC4VpDll.js";
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
import { n as toFormUrlEncoded, t as generatePkceVerifierChallenge } from "../../oauth-utils-DAKBjISm.js";
import { randomUUID } from "node:crypto";
//#region src/providers/qwen-portal-oauth.ts
const QWEN_OAUTH_TOKEN_ENDPOINT$1 = `https://chat.qwen.ai/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID$1 = "f0304373b74a44d2b584a3fb70ca9e56";
async function refreshQwenPortalCredentials(credentials) {
	const refreshToken = credentials.refresh?.trim();
	if (!refreshToken) throw new Error("Qwen OAuth refresh token missing; re-authenticate.");
	const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT$1, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: QWEN_OAUTH_CLIENT_ID$1
		})
	});
	if (!response.ok) {
		const text = await response.text();
		if (response.status === 400) throw new Error(`Qwen OAuth refresh token expired or invalid. Re-authenticate with \`${formatCliCommand("openclaw models auth login --provider qwen-portal")}\`.`);
		throw new Error(`Qwen OAuth refresh failed: ${text || response.statusText}`);
	}
	const payload = await response.json();
	const accessToken = payload.access_token?.trim();
	const newRefreshToken = payload.refresh_token?.trim();
	const expiresIn = payload.expires_in;
	if (!accessToken) throw new Error("Qwen OAuth refresh response missing access token.");
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("Qwen OAuth refresh response missing or invalid expires_in.");
	return {
		...credentials,
		access: accessToken,
		refresh: newRefreshToken || refreshToken,
		expires: Date.now() + expiresIn * 1e3
	};
}
//#endregion
//#region extensions/qwen-portal-auth/oauth.ts
const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_OAUTH_SCOPE = "openid profile email model.completion";
const QWEN_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
async function requestDeviceCode(params) {
	const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"x-request-id": randomUUID()
		},
		body: toFormUrlEncoded({
			client_id: QWEN_OAUTH_CLIENT_ID,
			scope: QWEN_OAUTH_SCOPE,
			code_challenge: params.challenge,
			code_challenge_method: "S256"
		})
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Qwen device authorization failed: ${text || response.statusText}`);
	}
	const payload = await response.json();
	if (!payload.device_code || !payload.user_code || !payload.verification_uri) throw new Error(payload.error ?? "Qwen device authorization returned an incomplete payload (missing user_code or verification_uri).");
	return payload;
}
async function pollDeviceToken(params) {
	const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		},
		body: toFormUrlEncoded({
			grant_type: QWEN_OAUTH_GRANT_TYPE,
			client_id: QWEN_OAUTH_CLIENT_ID,
			device_code: params.deviceCode,
			code_verifier: params.verifier
		})
	});
	if (!response.ok) {
		let payload;
		try {
			payload = await response.json();
		} catch {
			return {
				status: "error",
				message: await response.text() || response.statusText
			};
		}
		if (payload?.error === "authorization_pending") return { status: "pending" };
		if (payload?.error === "slow_down") return {
			status: "pending",
			slowDown: true
		};
		return {
			status: "error",
			message: payload?.error_description || payload?.error || response.statusText
		};
	}
	const tokenPayload = await response.json();
	if (!tokenPayload.access_token || !tokenPayload.refresh_token || !tokenPayload.expires_in) return {
		status: "error",
		message: "Qwen OAuth returned incomplete token payload."
	};
	return {
		status: "success",
		token: {
			access: tokenPayload.access_token,
			refresh: tokenPayload.refresh_token,
			expires: Date.now() + tokenPayload.expires_in * 1e3,
			resourceUrl: tokenPayload.resource_url
		}
	};
}
async function loginQwenPortalOAuth(params) {
	const { verifier, challenge } = generatePkceVerifierChallenge();
	const device = await requestDeviceCode({ challenge });
	const verificationUrl = device.verification_uri_complete || device.verification_uri;
	await params.note([`Open ${verificationUrl} to approve access.`, `If prompted, enter the code ${device.user_code}.`].join("\n"), "Qwen OAuth");
	try {
		await params.openUrl(verificationUrl);
	} catch {}
	const start = Date.now();
	let pollIntervalMs = device.interval ? device.interval * 1e3 : 2e3;
	const timeoutMs = device.expires_in * 1e3;
	while (Date.now() - start < timeoutMs) {
		params.progress.update("Waiting for Qwen OAuth approval…");
		const result = await pollDeviceToken({
			deviceCode: device.device_code,
			verifier
		});
		if (result.status === "success") return result.token;
		if (result.status === "error") throw new Error(`Qwen OAuth failed: ${result.message}`);
		if (result.status === "pending" && result.slowDown) pollIntervalMs = Math.min(pollIntervalMs * 1.5, 1e4);
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
	throw new Error("Qwen OAuth timed out waiting for authorization.");
}
//#endregion
//#region extensions/qwen-portal-auth/index.ts
const PROVIDER_ID = "qwen-portal";
const PROVIDER_LABEL = "Qwen";
const DEFAULT_MODEL = "qwen-portal/coder-model";
const DEFAULT_BASE_URL = "https://portal.qwen.ai/v1";
const DEFAULT_CONTEXT_WINDOW = 128e3;
const DEFAULT_MAX_TOKENS = 8192;
function normalizeBaseUrl(value) {
	const raw = value?.trim() || DEFAULT_BASE_URL;
	const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
	return withProtocol.endsWith("/v1") ? withProtocol : `${withProtocol.replace(/\/+$/, "")}/v1`;
}
function buildModelDefinition(params) {
	return {
		id: params.id,
		name: params.name,
		reasoning: false,
		input: params.input,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS
	};
}
function buildProviderCatalog(params) {
	return {
		baseUrl: params.baseUrl,
		apiKey: params.apiKey,
		api: "openai-completions",
		models: [buildModelDefinition({
			id: "coder-model",
			name: "Qwen Coder",
			input: ["text"]
		}), buildModelDefinition({
			id: "vision-model",
			name: "Qwen Vision",
			input: ["text", "image"]
		})]
	};
}
function resolveCatalog(ctx) {
	const explicitProvider = ctx.config.models?.providers?.[PROVIDER_ID];
	const envApiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
	const hasProfiles = listProfilesForProvider(ensureAuthProfileStore(ctx.agentDir, { allowKeychainPrompt: false }), PROVIDER_ID).length > 0;
	const explicitApiKey = typeof explicitProvider?.apiKey === "string" ? explicitProvider.apiKey.trim() : void 0;
	const apiKey = envApiKey ?? explicitApiKey ?? (hasProfiles ? "qwen-oauth" : void 0);
	if (!apiKey) return null;
	return { provider: buildProviderCatalog({
		baseUrl: normalizeBaseUrl(typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl : void 0),
		apiKey
	}) };
}
const qwenPortalPlugin = {
	id: "qwen-portal-auth",
	name: "Qwen OAuth",
	description: "OAuth flow for Qwen (free-tier) models",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: PROVIDER_LABEL,
			docsPath: "/providers/qwen",
			aliases: ["qwen"],
			envVars: ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"],
			catalog: { run: async (ctx) => resolveCatalog(ctx) },
			auth: [{
				id: "device",
				label: "Qwen OAuth",
				hint: "Device code login",
				kind: "device_code",
				run: async (ctx) => {
					const progress = ctx.prompter.progress("Starting Qwen OAuth…");
					try {
						const result = await loginQwenPortalOAuth({
							openUrl: ctx.openUrl,
							note: ctx.prompter.note,
							progress
						});
						progress.stop("Qwen OAuth complete");
						const baseUrl = normalizeBaseUrl(result.resourceUrl);
						return buildOauthProviderAuthResult({
							providerId: PROVIDER_ID,
							defaultModel: DEFAULT_MODEL,
							access: result.access,
							refresh: result.refresh,
							expires: result.expires,
							configPatch: {
								models: { providers: { [PROVIDER_ID]: {
									baseUrl,
									models: []
								} } },
								agents: { defaults: { models: {
									"qwen-portal/coder-model": { alias: "qwen" },
									"qwen-portal/vision-model": {}
								} } }
							},
							notes: ["Qwen OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.", `Base URL defaults to ${DEFAULT_BASE_URL}. Override models.providers.${PROVIDER_ID}.baseUrl if needed.`]
						});
					} catch (err) {
						progress.stop("Qwen OAuth failed");
						await ctx.prompter.note("If OAuth fails, verify your Qwen account has portal access and try again.", "Qwen OAuth");
						throw err;
					}
				}
			}],
			wizard: { setup: {
				choiceId: "qwen-portal",
				choiceLabel: "Qwen OAuth",
				choiceHint: "Device code login",
				methodId: "device"
			} },
			refreshOAuth: async (cred) => ({
				...cred,
				...await refreshQwenPortalCredentials(cred),
				type: "oauth",
				provider: PROVIDER_ID,
				email: cred.email
			})
		});
	}
};
//#endregion
export { qwenPortalPlugin as default };
