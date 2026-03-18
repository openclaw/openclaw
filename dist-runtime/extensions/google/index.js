import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
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
import { Mr as normalizeModelCompat } from "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import { a as isWSL2Sync } from "../../fetch-BX2RRCzB.js";
import { f as fetchWithSsrFGuard } from "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import { i as setScopedCredentialValue, n as getScopedCredentialValue, t as createPluginBackedWebSearchProvider } from "../../web-search-plugin-factory-CeUlA68v.js";
import { t as applyAgentDefaultPrimaryModel } from "../../model-default-DJXHDqfR.js";
import "../../provider-usage.fetch.shared-QRsQTGuu.js";
import { r as fetchGeminiUsage } from "../../provider-usage.fetch-FLyQVPB8.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
//#region src/commands/google-gemini-model-default.ts
const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
function applyGoogleGeminiModelDefault(cfg) {
	return applyAgentDefaultPrimaryModel({
		cfg,
		model: GOOGLE_GEMINI_DEFAULT_MODEL
	});
}
//#endregion
//#region extensions/google/oauth.shared.ts
const CLIENT_ID_KEYS = ["OPENCLAW_GEMINI_OAUTH_CLIENT_ID", "GEMINI_CLI_OAUTH_CLIENT_ID"];
const CLIENT_SECRET_KEYS = ["OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET", "GEMINI_CLI_OAUTH_CLIENT_SECRET"];
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CODE_ASSIST_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
const LOAD_CODE_ASSIST_ENDPOINTS = [
	CODE_ASSIST_ENDPOINT_PROD,
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com"
];
const DEFAULT_FETCH_TIMEOUT_MS = 1e4;
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile"
];
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";
//#endregion
//#region extensions/google/oauth.credentials.ts
function resolveEnv(keys) {
	for (const key of keys) {
		const value = process.env[key]?.trim();
		if (value) return value;
	}
}
let cachedGeminiCliCredentials = null;
function extractGeminiCliCredentials() {
	if (cachedGeminiCliCredentials) return cachedGeminiCliCredentials;
	try {
		const geminiPath = findInPath("gemini");
		if (!geminiPath) return null;
		const geminiCliDirs = resolveGeminiCliDirs(geminiPath, realpathSync(geminiPath));
		let content = null;
		for (const geminiCliDir of geminiCliDirs) {
			const searchPaths = [join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"), join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "code_assist", "oauth2.js")];
			for (const path of searchPaths) if (existsSync(path)) {
				content = readFileSync(path, "utf8");
				break;
			}
			if (content) break;
			const found = findFile(geminiCliDir, "oauth2.js", 10);
			if (found) {
				content = readFileSync(found, "utf8");
				break;
			}
		}
		if (!content) return null;
		const idMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
		const secretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
		if (idMatch && secretMatch) {
			cachedGeminiCliCredentials = {
				clientId: idMatch[1],
				clientSecret: secretMatch[1]
			};
			return cachedGeminiCliCredentials;
		}
	} catch {}
	return null;
}
function resolveGeminiCliDirs(geminiPath, resolvedPath) {
	const binDir = dirname(geminiPath);
	const candidates = [
		dirname(dirname(resolvedPath)),
		join(dirname(resolvedPath), "node_modules", "@google", "gemini-cli"),
		join(binDir, "node_modules", "@google", "gemini-cli"),
		join(dirname(binDir), "node_modules", "@google", "gemini-cli"),
		join(dirname(binDir), "lib", "node_modules", "@google", "gemini-cli")
	];
	const deduped = [];
	const seen = /* @__PURE__ */ new Set();
	for (const candidate of candidates) {
		const key = process.platform === "win32" ? candidate.replace(/\\/g, "/").toLowerCase() : candidate;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(candidate);
	}
	return deduped;
}
function findInPath(name) {
	const exts = process.platform === "win32" ? [
		".cmd",
		".bat",
		".exe",
		""
	] : [""];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) for (const ext of exts) {
		const path = join(dir, name + ext);
		if (existsSync(path)) return path;
	}
	return null;
}
function findFile(dir, name, depth) {
	if (depth <= 0) return null;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isFile() && entry.name === name) return path;
			if (entry.isDirectory() && !entry.name.startsWith(".")) {
				const found = findFile(path, name, depth - 1);
				if (found) return found;
			}
		}
	} catch {}
	return null;
}
function resolveOAuthClientConfig() {
	const envClientId = resolveEnv(CLIENT_ID_KEYS);
	const envClientSecret = resolveEnv(CLIENT_SECRET_KEYS);
	if (envClientId) return {
		clientId: envClientId,
		clientSecret: envClientSecret
	};
	const extracted = extractGeminiCliCredentials();
	if (extracted) return extracted;
	throw new Error("Gemini CLI not found. Install it first: brew install gemini-cli (or npm install -g @google/gemini-cli), or set GEMINI_CLI_OAUTH_CLIENT_ID.");
}
//#endregion
//#region extensions/google/oauth.flow.ts
function shouldUseManualOAuthFlow(isRemote) {
	return isRemote || isWSL2Sync();
}
function generatePkce() {
	const verifier = randomBytes(32).toString("hex");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url")
	};
}
function buildAuthUrl(challenge, verifier) {
	const { clientId } = resolveOAuthClientConfig();
	return `${AUTH_URL}?${new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
		access_type: "offline",
		prompt: "consent"
	}).toString()}`;
}
function parseCallbackInput(input, expectedState) {
	const trimmed = input.trim();
	if (!trimmed) return { error: "No input provided" };
	try {
		const url = new URL(trimmed);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") ?? expectedState;
		if (!code) return { error: "Missing 'code' parameter in URL" };
		if (!state) return { error: "Missing 'state' parameter. Paste the full URL." };
		return {
			code,
			state
		};
	} catch {
		if (!expectedState) return { error: "Paste the full redirect URL, not just the code." };
		return {
			code: trimmed,
			state: expectedState
		};
	}
}
async function waitForLocalCallback(params) {
	const port = 8085;
	const hostname = "localhost";
	const expectedPath = "/oauth2callback";
	return new Promise((resolve, reject) => {
		let timeout = null;
		const server = createServer((req, res) => {
			try {
				const requestUrl = new URL(req.url ?? "/", `http://${hostname}:${port}`);
				if (requestUrl.pathname !== expectedPath) {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/plain");
					res.end("Not found");
					return;
				}
				const error = requestUrl.searchParams.get("error");
				const code = requestUrl.searchParams.get("code")?.trim();
				const state = requestUrl.searchParams.get("state")?.trim();
				if (error) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/plain");
					res.end(`Authentication failed: ${error}`);
					finish(/* @__PURE__ */ new Error(`OAuth error: ${error}`));
					return;
				}
				if (!code || !state) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/plain");
					res.end("Missing code or state");
					finish(/* @__PURE__ */ new Error("Missing OAuth code or state"));
					return;
				}
				if (state !== params.expectedState) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/plain");
					res.end("Invalid state");
					finish(/* @__PURE__ */ new Error("OAuth state mismatch"));
					return;
				}
				res.statusCode = 200;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end("<!doctype html><html><head><meta charset='utf-8'/></head><body><h2>Gemini CLI OAuth complete</h2><p>You can close this window and return to OpenClaw.</p></body></html>");
				finish(void 0, {
					code,
					state
				});
			} catch (err) {
				finish(err instanceof Error ? err : /* @__PURE__ */ new Error("OAuth callback failed"));
			}
		});
		const finish = (err, result) => {
			if (timeout) clearTimeout(timeout);
			try {
				server.close();
			} catch {}
			if (err) reject(err);
			else if (result) resolve(result);
		};
		server.once("error", (err) => {
			finish(err instanceof Error ? err : /* @__PURE__ */ new Error("OAuth callback server error"));
		});
		server.listen(port, hostname, () => {
			params.onProgress?.(`Waiting for OAuth callback on ${REDIRECT_URI}…`);
		});
		timeout = setTimeout(() => {
			finish(/* @__PURE__ */ new Error("OAuth callback timeout"));
		}, params.timeoutMs);
	});
}
//#endregion
//#region extensions/google/oauth.http.ts
async function fetchWithTimeout(url, init, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
	const { response, release } = await fetchWithSsrFGuard({
		url,
		init,
		timeoutMs
	});
	try {
		const body = await response.arrayBuffer();
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	} finally {
		await release();
	}
}
//#endregion
//#region extensions/google/oauth.project.ts
function resolvePlatform() {
	if (process.platform === "win32") return "WINDOWS";
	if (process.platform === "darwin") return "MACOS";
	return "PLATFORM_UNSPECIFIED";
}
async function getUserEmail(accessToken) {
	try {
		const response = await fetchWithTimeout(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
		if (response.ok) return (await response.json()).email;
	} catch {}
}
function isVpcScAffected(payload) {
	if (!payload || typeof payload !== "object") return false;
	const error = payload.error;
	if (!error || typeof error !== "object") return false;
	const details = error.details;
	if (!Array.isArray(details)) return false;
	return details.some((item) => typeof item === "object" && item && item.reason === "SECURITY_POLICY_VIOLATED");
}
function getDefaultTier(allowedTiers) {
	if (!allowedTiers?.length) return { id: TIER_LEGACY };
	return allowedTiers.find((tier) => tier.isDefault) ?? { id: "legacy-tier" };
}
async function pollOperation(endpoint, operationName, headers) {
	for (let attempt = 0; attempt < 24; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5e3));
		const response = await fetchWithTimeout(`${endpoint}/v1internal/${operationName}`, { headers });
		if (!response.ok) continue;
		const data = await response.json();
		if (data.done) return data;
	}
	throw new Error("Operation polling timeout");
}
async function resolveGoogleOAuthIdentity(accessToken) {
	return {
		email: await getUserEmail(accessToken),
		projectId: await discoverProject(accessToken)
	};
}
async function discoverProject(accessToken) {
	const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	const metadata = {
		ideType: "ANTIGRAVITY",
		platform: resolvePlatform(),
		pluginType: "GEMINI"
	};
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": `gl-node/${process.versions.node}`,
		"Client-Metadata": JSON.stringify(metadata)
	};
	const loadBody = {
		...envProject ? { cloudaicompanionProject: envProject } : {},
		metadata: {
			...metadata,
			...envProject ? { duetProject: envProject } : {}
		}
	};
	let data = {};
	let activeEndpoint = CODE_ASSIST_ENDPOINT_PROD;
	let loadError;
	for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) try {
		const response = await fetchWithTimeout(`${endpoint}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers,
			body: JSON.stringify(loadBody)
		});
		if (!response.ok) {
			if (isVpcScAffected(await response.json().catch(() => null))) {
				data = { currentTier: { id: TIER_STANDARD } };
				activeEndpoint = endpoint;
				loadError = void 0;
				break;
			}
			loadError = /* @__PURE__ */ new Error(`loadCodeAssist failed: ${response.status} ${response.statusText}`);
			continue;
		}
		data = await response.json();
		activeEndpoint = endpoint;
		loadError = void 0;
		break;
	} catch (err) {
		loadError = err instanceof Error ? err : new Error("loadCodeAssist failed", { cause: err });
	}
	if (!(Boolean(data.currentTier) || Boolean(data.cloudaicompanionProject) || Boolean(data.allowedTiers?.length)) && loadError) {
		if (envProject) return envProject;
		throw loadError;
	}
	if (data.currentTier) {
		const project = data.cloudaicompanionProject;
		if (typeof project === "string" && project) return project;
		if (typeof project === "object" && project?.id) return project.id;
		if (envProject) return envProject;
		throw new Error("This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.");
	}
	const tierId = getDefaultTier(data.allowedTiers)?.id || "free-tier";
	if (tierId !== "free-tier" && !envProject) throw new Error("This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.");
	const onboardBody = {
		tierId,
		metadata: { ...metadata }
	};
	if (tierId !== "free-tier" && envProject) {
		onboardBody.cloudaicompanionProject = envProject;
		onboardBody.metadata.duetProject = envProject;
	}
	const onboardResponse = await fetchWithTimeout(`${activeEndpoint}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		body: JSON.stringify(onboardBody)
	});
	if (!onboardResponse.ok) throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}`);
	let lro = await onboardResponse.json();
	if (!lro.done && lro.name) lro = await pollOperation(activeEndpoint, lro.name, headers);
	const projectId = lro.response?.cloudaicompanionProject?.id;
	if (projectId) return projectId;
	if (envProject) return envProject;
	throw new Error("Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.");
}
//#endregion
//#region extensions/google/oauth.token.ts
async function exchangeCodeForTokens(code, verifier) {
	const { clientId, clientSecret } = resolveOAuthClientConfig();
	const body = new URLSearchParams({
		client_id: clientId,
		code,
		grant_type: "authorization_code",
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier
	});
	if (clientSecret) body.set("client_secret", clientSecret);
	const response = await fetchWithTimeout(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
			Accept: "*/*",
			"User-Agent": "google-api-nodejs-client/9.15.1"
		},
		body
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Token exchange failed: ${errorText}`);
	}
	const data = await response.json();
	if (!data.refresh_token) throw new Error("No refresh token received. Please try again.");
	const identity = await resolveGoogleOAuthIdentity(data.access_token);
	const expiresAt = Date.now() + data.expires_in * 1e3 - 300 * 1e3;
	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: expiresAt,
		projectId: identity.projectId,
		email: identity.email
	};
}
//#endregion
//#region extensions/google/oauth.ts
async function loginGeminiCliOAuth(ctx) {
	const needsManual = shouldUseManualOAuthFlow(ctx.isRemote);
	await ctx.note(needsManual ? [
		"You are running in a remote/VPS environment.",
		"A URL will be shown for you to open in your LOCAL browser.",
		"After signing in, copy the redirect URL and paste it back here."
	].join("\n") : [
		"Browser will open for Google authentication.",
		"Sign in with your Google account for Gemini CLI access.",
		"The callback will be captured automatically on localhost:8085."
	].join("\n"), "Gemini CLI OAuth");
	const { verifier, challenge } = generatePkce();
	const authUrl = buildAuthUrl(challenge, verifier);
	if (needsManual) {
		ctx.progress.update("OAuth URL ready");
		ctx.log(`\nOpen this URL in your LOCAL browser:\n\n${authUrl}\n`);
		ctx.progress.update("Waiting for you to paste the callback URL...");
		const parsed = parseCallbackInput(await ctx.prompt("Paste the redirect URL here: "), verifier);
		if ("error" in parsed) throw new Error(parsed.error);
		if (parsed.state !== verifier) throw new Error("OAuth state mismatch - please try again");
		ctx.progress.update("Exchanging authorization code for tokens...");
		return exchangeCodeForTokens(parsed.code, verifier);
	}
	ctx.progress.update("Complete sign-in in browser...");
	try {
		await ctx.openUrl(authUrl);
	} catch {
		ctx.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
	}
	try {
		const { code } = await waitForLocalCallback({
			expectedState: verifier,
			timeoutMs: 300 * 1e3,
			onProgress: (msg) => ctx.progress.update(msg)
		});
		ctx.progress.update("Exchanging authorization code for tokens...");
		return await exchangeCodeForTokens(code, verifier);
	} catch (err) {
		if (err instanceof Error && (err.message.includes("EADDRINUSE") || err.message.includes("port") || err.message.includes("listen"))) {
			ctx.progress.update("Local callback server failed. Switching to manual mode...");
			ctx.log(`\nOpen this URL in your LOCAL browser:\n\n${authUrl}\n`);
			const parsed = parseCallbackInput(await ctx.prompt("Paste the redirect URL here: "), verifier);
			if ("error" in parsed) throw new Error(parsed.error, { cause: err });
			if (parsed.state !== verifier) throw new Error("OAuth state mismatch - please try again", { cause: err });
			ctx.progress.update("Exchanging authorization code for tokens...");
			return exchangeCodeForTokens(parsed.code, verifier);
		}
		throw err;
	}
}
//#endregion
//#region extensions/google/provider-models.ts
const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3-pro-preview"];
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview"];
function cloneFirstTemplateModel(params) {
	const trimmedModelId = params.modelId.trim();
	for (const templateId of [...new Set(params.templateIds)].filter(Boolean)) {
		const template = params.ctx.modelRegistry.find(params.providerId, templateId);
		if (!template) continue;
		return normalizeModelCompat({
			...template,
			id: trimmedModelId,
			name: trimmedModelId,
			reasoning: true
		});
	}
}
function resolveGoogle31ForwardCompatModel(params) {
	const trimmed = params.ctx.modelId.trim();
	const lower = trimmed.toLowerCase();
	let templateIds;
	if (lower.startsWith(GEMINI_3_1_PRO_PREFIX)) templateIds = GEMINI_3_1_PRO_TEMPLATE_IDS;
	else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX)) templateIds = GEMINI_3_1_FLASH_TEMPLATE_IDS;
	else return;
	return cloneFirstTemplateModel({
		providerId: params.providerId,
		modelId: trimmed,
		templateIds,
		ctx: params.ctx
	});
}
function isModernGoogleModel(modelId) {
	return modelId.trim().toLowerCase().startsWith("gemini-3");
}
//#endregion
//#region extensions/google/gemini-cli-provider.ts
const PROVIDER_ID = "google-gemini-cli";
const PROVIDER_LABEL = "Gemini CLI OAuth";
const DEFAULT_MODEL = "google-gemini-cli/gemini-3.1-pro-preview";
const ENV_VARS = [
	"OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
	"OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
	"GEMINI_CLI_OAUTH_CLIENT_ID",
	"GEMINI_CLI_OAUTH_CLIENT_SECRET"
];
function parseGoogleUsageToken(apiKey) {
	try {
		const parsed = JSON.parse(apiKey);
		if (typeof parsed?.token === "string") return parsed.token;
	} catch {}
	return apiKey;
}
function formatGoogleOauthApiKey(cred) {
	if (cred.type !== "oauth" || typeof cred.access !== "string" || !cred.access.trim()) return "";
	return JSON.stringify({
		token: cred.access,
		projectId: cred.projectId
	});
}
async function fetchGeminiCliUsage(ctx) {
	return await fetchGeminiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, PROVIDER_ID);
}
function registerGoogleGeminiCliProvider(api) {
	api.registerProvider({
		id: PROVIDER_ID,
		label: PROVIDER_LABEL,
		docsPath: "/providers/models",
		aliases: ["gemini-cli"],
		envVars: ENV_VARS,
		auth: [{
			id: "oauth",
			label: "Google OAuth",
			hint: "PKCE + localhost callback",
			kind: "oauth",
			run: async (ctx) => {
				await ctx.prompter.note([
					"This is an unofficial integration and is not endorsed by Google.",
					"Some users have reported account restrictions or suspensions after using third-party Gemini CLI and Antigravity OAuth clients.",
					"Proceed only if you understand and accept this risk."
				].join("\n"), "Google Gemini CLI caution");
				if (!await ctx.prompter.confirm({
					message: "Continue with Google Gemini CLI OAuth?",
					initialValue: false
				})) {
					await ctx.prompter.note("Skipped Google Gemini CLI OAuth setup.", "Setup skipped");
					return { profiles: [] };
				}
				const spin = ctx.prompter.progress("Starting Gemini CLI OAuth…");
				try {
					const result = await loginGeminiCliOAuth({
						isRemote: ctx.isRemote,
						openUrl: ctx.openUrl,
						log: (msg) => ctx.runtime.log(msg),
						note: ctx.prompter.note,
						prompt: async (message) => String(await ctx.prompter.text({ message })),
						progress: spin
					});
					spin.stop("Gemini CLI OAuth complete");
					return buildOauthProviderAuthResult({
						providerId: PROVIDER_ID,
						defaultModel: DEFAULT_MODEL,
						access: result.access,
						refresh: result.refresh,
						expires: result.expires,
						email: result.email,
						credentialExtra: { projectId: result.projectId },
						notes: ["If requests fail, set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID."]
					});
				} catch (err) {
					spin.stop("Gemini CLI OAuth failed");
					await ctx.prompter.note("Trouble with OAuth? Ensure your Google account has Gemini CLI access.", "OAuth help");
					throw err;
				}
			}
		}],
		wizard: { setup: {
			choiceId: "google-gemini-cli",
			choiceLabel: "Gemini CLI OAuth",
			choiceHint: "Google OAuth with project-aware token payload",
			methodId: "oauth"
		} },
		resolveDynamicModel: (ctx) => resolveGoogle31ForwardCompatModel({
			providerId: PROVIDER_ID,
			ctx
		}),
		isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
		formatApiKey: (cred) => formatGoogleOauthApiKey(cred),
		resolveUsageAuth: async (ctx) => {
			const auth = await ctx.resolveOAuthToken();
			if (!auth) return null;
			return {
				...auth,
				token: parseGoogleUsageToken(auth.token)
			};
		},
		fetchUsageSnapshot: async (ctx) => await fetchGeminiCliUsage(ctx)
	});
}
//#endregion
//#region extensions/google/index.ts
const googlePlugin = {
	id: "google",
	name: "Google Plugin",
	description: "Bundled Google plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: "google",
			label: "Google AI Studio",
			docsPath: "/providers/models",
			envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: "google",
				methodId: "api-key",
				label: "Google Gemini API key",
				hint: "AI Studio / Gemini API key",
				optionKey: "geminiApiKey",
				flagName: "--gemini-api-key",
				envVar: "GEMINI_API_KEY",
				promptMessage: "Enter Gemini API key",
				defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
				expectedProviders: ["google"],
				applyConfig: (cfg) => applyGoogleGeminiModelDefault(cfg).next,
				wizard: {
					choiceId: "gemini-api-key",
					choiceLabel: "Google Gemini API key",
					groupId: "google",
					groupLabel: "Google",
					groupHint: "Gemini API key + OAuth"
				}
			})],
			resolveDynamicModel: (ctx) => resolveGoogle31ForwardCompatModel({
				providerId: "google",
				ctx
			}),
			isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId)
		});
		registerGoogleGeminiCliProvider(api);
		api.registerWebSearchProvider(createPluginBackedWebSearchProvider({
			id: "gemini",
			label: "Gemini (Google Search)",
			hint: "Google Search grounding · AI-synthesized",
			envVars: ["GEMINI_API_KEY"],
			placeholder: "AIza...",
			signupUrl: "https://aistudio.google.com/apikey",
			docsUrl: "https://docs.openclaw.ai/tools/web",
			autoDetectOrder: 20,
			getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "gemini"),
			setCredentialValue: (searchConfigTarget, value) => setScopedCredentialValue(searchConfigTarget, "gemini", value)
		}));
	}
};
//#endregion
export { googlePlugin as default };
