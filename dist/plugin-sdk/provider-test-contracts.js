import { i as resolveAgentModelPrimaryValue, r as resolveAgentModelFallbackValues } from "../model-input-ChW9XXsQ.js";
import { t as createNonExitingRuntime } from "../runtime-yzlkhCoS.js";
import { t as clearRuntimeAuthProfileStoreSnapshots } from "../store-BMQkMM4l.js";
import { i as runProviderCatalog } from "../provider-discovery-CP1SEcge.js";
import { s as listSupportedMusicGenerationModes } from "../openclaw-tools-QeySpphx.js";
import { r as createCapturedPluginRegistration } from "../bundled-capability-runtime-DUjDEDJd.js";
import { a as resolveWebFetchProviderContractEntriesForPluginId, i as resolveProviderContractProvidersForPluginIds, n as providerContractLoadError, o as resolveWebSearchProviderContractEntriesForPluginId, s as resolveBundledExplicitProviderContractsFromPublicArtifacts, t as pluginRegistrationContractRegistry } from "../registry-BlbU2sIq.js";
import { i as resolveBundledExplicitWebSearchProvidersFromPublicArtifacts, r as resolveBundledExplicitWebFetchProvidersFromPublicArtifacts } from "../web-provider-public-artifacts.explicit-BwvGaIk_.js";
import { r as listSupportedVideoGenerationModes } from "../duration-support-0igMBB1p.js";
import "../provider-onboard-MLXAQX8H.js";
import "../runtime-DA0ehWyx.js";
import "../agent-runtime-Lc7H-PlR.js";
import { b as registerSingleProviderPlugin, v as registerProviderPlugin, x as requireRegisteredProvider, y as registerProviderPlugins } from "../plugin-setup-wizard-DsSNbhuh.js";
import { a as expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55, i as expectCodexMissingAuthHint, o as expectedOpenaiPluginCodexCatalogEntriesWithGpt55, r as expectAugmentedCodexCatalog } from "../testing-C7rXcZLa.js";
import { i as resolveProviderWizardOptions, n as resolveProviderModelPickerEntries, o as setProviderWizardProvidersResolverForTest, t as buildProviderPluginMethodChoice } from "../provider-wizard-CXwE9_rc.js";
import { r as resolveProviderPluginChoice } from "../provider-auth-choice.runtime-CHcmr6A-.js";
import { i as makeResponse, r as createProviderUsageFetch } from "../frozen-time-Cc9frCkh.js";
import { n as loadBundledPluginPublicSurfaceSync, t as loadBundledPluginPublicSurface } from "../public-surface-loader-B8tgO8c-.js";
import "../plugin-test-runtime-DRl7L9pX.js";
import "../test-env-CV5wTKy5.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
//#region src/plugin-sdk/test-helpers/provider-auth-contract.ts
const ensureAuthProfileStoreMock$1 = vi.hoisted(() => vi.fn());
const listProfilesForProviderMock$1 = vi.hoisted(() => vi.fn());
function buildPrompter() {
	const progress = {
		update() {},
		stop() {}
	};
	return {
		intro: async () => {},
		outro: async () => {},
		note: async () => {},
		select: async (params) => {
			const option = params.options[0];
			if (!option) throw new Error("missing select option");
			return option.value;
		},
		multiselect: async (params) => params.initialValues ?? [],
		text: async () => "",
		confirm: async () => false,
		progress: () => progress
	};
}
function buildAuthContext() {
	return {
		config: {},
		prompter: buildPrompter(),
		runtime: createNonExitingRuntime(),
		isRemote: false,
		openUrl: async () => {},
		oauth: { createVpsAwareHandlers: vi.fn() }
	};
}
function createJwt(payload) {
	return `${Buffer.from(JSON.stringify({
		alg: "none",
		typ: "JWT"
	})).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
function buildOpenAICodexOAuthResult(params) {
	return {
		profiles: [{
			profileId: params.profileId,
			credential: {
				type: "oauth",
				provider: "openai-codex",
				access: params.access,
				refresh: params.refresh,
				expires: params.expires,
				...params.email ? { email: params.email } : {}
			}
		}],
		configPatch: { agents: { defaults: { models: { "openai/gpt-5.5": {} } } } },
		defaultModel: "openai/gpt-5.5",
		notes: void 0
	};
}
function installSharedAuthProfileStoreHooks(state) {
	beforeEach(() => {
		vi.doMock("openclaw/plugin-sdk/provider-auth", async () => {
			return {
				...await vi.importActual("openclaw/plugin-sdk/provider-auth"),
				ensureAuthProfileStore: ensureAuthProfileStoreMock$1,
				listProfilesForProvider: listProfilesForProviderMock$1
			};
		});
		state.authStore = {
			version: 1,
			profiles: {}
		};
		ensureAuthProfileStoreMock$1.mockReset();
		ensureAuthProfileStoreMock$1.mockImplementation(() => state.authStore);
		listProfilesForProviderMock$1.mockReset();
		listProfilesForProviderMock$1.mockImplementation((store, providerId) => Object.entries(store.profiles).filter(([, credential]) => credential?.provider === providerId).map(([profileId]) => profileId));
	});
	afterEach(() => {
		ensureAuthProfileStoreMock$1.mockReset();
		listProfilesForProviderMock$1.mockReset();
		clearRuntimeAuthProfileStoreSnapshots();
	});
}
function describeOpenAICodexProviderAuthContract(load, options) {
	const state = { authStore: {
		version: 1,
		profiles: {}
	} };
	const { loginOpenAICodexOAuthMock } = options;
	describe("openai-codex provider auth contract", () => {
		installSharedAuthProfileStoreHooks(state);
		async function expectStableFallbackProfile(params) {
			const { default: openAIPlugin } = await load();
			const provider = requireRegisteredProvider(await registerProviderPlugins(openAIPlugin), "openai-codex");
			loginOpenAICodexOAuthMock.mockResolvedValueOnce({
				refresh: "refresh-token",
				access: params.access,
				expires: 17e11
			});
			expect(await provider.auth[0]?.run(buildAuthContext())).toEqual(buildOpenAICodexOAuthResult({
				profileId: params.profileId,
				access: params.access,
				refresh: "refresh-token",
				expires: 17e11
			}));
		}
		async function getProvider() {
			const { default: openAIPlugin } = await load();
			return requireRegisteredProvider(await registerProviderPlugins(openAIPlugin), "openai-codex");
		}
		it("keeps OAuth auth results provider-owned", async () => {
			const provider = await getProvider();
			loginOpenAICodexOAuthMock.mockResolvedValueOnce({
				email: "user@example.com",
				refresh: "refresh-token",
				access: "access-token",
				expires: 17e11
			});
			expect(await provider.auth[0]?.run(buildAuthContext())).toEqual(buildOpenAICodexOAuthResult({
				profileId: "openai-codex:user@example.com",
				access: "access-token",
				refresh: "refresh-token",
				expires: 17e11,
				email: "user@example.com"
			}));
		});
		it("backfills OAuth email from the JWT profile claim", async () => {
			const provider = await getProvider();
			const access = createJwt({ "https://api.openai.com/profile": { email: "jwt-user@example.com" } });
			loginOpenAICodexOAuthMock.mockResolvedValueOnce({
				refresh: "refresh-token",
				access,
				expires: 17e11
			});
			expect(await provider.auth[0]?.run(buildAuthContext())).toEqual(buildOpenAICodexOAuthResult({
				profileId: "openai-codex:jwt-user@example.com",
				access,
				refresh: "refresh-token",
				expires: 17e11,
				email: "jwt-user@example.com"
			}));
		});
		it("uses a stable fallback id when JWT email is missing", async () => {
			await expectStableFallbackProfile({
				access: createJwt({ "https://api.openai.com/auth": { chatgpt_account_user_id: "user-123__acct-456" } }),
				profileId: `openai-codex:id-${Buffer.from("user-123__acct-456", "utf8").toString("base64url")}`
			});
		});
		it("uses iss and sub to build a stable fallback id when auth claims are missing", async () => {
			await expectStableFallbackProfile({
				access: createJwt({
					iss: "https://accounts.openai.com",
					sub: "user-abc"
				}),
				profileId: `openai-codex:id-${Buffer.from("https://accounts.openai.com|user-abc").toString("base64url")}`
			});
		});
		it("uses sub alone to build a stable fallback id when iss is missing", async () => {
			await expectStableFallbackProfile({
				access: createJwt({ sub: "user-abc" }),
				profileId: `openai-codex:id-${Buffer.from("user-abc").toString("base64url")}`
			});
		});
		it("falls back to the default profile when JWT parsing yields no identity", async () => {
			const provider = await getProvider();
			loginOpenAICodexOAuthMock.mockResolvedValueOnce({
				refresh: "refresh-token",
				access: "not-a-jwt-token",
				expires: 17e11
			});
			expect(await provider.auth[0]?.run(buildAuthContext())).toEqual(buildOpenAICodexOAuthResult({
				profileId: "openai-codex:default",
				access: "not-a-jwt-token",
				refresh: "refresh-token",
				expires: 17e11
			}));
		});
		it("surfaces OAuth failures instead of silently succeeding with no profiles", async () => {
			const provider = await getProvider();
			loginOpenAICodexOAuthMock.mockRejectedValueOnce(/* @__PURE__ */ new Error("oauth failed"));
			await expect(provider.auth[0]?.run(buildAuthContext())).rejects.toThrow("oauth failed");
		});
	});
}
function describeGithubCopilotProviderAuthContract(load) {
	const state = { authStore: {
		version: 1,
		profiles: {}
	} };
	describe("github-copilot provider auth contract", () => {
		installSharedAuthProfileStoreHooks(state);
		async function getProvider() {
			const { default: githubCopilotPlugin } = await load();
			return requireRegisteredProvider(await registerProviderPlugins(githubCopilotPlugin), "github-copilot");
		}
		it("keeps existing device auth results provider-owned", async () => {
			const provider = await getProvider();
			state.authStore.profiles["github-copilot:github"] = {
				type: "token",
				provider: "github-copilot",
				token: "github-device-token"
			};
			const stdin = process.stdin;
			const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
			const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
			Object.defineProperty(stdin, "isTTY", {
				configurable: true,
				enumerable: true,
				get: () => true
			});
			try {
				expect(await provider.auth[0]?.run(buildAuthContext())).toEqual({
					profiles: [{
						profileId: "github-copilot:github",
						credential: {
							type: "token",
							provider: "github-copilot",
							token: "github-device-token"
						}
					}],
					defaultModel: "github-copilot/claude-opus-4.7"
				});
			} finally {
				if (previousIsTTYDescriptor) Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
				else if (!hadOwnIsTTY) delete stdin.isTTY;
			}
		});
		function stubGitHubDeviceFlowFetch(outcome) {
			const fetchMock = vi.fn(async (input) => {
				const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input);
				if (target === "https://github.com/login/device/code") return new Response(JSON.stringify({
					device_code: "device-code-stub",
					user_code: "ABCD-1234",
					verification_uri: "https://github.com/login/device",
					expires_in: 900,
					interval: 0
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" }
				});
				if (target === "https://github.com/login/oauth/access_token") {
					const body = "accessToken" in outcome ? {
						access_token: outcome.accessToken,
						token_type: "bearer"
					} : { error: outcome.error };
					return new Response(JSON.stringify(body), {
						status: 200,
						headers: { "Content-Type": "application/json" }
					});
				}
				throw new Error(`unexpected fetch in github-copilot device flow stub: ${target}`);
			});
			vi.stubGlobal("fetch", fetchMock);
			return fetchMock;
		}
		function buildSpyAuthContext() {
			const ctx = buildAuthContext();
			ctx.openUrl = vi.fn(async () => {});
			ctx.prompter.note = vi.fn(async () => {});
			return ctx;
		}
		afterEach(() => {
			vi.unstubAllGlobals();
		});
		it("keeps device auth results provider-owned", async () => {
			const provider = await getProvider();
			stubGitHubDeviceFlowFetch({ accessToken: "github-device-token" });
			const ctx = buildSpyAuthContext();
			expect(await provider.auth[0]?.run(ctx)).toEqual({
				profiles: [{
					profileId: "github-copilot:github",
					credential: {
						type: "token",
						provider: "github-copilot",
						token: "github-device-token"
					}
				}],
				defaultModel: "github-copilot/claude-opus-4.7"
			});
		});
		it("uses the wizard prompter and openUrl hooks for the device code (no stdin/stdout)", async () => {
			const provider = await getProvider();
			stubGitHubDeviceFlowFetch({ accessToken: "github-device-token" });
			const ctx = buildSpyAuthContext();
			await provider.auth[0]?.run(ctx);
			expect(ctx.openUrl).toHaveBeenCalledWith("https://github.com/login/device");
			const codeNote = ctx.prompter.note.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("ABCD-1234"));
			expect(codeNote).toBeDefined();
			expect(codeNote?.[0]).toContain("https://github.com/login/device");
		});
		it("supports non-interactive (GUI/RPC) auth contexts without a TTY", async () => {
			const provider = await getProvider();
			const stdin = process.stdin;
			const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
			const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
			Object.defineProperty(stdin, "isTTY", {
				configurable: true,
				enumerable: true,
				get: () => false
			});
			stubGitHubDeviceFlowFetch({ accessToken: "rpc-client-token" });
			const ctx = buildSpyAuthContext();
			try {
				expect((await provider.auth[0]?.run(ctx))?.profiles).toEqual([{
					profileId: "github-copilot:github",
					credential: {
						type: "token",
						provider: "github-copilot",
						token: "rpc-client-token"
					}
				}]);
			} finally {
				if (previousIsTTYDescriptor) Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
				else if (!hadOwnIsTTY) delete stdin.isTTY;
			}
		});
		it("returns no profiles and notes cancellation when the user denies access", async () => {
			const provider = await getProvider();
			stubGitHubDeviceFlowFetch({ error: "access_denied" });
			const ctx = buildSpyAuthContext();
			expect(await provider.auth[0]?.run(ctx)).toEqual({ profiles: [] });
			const noteCalls = ctx.prompter.note.mock.calls;
			expect(noteCalls.some(([msg]) => typeof msg === "string" && msg.toLowerCase().includes("cancel"))).toBe(true);
		});
		it("returns no profiles and notes expiry when the device code expires", async () => {
			const provider = await getProvider();
			stubGitHubDeviceFlowFetch({ error: "expired_token" });
			const ctx = buildSpyAuthContext();
			expect(await provider.auth[0]?.run(ctx)).toEqual({ profiles: [] });
			const noteCalls = ctx.prompter.note.mock.calls;
			expect(noteCalls.some(([msg]) => typeof msg === "string" && msg.toLowerCase().includes("expired"))).toBe(true);
		});
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/provider-catalog.ts
async function importProviderRuntimeCatalogModule() {
	const { augmentModelCatalogWithProviderPlugins } = await import("./provider-catalog-runtime.js");
	return { augmentModelCatalogWithProviderPlugins };
}
//#endregion
//#region src/plugin-sdk/test-helpers/provider-contract-suites.ts
function resolveLazy(value) {
	return typeof value === "function" ? value() : value;
}
function expectWebProviderCredentialContract(provider, credentialValue) {
	expect(provider.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
	expect(provider.label.trim()).not.toBe("");
	expect(provider.hint.trim()).not.toBe("");
	expect(provider.placeholder.trim()).not.toBe("");
	expect(provider.signupUrl.startsWith("https://")).toBe(true);
	if (provider.docsUrl) expect(provider.docsUrl.startsWith("http")).toBe(true);
	expect(provider.envVars).toEqual([...new Set(provider.envVars)]);
	expect(provider.envVars.every((entry) => entry.trim().length > 0)).toBe(true);
	const configTarget = {};
	provider.setCredentialValue(configTarget, credentialValue);
	expect(provider.getCredentialValue(configTarget)).toEqual(credentialValue);
	expect(typeof provider.createTool).toBe("function");
	return configTarget;
}
function installProviderPluginContractSuite(params) {
	it("satisfies the base provider plugin contract", () => {
		const provider = resolveLazy(params.provider);
		const authIds = provider.auth.map((method) => method.id);
		const wizardChoiceIds = /* @__PURE__ */ new Set();
		expect(provider.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
		expect(provider.label.trim()).not.toBe("");
		if (provider.docsPath) expect(provider.docsPath.startsWith("/")).toBe(true);
		if (provider.aliases) expect(provider.aliases).toEqual([...new Set(provider.aliases)]);
		if (provider.envVars) {
			expect(provider.envVars).toEqual([...new Set(provider.envVars)]);
			expect(provider.envVars.every((entry) => entry.trim().length > 0)).toBe(true);
		}
		expect(Array.isArray(provider.auth)).toBe(true);
		expect(authIds).toEqual([...new Set(authIds)]);
		for (const method of provider.auth) {
			expect(method.id.trim()).not.toBe("");
			expect(method.label.trim()).not.toBe("");
			if (method.hint !== void 0) expect(method.hint.trim()).not.toBe("");
			if (method.wizard) {
				if (method.wizard.choiceId) {
					expect(method.wizard.choiceId.trim()).not.toBe("");
					expect(wizardChoiceIds.has(method.wizard.choiceId)).toBe(false);
					wizardChoiceIds.add(method.wizard.choiceId);
				}
				if (method.wizard.methodId) expect(authIds).toContain(method.wizard.methodId);
				if (method.wizard.modelAllowlist?.allowedKeys) expect(method.wizard.modelAllowlist.allowedKeys).toEqual([...new Set(method.wizard.modelAllowlist.allowedKeys)]);
				if (method.wizard.modelAllowlist?.initialSelections) expect(method.wizard.modelAllowlist.initialSelections).toEqual([...new Set(method.wizard.modelAllowlist.initialSelections)]);
			}
			expect(typeof method.run).toBe("function");
		}
		if (provider.wizard?.setup || provider.wizard?.modelPicker) expect(provider.auth.length).toBeGreaterThan(0);
		if (provider.wizard?.setup) {
			if (provider.wizard.setup.choiceId) {
				expect(provider.wizard.setup.choiceId.trim()).not.toBe("");
				expect(wizardChoiceIds.has(provider.wizard.setup.choiceId)).toBe(false);
			}
			if (provider.wizard.setup.methodId) expect(authIds).toContain(provider.wizard.setup.methodId);
			if (provider.wizard.setup.modelAllowlist?.allowedKeys) expect(provider.wizard.setup.modelAllowlist.allowedKeys).toEqual([...new Set(provider.wizard.setup.modelAllowlist.allowedKeys)]);
			if (provider.wizard.setup.modelAllowlist?.initialSelections) expect(provider.wizard.setup.modelAllowlist.initialSelections).toEqual([...new Set(provider.wizard.setup.modelAllowlist.initialSelections)]);
		}
		if (provider.wizard?.modelPicker?.methodId) expect(authIds).toContain(provider.wizard.modelPicker.methodId);
	});
}
function installWebSearchProviderContractSuite(params) {
	it("satisfies the base web search provider contract", () => {
		const provider = resolveLazy(params.provider);
		const credentialValue = resolveLazy(params.credentialValue);
		const searchConfigTarget = expectWebProviderCredentialContract(provider, credentialValue);
		expect(provider.getCredentialValue(searchConfigTarget)).toEqual(credentialValue);
		if (provider.runSetup) expect(typeof provider.runSetup).toBe("function");
	});
}
function installWebFetchProviderContractSuite(params) {
	it("satisfies the base web fetch provider contract", () => {
		const provider = resolveLazy(params.provider);
		const credentialValue = resolveLazy(params.credentialValue);
		expectWebProviderCredentialContract(provider, credentialValue);
		expect(provider.credentialPath.trim()).not.toBe("");
		if (provider.inactiveSecretPaths) {
			expect(provider.inactiveSecretPaths).toEqual([...new Set(provider.inactiveSecretPaths)]);
			expect(provider.inactiveSecretPaths).toContain(provider.credentialPath);
		}
		const fetchConfigTarget = {};
		provider.setCredentialValue(fetchConfigTarget, credentialValue);
		expect(provider.getCredentialValue(fetchConfigTarget)).toEqual(credentialValue);
		if (provider.setConfiguredCredentialValue && provider.getConfiguredCredentialValue) {
			const configTarget = {};
			provider.setConfiguredCredentialValue(configTarget, credentialValue);
			expect(provider.getConfiguredCredentialValue(configTarget)).toEqual(credentialValue);
		}
		if (provider.applySelectionConfig && params.pluginId) expect(provider.applySelectionConfig({}).plugins?.entries?.[params.pluginId]?.enabled).toBe(true);
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/provider-contract.ts
function providerMatchesManifestId(provider, providerId) {
	return provider.id === providerId || (provider.aliases ?? []).includes(providerId) || (provider.hookAliases ?? []).includes(providerId);
}
function resolveProviderContractProvidersFromPublicArtifact(pluginId) {
	return resolveBundledExplicitProviderContractsFromPublicArtifacts({ onlyPluginIds: [pluginId] });
}
function describeProviderContracts(pluginId) {
	let providerEntries;
	const resolveProviderEntries = () => {
		if (providerEntries) return providerEntries;
		const publicArtifactProviders = resolveProviderContractProvidersFromPublicArtifact(pluginId);
		if (publicArtifactProviders) {
			providerEntries = publicArtifactProviders;
			return providerEntries;
		}
		providerEntries = resolveProviderContractProvidersForPluginIds([pluginId]).map((provider) => ({
			pluginId,
			provider
		}));
		return providerEntries;
	};
	const resolveProviderIds = () => resolveProviderEntries().map((entry) => entry.provider.id);
	describe(`${pluginId} provider contract registry load`, () => {
		it("loads bundled providers without import-time registry failure", () => {
			const providers = resolveProviderEntries();
			expect(providerContractLoadError).toBeUndefined();
			expect(providers.length).toBeGreaterThan(0);
		});
	});
	for (const providerId of resolveProviderIds()) describe(`${pluginId}:${providerId} provider contract`, () => {
		installProviderPluginContractSuite({ provider: () => {
			const entry = resolveProviderEntries().find((entry) => providerMatchesManifestId(entry.provider, providerId));
			if (!entry) throw new Error(`provider contract entry missing for ${pluginId}:${providerId}`);
			return entry.provider;
		} });
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/provider-discovery-contract.ts
const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());
const buildVllmProviderMock = vi.hoisted(() => vi.fn());
const buildSglangProviderMock = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn());
function setRuntimeAuthStore(store) {
	const resolvedStore = store ?? {
		version: 1,
		profiles: {}
	};
	ensureAuthProfileStoreMock.mockReturnValue(resolvedStore);
	listProfilesForProviderMock.mockImplementation((authStore, providerId) => Object.entries(authStore.profiles).filter(([, credential]) => credential.provider === providerId).map(([profileId]) => profileId));
}
function setGithubCopilotProfileSnapshot() {
	setRuntimeAuthStore({
		version: 1,
		profiles: { "github-copilot:github": {
			type: "token",
			provider: "github-copilot",
			token: "profile-token"
		} }
	});
}
function runCatalog(state, params) {
	return state.runProviderCatalog({
		provider: params.provider,
		config: params.config ?? {},
		env: params.env ?? {},
		resolveProviderApiKey: params.resolveProviderApiKey ?? (() => ({ apiKey: void 0 })),
		resolveProviderAuth: params.resolveProviderAuth ?? ((_, options) => ({
			apiKey: options?.oauthMarker,
			discoveryApiKey: void 0,
			mode: options?.oauthMarker ? "oauth" : "none",
			source: options?.oauthMarker ? "profile" : "none"
		}))
	});
}
function requireRecord$1(value, label) {
	expect(value, label).toBeTypeOf("object");
	expect(value, label).not.toBeNull();
	return value;
}
function expectProviderFields(result, fields) {
	const provider = requireRecord$1(requireRecord$1(result, "catalog result").provider, "provider");
	for (const [key, expected] of Object.entries(fields)) expect(provider[key]).toEqual(expected);
	return provider;
}
function providerModelIds(provider) {
	const models = provider.models;
	expect(Array.isArray(models), "provider models").toBe(true);
	return models.map((model) => model.id);
}
function installDiscoveryHooks(state, options) {
	beforeAll(async () => {
		vi.resetModules();
		vi.doMock("openclaw/plugin-sdk/agent-runtime", () => {
			return {
				ensureAuthProfileStore: ensureAuthProfileStoreMock,
				listProfilesForProvider: listProfilesForProviderMock
			};
		});
		vi.doMock("openclaw/plugin-sdk/provider-auth", () => {
			return {
				DEFAULT_COPILOT_API_BASE_URL: "https://api.individual.githubcopilot.com",
				MINIMAX_OAUTH_MARKER: "minimax-oauth",
				applyAuthProfileConfig: (config) => config,
				buildApiKeyCredential: (provider, key, metadata) => ({
					type: "api_key",
					provider,
					...typeof key === "string" ? { key } : {},
					...metadata ? { metadata } : {}
				}),
				buildOauthProviderAuthResult: vi.fn(),
				buildCopilotIdeHeaders: vi.fn(() => ({
					"Editor-Version": "vscode/1.96.2",
					"User-Agent": "GitHubCopilotChat/0.26.7"
				})),
				coerceSecretRef: (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null,
				ensureApiKeyFromOptionEnvOrPrompt: vi.fn(),
				ensureAuthProfileStore: ensureAuthProfileStoreMock,
				listProfilesForProvider: listProfilesForProviderMock,
				normalizeApiKeyInput: (value) => typeof value === "string" ? value.trim() : "",
				normalizeOptionalSecretInput: (value) => typeof value === "string" && value.trim() ? value.trim() : void 0,
				resolveNonEnvSecretRefApiKeyMarker: (source) => typeof source === "string" ? source : "",
				upsertAuthProfile: vi.fn(),
				validateApiKeyInput: () => void 0
			};
		});
		if (options.githubCopilotRegisterRuntimeModuleId) vi.doMock(options.githubCopilotRegisterRuntimeModuleId, async () => {
			return {
				...await vi.importActual(options.githubCopilotRegisterRuntimeModuleId),
				resolveCopilotApiToken: resolveCopilotApiTokenMock
			};
		});
		if (options.vllmApiModuleId) vi.doMock(options.vllmApiModuleId, async () => {
			return {
				VLLM_DEFAULT_API_KEY_ENV_VAR: "VLLM_API_KEY",
				VLLM_DEFAULT_BASE_URL: "http://127.0.0.1:8000/v1",
				VLLM_MODEL_PLACEHOLDER: "meta-llama/Meta-Llama-3-8B-Instruct",
				VLLM_PROVIDER_LABEL: "vLLM",
				buildVllmProvider: (...args) => buildVllmProviderMock(...args)
			};
		});
		if (options.sglangApiModuleId) vi.doMock(options.sglangApiModuleId, async () => {
			return {
				SGLANG_DEFAULT_API_KEY_ENV_VAR: "SGLANG_API_KEY",
				SGLANG_DEFAULT_BASE_URL: "http://127.0.0.1:30000/v1",
				SGLANG_MODEL_PLACEHOLDER: "Qwen/Qwen3-8B",
				SGLANG_PROVIDER_LABEL: "SGLang",
				buildSglangProvider: (...args) => buildSglangProviderMock(...args)
			};
		});
		state.runProviderCatalog = runProviderCatalog;
		if (options.providerIds.includes("github-copilot")) {
			const { default: githubCopilotPlugin } = await options.loadGithubCopilot();
			state.githubCopilotProvider = requireRegisteredProvider(await registerProviderPlugins(githubCopilotPlugin), "github-copilot");
		}
		if (options.providerIds.includes("vllm")) {
			const { default: vllmPlugin } = await options.loadVllm();
			state.vllmProvider = requireRegisteredProvider(await registerProviderPlugins(vllmPlugin), "vllm");
		}
		if (options.providerIds.includes("sglang")) {
			const { default: sglangPlugin } = await options.loadSglang();
			state.sglangProvider = requireRegisteredProvider(await registerProviderPlugins(sglangPlugin), "sglang");
		}
		if (options.providerIds.includes("minimax")) {
			const { default: minimaxPlugin } = await options.loadMinimax();
			const registeredProviders = await registerProviderPlugins(minimaxPlugin);
			state.minimaxProvider = requireRegisteredProvider(registeredProviders, "minimax");
			state.minimaxPortalProvider = requireRegisteredProvider(registeredProviders, "minimax-portal");
		}
		if (options.providerIds.includes("modelstudio")) {
			const { default: qwenPlugin } = await options.loadModelStudio();
			state.modelStudioProvider = requireRegisteredProvider(await registerProviderPlugins(qwenPlugin), "qwen");
		}
		if (options.providerIds.includes("cloudflare-ai-gateway")) {
			const { default: cloudflareAiGatewayPlugin } = await options.loadCloudflareAiGateway();
			state.cloudflareAiGatewayProvider = requireRegisteredProvider(await registerProviderPlugins(cloudflareAiGatewayPlugin), "cloudflare-ai-gateway");
		}
	});
	beforeEach(() => {
		setRuntimeAuthStore();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		resolveCopilotApiTokenMock.mockReset();
		buildVllmProviderMock.mockReset();
		buildSglangProviderMock.mockReset();
		ensureAuthProfileStoreMock.mockReset();
		listProfilesForProviderMock.mockReset();
		setRuntimeAuthStore();
	});
}
function describeGithubCopilotProviderDiscoveryContract(params) {
	const state = {};
	describe("github-copilot provider discovery contract", () => {
		installDiscoveryHooks(state, {
			providerIds: ["github-copilot"],
			loadGithubCopilot: params.load,
			githubCopilotRegisterRuntimeModuleId: params.registerRuntimeModuleId
		});
		it("keeps catalog disabled without env tokens or profiles", async () => {
			await expect(runCatalog(state, { provider: state.githubCopilotProvider })).resolves.toBeNull();
		});
		it("keeps profile-only catalog fallback provider-owned", async () => {
			setGithubCopilotProfileSnapshot();
			await expect(runCatalog(state, { provider: state.githubCopilotProvider })).resolves.toEqual({ provider: {
				baseUrl: "https://api.individual.githubcopilot.com",
				models: []
			} });
		});
		it("keeps env-token base URL resolution provider-owned", async () => {
			resolveCopilotApiTokenMock.mockResolvedValueOnce({
				token: "copilot-api-token",
				baseUrl: "https://copilot-proxy.example.com",
				expiresAt: Date.now() + 6e4
			});
			await expect(runCatalog(state, {
				provider: state.githubCopilotProvider,
				env: { GITHUB_TOKEN: "github-env-token" },
				resolveProviderApiKey: () => ({ apiKey: void 0 })
			})).resolves.toEqual({ provider: {
				baseUrl: "https://copilot-proxy.example.com",
				models: []
			} });
			const copilotCall = requireRecord$1(resolveCopilotApiTokenMock.mock.calls.at(0)?.[0], "copilot token params");
			expect(copilotCall.githubToken).toBe("github-env-token");
			expect(requireRecord$1(copilotCall.env, "copilot token env").GITHUB_TOKEN).toBe("github-env-token");
		});
	});
}
function describeVllmProviderDiscoveryContract(params) {
	const state = {};
	describe("vllm provider discovery contract", () => {
		installDiscoveryHooks(state, {
			providerIds: ["vllm"],
			loadVllm: params.load,
			vllmApiModuleId: params.apiModuleId
		});
		it("keeps self-hosted discovery provider-owned", async () => {
			buildVllmProviderMock.mockResolvedValueOnce({
				baseUrl: "http://127.0.0.1:8000/v1",
				api: "openai-completions",
				models: [{
					id: "meta-llama/Meta-Llama-3-8B-Instruct",
					name: "Meta Llama 3"
				}]
			});
			await expect(runCatalog(state, {
				provider: state.vllmProvider,
				config: {},
				env: { VLLM_API_KEY: "env-vllm-key" },
				resolveProviderApiKey: () => ({
					apiKey: "VLLM_API_KEY",
					discoveryApiKey: "env-vllm-key"
				}),
				resolveProviderAuth: () => ({
					apiKey: "VLLM_API_KEY",
					discoveryApiKey: "env-vllm-key",
					mode: "api_key",
					source: "env"
				})
			})).resolves.toEqual({ provider: {
				baseUrl: "http://127.0.0.1:8000/v1",
				api: "openai-completions",
				apiKey: "VLLM_API_KEY",
				models: [{
					id: "meta-llama/Meta-Llama-3-8B-Instruct",
					name: "Meta Llama 3"
				}]
			} });
			expect(buildVllmProviderMock).toHaveBeenCalledWith({ apiKey: "env-vllm-key" });
		});
		it("uses configured transport only for provider wildcard discovery", async () => {
			buildVllmProviderMock.mockResolvedValueOnce({
				baseUrl: "http://vllm-router.example/v1",
				api: "openai-completions",
				models: [{
					id: "router-model",
					name: "Router Model"
				}]
			});
			await expect(runCatalog(state, {
				provider: state.vllmProvider,
				config: {
					agents: { defaults: { models: { "vllm/*": {} } } },
					models: { providers: { vllm: {
						baseUrl: "http://vllm-router.example/v1",
						apiKey: "VLLM_API_KEY",
						api: "openai-completions",
						models: []
					} } }
				},
				env: { VLLM_API_KEY: "env-vllm-key" },
				resolveProviderApiKey: () => ({
					apiKey: "VLLM_API_KEY",
					discoveryApiKey: "env-vllm-key"
				}),
				resolveProviderAuth: () => ({
					apiKey: "VLLM_API_KEY",
					discoveryApiKey: "env-vllm-key",
					mode: "api_key",
					source: "env"
				})
			})).resolves.toEqual({ provider: {
				baseUrl: "http://vllm-router.example/v1",
				api: "openai-completions",
				apiKey: "VLLM_API_KEY",
				models: [{
					id: "router-model",
					name: "Router Model"
				}]
			} });
			expect(buildVllmProviderMock).toHaveBeenCalledWith({
				apiKey: "env-vllm-key",
				baseUrl: "http://vllm-router.example/v1"
			});
		});
		it("uses the provider default transport when wildcard config omits baseUrl", async () => {
			buildVllmProviderMock.mockResolvedValueOnce({
				baseUrl: "http://127.0.0.1:8000/v1",
				api: "openai-completions",
				models: [{
					id: "default-transport-model",
					name: "Default Transport Model"
				}]
			});
			await expect(runCatalog(state, {
				provider: state.vllmProvider,
				config: {
					agents: { defaults: { models: { "vllm/*": {} } } },
					models: { providers: { vllm: {
						apiKey: "VLLM_API_KEY",
						api: "openai-completions",
						models: []
					} } }
				},
				env: { VLLM_API_KEY: "env-vllm-key" },
				resolveProviderApiKey: () => ({
					apiKey: "VLLM_API_KEY",
					discoveryApiKey: "env-vllm-key"
				}),
				resolveProviderAuth: () => ({
					apiKey: "VLLM_API_KEY",
					discoveryApiKey: "env-vllm-key",
					mode: "api_key",
					source: "env"
				})
			})).resolves.toEqual({ provider: {
				baseUrl: "http://127.0.0.1:8000/v1",
				api: "openai-completions",
				apiKey: "VLLM_API_KEY",
				models: [{
					id: "default-transport-model",
					name: "Default Transport Model"
				}]
			} });
			expect(buildVllmProviderMock).toHaveBeenCalledWith({ apiKey: "env-vllm-key" });
		});
		it("keeps explicit self-hosted provider config manual without wildcard visibility", async () => {
			await expect(runCatalog(state, {
				provider: state.vllmProvider,
				config: {
					agents: { defaults: { models: { "vllm/manual-model": {} } } },
					models: { providers: { vllm: {
						baseUrl: "http://vllm-router.example/v1",
						apiKey: "VLLM_API_KEY",
						api: "openai-completions",
						models: []
					} } }
				},
				env: { VLLM_API_KEY: "env-vllm-key" },
				resolveProviderApiKey: () => ({
					apiKey: "VLLM_API_KEY",
					discoveryApiKey: "env-vllm-key"
				}),
				resolveProviderAuth: () => ({
					apiKey: "VLLM_API_KEY",
					discoveryApiKey: "env-vllm-key",
					mode: "api_key",
					source: "env"
				})
			})).resolves.toBeNull();
			expect(buildVllmProviderMock).not.toHaveBeenCalled();
		});
	});
}
function describeSglangProviderDiscoveryContract(params) {
	const state = {};
	describe("sglang provider discovery contract", () => {
		installDiscoveryHooks(state, {
			providerIds: ["sglang"],
			loadSglang: params.load,
			sglangApiModuleId: params.apiModuleId
		});
		it("keeps self-hosted discovery provider-owned", async () => {
			buildSglangProviderMock.mockResolvedValueOnce({
				baseUrl: "http://127.0.0.1:30000/v1",
				api: "openai-completions",
				models: [{
					id: "Qwen/Qwen3-8B",
					name: "Qwen3-8B"
				}]
			});
			await expect(runCatalog(state, {
				provider: state.sglangProvider,
				config: {},
				env: { SGLANG_API_KEY: "env-sglang-key" },
				resolveProviderApiKey: () => ({
					apiKey: "SGLANG_API_KEY",
					discoveryApiKey: "env-sglang-key"
				}),
				resolveProviderAuth: () => ({
					apiKey: "SGLANG_API_KEY",
					discoveryApiKey: "env-sglang-key",
					mode: "api_key",
					source: "env"
				})
			})).resolves.toEqual({ provider: {
				baseUrl: "http://127.0.0.1:30000/v1",
				api: "openai-completions",
				apiKey: "SGLANG_API_KEY",
				models: [{
					id: "Qwen/Qwen3-8B",
					name: "Qwen3-8B"
				}]
			} });
			expect(buildSglangProviderMock).toHaveBeenCalledWith({ apiKey: "env-sglang-key" });
		});
		it("uses configured transport only for provider wildcard discovery", async () => {
			buildSglangProviderMock.mockResolvedValueOnce({
				baseUrl: "http://sglang-router.example/v1",
				api: "openai-completions",
				models: [{
					id: "Qwen/Qwen3-32B",
					name: "Qwen3-32B"
				}]
			});
			await expect(runCatalog(state, {
				provider: state.sglangProvider,
				config: {
					agents: { defaults: { models: { "sglang/*": {} } } },
					models: { providers: { sglang: {
						baseUrl: "http://sglang-router.example/v1",
						apiKey: "SGLANG_API_KEY",
						api: "openai-completions",
						models: []
					} } }
				},
				env: { SGLANG_API_KEY: "env-sglang-key" },
				resolveProviderApiKey: () => ({
					apiKey: "SGLANG_API_KEY",
					discoveryApiKey: "env-sglang-key"
				}),
				resolveProviderAuth: () => ({
					apiKey: "SGLANG_API_KEY",
					discoveryApiKey: "env-sglang-key",
					mode: "api_key",
					source: "env"
				})
			})).resolves.toEqual({ provider: {
				baseUrl: "http://sglang-router.example/v1",
				api: "openai-completions",
				apiKey: "SGLANG_API_KEY",
				models: [{
					id: "Qwen/Qwen3-32B",
					name: "Qwen3-32B"
				}]
			} });
			expect(buildSglangProviderMock).toHaveBeenCalledWith({
				apiKey: "env-sglang-key",
				baseUrl: "http://sglang-router.example/v1"
			});
		});
		it("keeps explicit self-hosted provider config manual without wildcard visibility", async () => {
			await expect(runCatalog(state, {
				provider: state.sglangProvider,
				config: {
					agents: { defaults: { models: { "sglang/Qwen/Qwen3-32B": {} } } },
					models: { providers: { sglang: {
						baseUrl: "http://sglang-router.example/v1",
						apiKey: "SGLANG_API_KEY",
						api: "openai-completions",
						models: []
					} } }
				},
				env: { SGLANG_API_KEY: "env-sglang-key" },
				resolveProviderApiKey: () => ({
					apiKey: "SGLANG_API_KEY",
					discoveryApiKey: "env-sglang-key"
				}),
				resolveProviderAuth: () => ({
					apiKey: "SGLANG_API_KEY",
					discoveryApiKey: "env-sglang-key",
					mode: "api_key",
					source: "env"
				})
			})).resolves.toBeNull();
			expect(buildSglangProviderMock).not.toHaveBeenCalled();
		});
	});
}
function describeMinimaxProviderDiscoveryContract(load) {
	const state = {};
	describe("minimax provider discovery contract", () => {
		installDiscoveryHooks(state, {
			providerIds: ["minimax"],
			loadMinimax: load
		});
		it("keeps API catalog provider-owned", async () => {
			const ids = providerModelIds(expectProviderFields(await state.runProviderCatalog({
				provider: state.minimaxProvider,
				config: {},
				env: { MINIMAX_API_KEY: "minimax-key" },
				resolveProviderApiKey: () => ({ apiKey: "minimax-key" }),
				resolveProviderAuth: () => ({
					apiKey: "minimax-key",
					discoveryApiKey: void 0,
					mode: "api_key",
					source: "env"
				})
			}), {
				baseUrl: "https://api.minimax.io/anthropic",
				api: "anthropic-messages",
				authHeader: true,
				apiKey: "minimax-key"
			}));
			expect(ids).toContain("MiniMax-M2.7");
			expect(ids).toContain("MiniMax-M2.7-highspeed");
		});
		it("keeps portal oauth marker fallback provider-owned", async () => {
			setRuntimeAuthStore({
				version: 1,
				profiles: { "minimax-portal:default": {
					type: "oauth",
					provider: "minimax-portal",
					access: "access-token",
					refresh: "refresh-token",
					expires: Date.now() + 6e4
				} }
			});
			expect(providerModelIds(expectProviderFields(await runCatalog(state, {
				provider: state.minimaxPortalProvider,
				config: {},
				env: {},
				resolveProviderApiKey: () => ({ apiKey: void 0 }),
				resolveProviderAuth: () => ({
					apiKey: "minimax-oauth",
					discoveryApiKey: "access-token",
					mode: "oauth",
					source: "profile",
					profileId: "minimax-portal:default"
				})
			}), {
				baseUrl: "https://api.minimax.io/anthropic",
				api: "anthropic-messages",
				authHeader: true,
				apiKey: "minimax-oauth"
			}))).toContain("MiniMax-M2.7");
		});
		it("keeps portal explicit base URL override provider-owned", async () => {
			expectProviderFields(await state.runProviderCatalog({
				provider: state.minimaxPortalProvider,
				config: { models: { providers: { "minimax-portal": {
					baseUrl: "https://portal-proxy.example.com/anthropic",
					apiKey: "explicit-key",
					models: []
				} } } },
				env: {},
				resolveProviderApiKey: () => ({ apiKey: void 0 }),
				resolveProviderAuth: () => ({
					apiKey: void 0,
					discoveryApiKey: void 0,
					mode: "none",
					source: "none"
				})
			}), {
				baseUrl: "https://portal-proxy.example.com/anthropic",
				apiKey: "explicit-key"
			});
		});
	});
}
function describeModelStudioProviderDiscoveryContract(load) {
	const state = {};
	describe("modelstudio provider discovery contract", () => {
		installDiscoveryHooks(state, {
			providerIds: ["modelstudio"],
			loadModelStudio: load
		});
		it("keeps catalog provider-owned", async () => {
			const ids = providerModelIds(expectProviderFields(await state.runProviderCatalog({
				provider: state.modelStudioProvider,
				config: { models: { providers: { modelstudio: {
					baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
					models: []
				} } } },
				env: { MODELSTUDIO_API_KEY: "modelstudio-key" },
				resolveProviderApiKey: () => ({ apiKey: "modelstudio-key" }),
				resolveProviderAuth: () => ({
					apiKey: "modelstudio-key",
					discoveryApiKey: void 0,
					mode: "api_key",
					source: "env"
				})
			}), {
				baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
				api: "openai-completions",
				apiKey: "modelstudio-key"
			}));
			expect(ids).toContain("qwen3.5-plus");
			expect(ids).toContain("qwen3-max-2026-01-23");
			expect(ids).toContain("MiniMax-M2.5");
		});
	});
}
function describeCloudflareAiGatewayProviderDiscoveryContract(load) {
	const state = {};
	describe("cloudflare-ai-gateway provider discovery contract", () => {
		installDiscoveryHooks(state, {
			providerIds: ["cloudflare-ai-gateway"],
			loadCloudflareAiGateway: load
		});
		it("keeps catalog disabled without stored metadata", async () => {
			await expect(runCatalog(state, {
				provider: state.cloudflareAiGatewayProvider,
				config: {},
				env: {},
				resolveProviderApiKey: () => ({ apiKey: void 0 }),
				resolveProviderAuth: () => ({
					apiKey: void 0,
					discoveryApiKey: void 0,
					mode: "none",
					source: "none"
				})
			})).resolves.toBeNull();
		});
		it("keeps env-managed catalog provider-owned", async () => {
			setRuntimeAuthStore({
				version: 1,
				profiles: { "cloudflare-ai-gateway:default": {
					type: "api_key",
					provider: "cloudflare-ai-gateway",
					keyRef: {
						source: "env",
						provider: "default",
						id: "CLOUDFLARE_AI_GATEWAY_API_KEY"
					},
					metadata: {
						accountId: "acc-123",
						gatewayId: "gw-456"
					}
				} }
			});
			expect(providerModelIds(expectProviderFields(await runCatalog(state, {
				provider: state.cloudflareAiGatewayProvider,
				config: {},
				env: { CLOUDFLARE_AI_GATEWAY_API_KEY: "secret-value" },
				resolveProviderApiKey: () => ({ apiKey: void 0 }),
				resolveProviderAuth: () => ({
					apiKey: void 0,
					discoveryApiKey: void 0,
					mode: "none",
					source: "none"
				})
			}), {
				baseUrl: "https://gateway.ai.cloudflare.com/v1/acc-123/gw-456/anthropic",
				api: "anthropic-messages",
				apiKey: "CLOUDFLARE_AI_GATEWAY_API_KEY"
			}))).toEqual(["claude-sonnet-4-6"]);
		});
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/onboard-config.ts
const EXPECTED_FALLBACKS = ["anthropic/claude-opus-4-5"];
function createLegacyProviderConfig(params) {
	return { models: { providers: { [params.providerId]: {
		baseUrl: params.baseUrl ?? "https://old.example.com",
		apiKey: params.apiKey ?? "old-key",
		api: params.api,
		models: [{
			id: params.modelId ?? "old-model",
			name: params.modelName ?? "Old",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0
			},
			contextWindow: 1e3,
			maxTokens: 100
		}]
	} } } };
}
function createConfigWithFallbacks() {
	return { agents: { defaults: { model: { fallbacks: [...EXPECTED_FALLBACKS] } } } };
}
//#endregion
//#region src/plugin-sdk/test-helpers/dashscope-video-provider.ts
function resetDashscopeVideoProviderMocks(mocks) {
	mocks.resolveApiKeyForProviderMock.mockClear();
	mocks.postJsonRequestMock.mockReset();
	mocks.fetchWithTimeoutMock.mockReset();
	mocks.assertOkOrThrowHttpErrorMock.mockClear();
	mocks.resolveProviderHttpRequestConfigMock.mockClear();
}
function mockSuccessfulDashscopeVideoTask(mocks, params = {}) {
	const { requestId = "req-1", taskId = "task-1", taskStatus = "SUCCEEDED", videoUrl = "https://example.com/out.mp4" } = params;
	mocks.postJsonRequestMock.mockResolvedValue({
		response: { json: async () => ({
			request_id: requestId,
			output: { task_id: taskId }
		}) },
		release: vi.fn(async () => {})
	});
	mocks.fetchWithTimeoutMock.mockResolvedValueOnce({
		json: async () => ({ output: {
			task_status: taskStatus,
			results: [{ video_url: videoUrl }]
		} }),
		headers: new Headers()
	}).mockResolvedValueOnce({
		arrayBuffer: async () => Buffer.from("mp4-bytes"),
		headers: new Headers({ "content-type": "video/mp4" })
	});
}
function expectDashscopeVideoTaskPoll(fetchWithTimeoutMock, params = {}) {
	const { baseUrl = "https://dashscope-intl.aliyuncs.com", taskId = "task-1", timeoutMs = 12e4 } = params;
	expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(1, `${baseUrl}/api/v1/tasks/${taskId}`, expect.objectContaining({ method: "GET" }), timeoutMs, fetch);
}
function expectSuccessfulDashscopeVideoResult(result, params = {}) {
	const { requestId = "req-1", taskId = "task-1", taskStatus = "SUCCEEDED" } = params;
	expect(result.videos).toHaveLength(1);
	expect(result.videos[0]?.mimeType).toBe("video/mp4");
	expect(result.metadata).toEqual(expect.objectContaining({
		requestId,
		taskId,
		taskStatus
	}));
}
//#endregion
//#region src/plugin-sdk/test-helpers/provider-media-capability-assertions.ts
function hasPositiveModeLimit(value, valuesByModel) {
	return (value ?? 0) > 0 || Object.values(valuesByModel ?? {}).some((modelValue) => Number.isFinite(modelValue) && modelValue > 0);
}
function expectExplicitVideoGenerationCapabilities(provider) {
	expect(provider.capabilities.generate, `${provider.id} missing generate capabilities`).toBeDefined();
	expect(provider.capabilities.imageToVideo, `${provider.id} missing imageToVideo capabilities`).toBeDefined();
	expect(provider.capabilities.videoToVideo, `${provider.id} missing videoToVideo capabilities`).toBeDefined();
	const supportedModes = listSupportedVideoGenerationModes(provider);
	const imageToVideo = provider.capabilities.imageToVideo;
	const videoToVideo = provider.capabilities.videoToVideo;
	if (imageToVideo?.enabled) {
		expect(hasPositiveModeLimit(imageToVideo.maxInputImages, imageToVideo.maxInputImagesByModel), `${provider.id} imageToVideo.enabled requires maxInputImages or maxInputImagesByModel`).toBe(true);
		expect(supportedModes).toContain("imageToVideo");
	}
	if (videoToVideo?.enabled) {
		expect(hasPositiveModeLimit(videoToVideo.maxInputVideos, videoToVideo.maxInputVideosByModel), `${provider.id} videoToVideo.enabled requires maxInputVideos or maxInputVideosByModel`).toBe(true);
		expect(supportedModes).toContain("videoToVideo");
	}
}
function expectExplicitMusicGenerationCapabilities(provider) {
	expect(provider.capabilities.generate, `${provider.id} missing generate capabilities`).toBeDefined();
	expect(provider.capabilities.edit, `${provider.id} missing edit capabilities`).toBeDefined();
	const edit = provider.capabilities.edit;
	if (!edit) return;
	if (edit.enabled) {
		expect(edit.maxInputImages ?? 0, `${provider.id} edit.enabled requires maxInputImages`).toBeGreaterThan(0);
		expect(listSupportedMusicGenerationModes(provider)).toContain("edit");
	} else expect(listSupportedMusicGenerationModes(provider)).toEqual(["generate"]);
}
//#endregion
//#region src/plugin-sdk/test-helpers/unified-model-catalog-contract.ts
function expectUnifiedModelCatalogEntries(rows, params) {
	expect(rows).toBeTruthy();
	for (const row of rows ?? []) {
		expect(row).toEqual(expect.objectContaining({
			provider: params.provider,
			kind: params.kind
		}));
		expect(row.model.trim()).toBe(row.model);
		expect(row.model).not.toBe("");
		expect(row.source).not.toBe("");
	}
}
function expectUnifiedModelCatalogProviderRegistration(params) {
	const captured = createCapturedPluginRegistration({
		id: params.pluginId ?? params.provider,
		name: params.pluginName ?? params.provider,
		source: "test"
	});
	params.plugin.register(captured.api);
	const registration = captured.modelCatalogProviders.find((provider) => provider.provider === params.provider && provider.kinds.includes(params.kind));
	expect(registration).toBeTruthy();
	return registration;
}
//#endregion
//#region src/plugin-sdk/test-helpers/provider-onboard.ts
function expectProviderOnboardAllowlistAlias(params) {
	const withDefault = params.applyProviderConfig({});
	expect(Object.keys(withDefault.agents?.defaults?.models ?? {})).toContain(params.modelRef);
	expect(params.applyProviderConfig({ agents: { defaults: { models: { [params.modelRef]: { alias: params.alias } } } } }).agents?.defaults?.models?.[params.modelRef]?.alias).toBe(params.alias);
}
function expectProviderOnboardPrimaryAndFallbacks(params) {
	expectProviderOnboardPrimaryModel(params);
	expect(resolveAgentModelFallbackValues(params.applyConfig(createConfigWithFallbacks()).agents?.defaults?.model)).toEqual([...EXPECTED_FALLBACKS]);
}
function expectProviderOnboardPrimaryModel(params) {
	expect(resolveAgentModelPrimaryValue(params.applyConfig({}).agents?.defaults?.model)).toBe(params.modelRef);
}
function expectProviderOnboardPreservesPrimary(params) {
	expect(resolveAgentModelPrimaryValue(params.applyProviderConfig({ agents: { defaults: { model: { primary: params.primaryModelRef } } } }).agents?.defaults?.model)).toBe(params.primaryModelRef);
}
function expectProviderOnboardMergedLegacyConfig(params) {
	const provider = params.applyProviderConfig(createLegacyProviderConfig({
		providerId: params.providerId,
		api: params.legacyApi,
		modelId: params.legacyModelId,
		modelName: params.legacyModelName,
		baseUrl: params.legacyBaseUrl,
		apiKey: params.legacyApiKey
	})).models?.providers?.[params.providerId];
	expect(provider?.baseUrl).toBe(params.baseUrl);
	expect(provider?.api).toBe(params.providerApi);
	expect(provider?.apiKey).toBe((params.legacyApiKey ?? "old-key").trim());
	return provider;
}
//#endregion
//#region src/plugin-sdk/test-helpers/provider-runtime-contract.ts
const CONTRACT_SETUP_TIMEOUT_MS = 3e5;
const OAUTH_MODULE_ID = "@earendil-works/pi-ai/oauth";
const OPENAI_CODEX_PROVIDER_RUNTIME_MODULE_ID = "../../../extensions/openai/openai-codex-provider.runtime.js";
const refreshOpenAICodexTokenMock = vi.fn();
const getOAuthProvidersMock = vi.fn(() => [
	{
		id: "anthropic",
		envApiKey: "ANTHROPIC_API_KEY",
		oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN"
	},
	{
		id: "google",
		envApiKey: "GOOGLE_API_KEY",
		oauthTokenEnv: "GOOGLE_OAUTH_TOKEN"
	},
	{
		id: "openai-codex",
		envApiKey: "OPENAI_API_KEY",
		oauthTokenEnv: "OPENAI_OAUTH_TOKEN"
	}
]);
function installProviderRuntimeContractMocks() {
	vi.doMock(OAUTH_MODULE_ID, async () => {
		return {
			...await vi.importActual(OAUTH_MODULE_ID),
			refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
			getOAuthProviders: getOAuthProvidersMock
		};
	});
	vi.doMock(OPENAI_CODEX_PROVIDER_RUNTIME_MODULE_ID, () => ({ refreshOpenAICodexToken: refreshOpenAICodexTokenMock }));
}
function removeProviderRuntimeContractMocks() {
	vi.doUnmock(OAUTH_MODULE_ID);
	vi.doUnmock(OPENAI_CODEX_PROVIDER_RUNTIME_MODULE_ID);
}
function createModel(overrides) {
	return {
		id: overrides.id,
		name: overrides.name ?? overrides.id,
		api: overrides.api ?? "openai-responses",
		provider: overrides.provider ?? "demo",
		baseUrl: overrides.baseUrl ?? "https://api.example.com/v1",
		reasoning: overrides.reasoning ?? true,
		input: overrides.input ?? ["text"],
		cost: overrides.cost ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: overrides.contextWindow ?? 2e5,
		maxTokens: overrides.maxTokens ?? 8192
	};
}
function requireRecord(value, label) {
	expect(value, label).toBeTypeOf("object");
	expect(value, label).not.toBeNull();
	return value;
}
function expectFields(value, fields) {
	const record = requireRecord(value, "record");
	for (const [key, expected] of Object.entries(fields)) expect(record[key]).toEqual(expected);
}
function installRuntimeHooks(fixtures) {
	const providers = /* @__PURE__ */ new Map();
	let loadPromise = null;
	function requireProviderContractProvider(providerId) {
		const provider = providers.get(providerId);
		if (!provider) throw new Error(`provider runtime contract fixture missing for ${providerId}`);
		return provider;
	}
	async function ensureProvidersLoaded() {
		if (!loadPromise) loadPromise = (async () => {
			providers.clear();
			const registeredFixtures = await Promise.all(fixtures.map(async (fixture) => {
				return {
					fixture,
					providers: (await registerProviderPlugin({
						plugin: (await fixture.load()).default,
						id: fixture.pluginId,
						name: fixture.name
					})).providers
				};
			}));
			for (const { fixture, providers: registeredProviders } of registeredFixtures) for (const providerId of fixture.providerIds) providers.set(providerId, requireRegisteredProvider(registeredProviders, providerId, "provider"));
		})();
		await loadPromise;
	}
	beforeAll(async () => {
		installProviderRuntimeContractMocks();
		await ensureProvidersLoaded();
	}, CONTRACT_SETUP_TIMEOUT_MS);
	afterAll(() => {
		removeProviderRuntimeContractMocks();
	});
	beforeEach(() => {
		refreshOpenAICodexTokenMock.mockReset();
		getOAuthProvidersMock.mockClear();
	}, CONTRACT_SETUP_TIMEOUT_MS);
	return requireProviderContractProvider;
}
function describeAnthropicProviderRuntimeContract(load) {
	describe("anthropic provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
		const requireProviderContractProvider = installRuntimeHooks([{
			providerIds: ["anthropic"],
			pluginId: "anthropic",
			name: "Anthropic",
			load
		}]);
		it("owns anthropic 4.6 forward-compat resolution", () => {
			const model = requireProviderContractProvider("anthropic").resolveDynamicModel?.({
				provider: "anthropic",
				modelId: "claude-sonnet-4.6-20260219",
				modelRegistry: { find: (_provider, id) => id === "claude-sonnet-4.5-20260219" ? createModel({
					id,
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com"
				}) : null }
			});
			expectFields(model, {
				id: "claude-sonnet-4.6-20260219",
				provider: "anthropic",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com"
			});
		});
		it("owns usage auth resolution", async () => {
			await expect(requireProviderContractProvider("anthropic").resolveUsageAuth?.({
				config: {},
				env: {},
				provider: "anthropic",
				resolveApiKeyFromConfigAndStore: () => void 0,
				resolveOAuthToken: async () => ({ token: "anthropic-oauth-token" })
			})).resolves.toEqual({ token: "anthropic-oauth-token" });
		});
		it("owns auth doctor hint generation", () => {
			const hint = requireProviderContractProvider("anthropic").buildAuthDoctorHint?.({
				provider: "anthropic",
				profileId: "anthropic:default",
				config: { auth: { profiles: { "anthropic:default": {
					provider: "anthropic",
					mode: "oauth"
				} } } },
				store: {
					version: 1,
					profiles: { "anthropic:oauth-user@example.com": {
						type: "oauth",
						provider: "anthropic",
						access: "oauth-access",
						refresh: "oauth-refresh",
						expires: Date.now() + 6e4
					} }
				}
			});
			expect(hint).toContain("suggested profile: anthropic:oauth-user@example.com");
			expect(hint).toContain("openclaw doctor --yes");
		});
		it("owns usage snapshot fetching", async () => {
			const provider = requireProviderContractProvider("anthropic");
			const mockFetch = createProviderUsageFetch(async (url) => {
				if (url.includes("api.anthropic.com/api/oauth/usage")) return makeResponse(200, {
					five_hour: {
						utilization: 20,
						resets_at: "2026-01-07T01:00:00Z"
					},
					seven_day: {
						utilization: 35,
						resets_at: "2026-01-09T01:00:00Z"
					}
				});
				return makeResponse(404, "not found");
			});
			await expect(provider.fetchUsageSnapshot?.({
				config: {},
				env: {},
				provider: "anthropic",
				token: "anthropic-oauth-token",
				timeoutMs: 5e3,
				fetchFn: mockFetch
			})).resolves.toEqual({
				provider: "anthropic",
				displayName: "Claude",
				windows: [{
					label: "5h",
					usedPercent: 20,
					resetAt: Date.parse("2026-01-07T01:00:00Z")
				}, {
					label: "Week",
					usedPercent: 35,
					resetAt: Date.parse("2026-01-09T01:00:00Z")
				}]
			});
		});
	});
}
function describeGithubCopilotProviderRuntimeContract(load) {
	describe("github-copilot provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
		const requireProviderContractProvider = installRuntimeHooks([{
			providerIds: ["github-copilot"],
			pluginId: "github-copilot",
			name: "GitHub Copilot",
			load
		}]);
		it("owns Copilot-specific forward-compat fallbacks", () => {
			const model = requireProviderContractProvider("github-copilot").resolveDynamicModel?.({
				provider: "github-copilot",
				modelId: "gpt-5.4",
				modelRegistry: { find: (_provider, id) => id === "gpt-5.2-codex" ? createModel({
					id,
					api: "openai-codex-responses",
					provider: "github-copilot",
					baseUrl: "https://api.copilot.example"
				}) : null }
			});
			expectFields(model, {
				id: "gpt-5.4",
				provider: "github-copilot",
				api: "openai-codex-responses"
			});
		});
	});
}
function describeGoogleProviderRuntimeContract(load) {
	describe("google provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
		const requireProviderContractProvider = installRuntimeHooks([{
			providerIds: ["google", "google-gemini-cli"],
			pluginId: "google",
			name: "Google",
			load
		}]);
		it("owns google direct gemini 3.1 forward-compat resolution", () => {
			const model = requireProviderContractProvider("google").resolveDynamicModel?.({
				provider: "google",
				modelId: "gemini-3.1-pro-preview",
				modelRegistry: { find: (_provider, id) => id === "gemini-3-pro-preview" ? createModel({
					id,
					api: "google-generative-ai",
					provider: "google",
					baseUrl: "https://generativelanguage.googleapis.com",
					reasoning: false,
					contextWindow: 1048576,
					maxTokens: 65536
				}) : null }
			});
			expectFields(model, {
				id: "gemini-3.1-pro-preview",
				provider: "google",
				api: "google-generative-ai",
				baseUrl: "https://generativelanguage.googleapis.com",
				reasoning: true
			});
		});
		it("owns gemini cli 3.1 forward-compat resolution", () => {
			const model = requireProviderContractProvider("google-gemini-cli").resolveDynamicModel?.({
				provider: "google-gemini-cli",
				modelId: "gemini-3.1-pro-preview",
				modelRegistry: { find: (_provider, id) => id === "gemini-3-pro-preview" ? createModel({
					id,
					api: "google-gemini-cli",
					provider: "google-gemini-cli",
					baseUrl: "https://cloudcode-pa.googleapis.com",
					reasoning: false,
					contextWindow: 1048576,
					maxTokens: 65536
				}) : null }
			});
			expectFields(model, {
				id: "gemini-3.1-pro-preview",
				provider: "google-gemini-cli",
				reasoning: true
			});
		});
		it("owns usage-token parsing", async () => {
			await expect(requireProviderContractProvider("google-gemini-cli").resolveUsageAuth?.({
				config: {},
				env: {},
				provider: "google-gemini-cli",
				resolveApiKeyFromConfigAndStore: () => void 0,
				resolveOAuthToken: async () => ({
					token: "{\"token\":\"google-oauth-token\"}",
					accountId: "google-account"
				})
			})).resolves.toEqual({
				token: "google-oauth-token",
				accountId: "google-account"
			});
		});
		it("owns OAuth auth-profile formatting", () => {
			expect(requireProviderContractProvider("google-gemini-cli").formatApiKey?.({
				type: "oauth",
				provider: "google-gemini-cli",
				access: "google-oauth-token",
				refresh: "refresh-token",
				expires: Date.now() + 6e4,
				projectId: "proj-123"
			})).toBe("{\"token\":\"google-oauth-token\",\"projectId\":\"proj-123\"}");
		});
		it("owns usage snapshot fetching", async () => {
			const provider = requireProviderContractProvider("google-gemini-cli");
			const mockFetch = createProviderUsageFetch(async (url) => {
				if (url.includes("cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")) return makeResponse(200, { buckets: [{
					modelId: "gemini-3.1-pro-preview",
					remainingFraction: .4
				}, {
					modelId: "gemini-3.1-flash-preview",
					remainingFraction: .8
				}] });
				return makeResponse(404, "not found");
			});
			const snapshot = await provider.fetchUsageSnapshot?.({
				config: {},
				env: {},
				provider: "google-gemini-cli",
				token: "google-oauth-token",
				timeoutMs: 5e3,
				fetchFn: mockFetch
			});
			expectFields(snapshot, {
				provider: "google-gemini-cli",
				displayName: "Gemini"
			});
			expect(snapshot?.windows[0]).toEqual({
				label: "Pro",
				usedPercent: 60
			});
			expect(snapshot?.windows[1]?.label).toBe("Flash");
			expect(snapshot?.windows[1]?.usedPercent).toBeCloseTo(20);
		});
	});
}
function describeOpenAIProviderRuntimeContract(load) {
	describe("openai provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
		const requireProviderContractProvider = installRuntimeHooks([{
			providerIds: ["openai", "openai-codex"],
			pluginId: "openai",
			name: "OpenAI",
			load
		}]);
		it("owns openai gpt-5.4 forward-compat resolution", () => {
			const model = requireProviderContractProvider("openai").resolveDynamicModel?.({
				provider: "openai",
				modelId: "gpt-5.4-pro",
				modelRegistry: { find: (_provider, id) => id === "gpt-5.2-pro" ? createModel({
					id,
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					input: ["text", "image"]
				}) : null }
			});
			expectFields(model, {
				id: "gpt-5.4-pro",
				provider: "openai",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				contextWindow: 105e4,
				maxTokens: 128e3
			});
		});
		it("leaves openai gpt-5.5 forward-compat resolution to Pi", () => {
			const model = requireProviderContractProvider("openai").resolveDynamicModel?.({
				provider: "openai",
				modelId: "gpt-5.5",
				modelRegistry: { find: (_provider, id) => id === "gpt-5.4" ? createModel({
					id,
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					input: ["text", "image"]
				}) : null }
			});
			expect(model).toBeUndefined();
		});
		it("owns openai gpt-5.4 mini forward-compat resolution", () => {
			const model = requireProviderContractProvider("openai").resolveDynamicModel?.({
				provider: "openai",
				modelId: "gpt-5.4-mini",
				modelRegistry: { find: (_provider, id) => id === "gpt-5-mini" ? createModel({
					id,
					provider: "openai",
					api: "openai-responses",
					baseUrl: "https://api.openai.com/v1",
					input: ["text", "image"],
					reasoning: true,
					contextWindow: 4e5,
					maxTokens: 128e3
				}) : null }
			});
			expectFields(model, {
				id: "gpt-5.4-mini",
				provider: "openai",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				contextWindow: 4e5,
				maxTokens: 128e3
			});
		});
		it("owns direct openai transport normalization", () => {
			expectFields(requireProviderContractProvider("openai").normalizeResolvedModel?.({
				provider: "openai",
				modelId: "gpt-5.4",
				model: createModel({
					id: "gpt-5.4",
					provider: "openai",
					api: "openai-completions",
					baseUrl: "https://api.openai.com/v1",
					input: ["text", "image"],
					contextWindow: 105e4,
					maxTokens: 128e3
				})
			}), { api: "openai-responses" });
		});
		it("owns refresh fallback for accountId extraction failures", async () => {
			const provider = requireProviderContractProvider("openai-codex");
			const credential = {
				type: "oauth",
				provider: "openai-codex",
				access: "cached-access-token",
				refresh: "refresh-token",
				expires: Date.now() - 6e4
			};
			refreshOpenAICodexTokenMock.mockRejectedValueOnce(/* @__PURE__ */ new Error("Failed to extract accountId from token"));
			await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
		});
		it("owns forward-compat codex models", () => {
			const model = requireProviderContractProvider("openai-codex").resolveDynamicModel?.({
				provider: "openai-codex",
				modelId: "gpt-5.4",
				modelRegistry: { find: (_provider, id) => id === "gpt-5.2-codex" ? createModel({
					id,
					api: "openai-codex-responses",
					provider: "openai-codex",
					baseUrl: "https://chatgpt.com/backend-api"
				}) : null }
			});
			expectFields(model, {
				id: "gpt-5.4",
				provider: "openai-codex",
				api: "openai-codex-responses",
				contextWindow: 105e4,
				maxTokens: 128e3
			});
		});
		it("keeps Pi cost metadata but applies Codex context metadata for gpt-5.5 models", () => {
			const model = requireProviderContractProvider("openai-codex").resolveDynamicModel?.({
				provider: "openai-codex",
				modelId: "gpt-5.5",
				modelRegistry: { find: (_provider, id) => id === "gpt-5.5" ? createModel({
					id,
					api: "openai-codex-responses",
					provider: "openai-codex",
					baseUrl: "https://chatgpt.com/backend-api",
					input: ["text", "image"],
					cost: {
						input: 5,
						output: 30,
						cacheRead: .5,
						cacheWrite: 0
					},
					contextWindow: 272e3,
					maxTokens: 128e3
				}) : null }
			});
			expectFields(model, {
				id: "gpt-5.5",
				provider: "openai-codex",
				api: "openai-codex-responses",
				contextWindow: 4e5,
				contextTokens: 272e3,
				maxTokens: 128e3
			});
		});
		it("claims codex mini models through the Codex OAuth route", () => {
			const model = requireProviderContractProvider("openai-codex").resolveDynamicModel?.({
				provider: "openai-codex",
				modelId: "gpt-5.4-mini",
				modelRegistry: { find: (_provider, id) => id === "gpt-5.4" ? createModel({
					id,
					api: "openai-codex-responses",
					provider: "openai-codex",
					baseUrl: "https://chatgpt.com/backend-api",
					cost: {
						input: 5,
						output: 30,
						cacheRead: .5,
						cacheWrite: 0
					},
					contextWindow: 272e3,
					maxTokens: 128e3
				}) : null }
			});
			expectFields(model, {
				id: "gpt-5.4-mini",
				provider: "openai-codex",
				api: "openai-codex-responses",
				contextWindow: 4e5,
				contextTokens: 272e3,
				maxTokens: 128e3,
				cost: {
					input: .75,
					output: 4.5,
					cacheRead: .075,
					cacheWrite: 0
				}
			});
		});
		it("owns codex transport defaults", () => {
			expect(requireProviderContractProvider("openai-codex").prepareExtraParams?.({
				provider: "openai-codex",
				modelId: "gpt-5.4",
				extraParams: { temperature: .2 }
			})).toEqual({
				temperature: .2,
				transport: "auto"
			});
		});
		it("owns usage snapshot fetching", async () => {
			const provider = requireProviderContractProvider("openai-codex");
			const mockFetch = createProviderUsageFetch(async (url) => {
				if (url.includes("chatgpt.com/backend-api/wham/usage")) return makeResponse(200, {
					rate_limit: { primary_window: {
						used_percent: 12,
						limit_window_seconds: 10800,
						reset_at: 1705e3
					} },
					plan_type: "Plus"
				});
				return makeResponse(404, "not found");
			});
			await expect(provider.fetchUsageSnapshot?.({
				config: {},
				env: {},
				provider: "openai-codex",
				token: "codex-token",
				accountId: "acc-1",
				timeoutMs: 5e3,
				fetchFn: mockFetch
			})).resolves.toEqual({
				provider: "openai-codex",
				displayName: "Codex",
				windows: [{
					label: "3h",
					usedPercent: 12,
					resetAt: 1705e6
				}],
				plan: "Plus"
			});
		});
	});
}
function describeOpenRouterProviderRuntimeContract(load) {
	describe("openrouter provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
		const requireProviderContractProvider = installRuntimeHooks([{
			providerIds: ["openrouter"],
			pluginId: "openrouter",
			name: "OpenRouter",
			load
		}]);
		it("owns dynamic OpenRouter model defaults", () => {
			const model = requireProviderContractProvider("openrouter").resolveDynamicModel?.({
				provider: "openrouter",
				modelId: "x-ai/grok-4-1-fast",
				modelRegistry: { find: () => null }
			});
			expectFields(model, {
				id: "x-ai/grok-4-1-fast",
				provider: "openrouter",
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
				maxTokens: 8192
			});
		});
	});
}
function describeVeniceProviderRuntimeContract(load) {
	describe("venice provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
		const requireProviderContractProvider = installRuntimeHooks([{
			providerIds: ["venice"],
			pluginId: "venice",
			name: "Venice",
			load
		}]);
		it("owns xai downstream compat flags for grok-backed Venice models", () => {
			const model = requireProviderContractProvider("venice").normalizeResolvedModel?.({
				provider: "venice",
				modelId: "grok-41-fast",
				model: createModel({
					id: "grok-41-fast",
					provider: "venice",
					api: "openai-completions",
					baseUrl: "https://api.venice.ai/api/v1"
				})
			});
			const compat = requireRecord(model?.compat, "compat");
			expect(compat.toolSchemaProfile).toBe("xai");
			expect(compat.nativeWebSearchTool).toBe(true);
			expect(compat.toolCallArgumentsEncoding).toBe("html-entities");
		});
	});
}
function describeZAIProviderRuntimeContract(load) {
	describe("zai provider runtime contract", { timeout: CONTRACT_SETUP_TIMEOUT_MS }, () => {
		const requireProviderContractProvider = installRuntimeHooks([{
			providerIds: ["zai"],
			pluginId: "zai",
			name: "Z.AI",
			load
		}]);
		it("owns glm-5 forward-compat resolution", () => {
			const model = requireProviderContractProvider("zai").resolveDynamicModel?.({
				provider: "zai",
				modelId: "glm-5",
				modelRegistry: { find: (_provider, id) => id === "glm-4.7" ? createModel({
					id,
					api: "openai-completions",
					provider: "zai",
					baseUrl: "https://api.z.ai/api/paas/v4",
					reasoning: false,
					contextWindow: 202752,
					maxTokens: 16384
				}) : null }
			});
			expectFields(model, {
				id: "glm-5",
				provider: "zai",
				api: "openai-completions",
				reasoning: true
			});
		});
		it("owns usage auth resolution", async () => {
			await expect(requireProviderContractProvider("zai").resolveUsageAuth?.({
				config: {},
				env: { ZAI_API_KEY: "env-zai-token" },
				provider: "zai",
				resolveApiKeyFromConfigAndStore: () => "env-zai-token",
				resolveOAuthToken: async () => null
			})).resolves.toEqual({ token: "env-zai-token" });
		});
		it("falls back to legacy pi auth tokens for usage auth", async () => {
			const provider = requireProviderContractProvider("zai");
			const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zai-contract-"));
			await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
			await fs.writeFile(path.join(home, ".pi", "agent", "auth.json"), `${JSON.stringify({ "z-ai": { access: "legacy-zai-token" } }, null, 2)}\n`, "utf8");
			try {
				await expect(provider.resolveUsageAuth?.({
					config: {},
					env: { HOME: home },
					provider: "zai",
					resolveApiKeyFromConfigAndStore: () => void 0,
					resolveOAuthToken: async () => null
				})).resolves.toEqual({ token: "legacy-zai-token" });
			} finally {
				await fs.rm(home, {
					recursive: true,
					force: true
				});
			}
		});
		it("owns usage snapshot fetching", async () => {
			const provider = requireProviderContractProvider("zai");
			const mockFetch = createProviderUsageFetch(async (url) => {
				if (url.includes("api.z.ai/api/monitor/usage/quota/limit")) return makeResponse(200, {
					success: true,
					code: 200,
					data: {
						planName: "Pro",
						limits: [{
							type: "TOKENS_LIMIT",
							percentage: 25,
							unit: 3,
							number: 6,
							nextResetTime: "2026-01-07T06:00:00Z"
						}]
					}
				});
				return makeResponse(404, "not found");
			});
			await expect(provider.fetchUsageSnapshot?.({
				config: {},
				env: {},
				provider: "zai",
				token: "env-zai-token",
				timeoutMs: 5e3,
				fetchFn: mockFetch
			})).resolves.toEqual({
				provider: "zai",
				displayName: "z.ai",
				windows: [{
					label: "Tokens (6h)",
					usedPercent: 25,
					resetAt: 17677656e5
				}],
				plan: "Pro"
			});
		});
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/provider-wizard-contract-suites.ts
const resolvePluginProvidersMock = vi.fn();
let restoreProviderResolver;
function createAuthMethod(params) {
	return {
		id: params.id,
		label: params.label,
		...params.hint ? { hint: params.hint } : {},
		...params.wizard ? { wizard: params.wizard } : {},
		kind: "api_key",
		run: async () => ({ profiles: [] })
	};
}
const TEST_PROVIDERS = [
	{
		id: "alpha",
		label: "Alpha",
		auth: [createAuthMethod({
			id: "api-key",
			label: "API key",
			wizard: {
				choiceLabel: "Alpha key",
				choiceHint: "Use an API key",
				groupId: "alpha",
				groupLabel: "Alpha",
				onboardingScopes: ["text-inference"]
			}
		}), createAuthMethod({
			id: "oauth",
			label: "OAuth",
			wizard: {
				choiceId: "alpha-oauth",
				choiceLabel: "Alpha OAuth",
				groupId: "alpha",
				groupLabel: "Alpha",
				groupHint: "Recommended"
			}
		})],
		wizard: { modelPicker: {
			label: "Alpha custom",
			hint: "Pick Alpha models",
			methodId: "oauth"
		} }
	},
	{
		id: "beta",
		label: "Beta",
		auth: [createAuthMethod({
			id: "token",
			label: "Token"
		})],
		wizard: {
			setup: {
				choiceLabel: "Beta setup",
				groupId: "beta",
				groupLabel: "Beta"
			},
			modelPicker: { label: "Beta custom" }
		}
	},
	{
		id: "gamma",
		label: "Gamma",
		auth: [createAuthMethod({
			id: "default",
			label: "Default auth"
		}), createAuthMethod({
			id: "alt",
			label: "Alt auth"
		})],
		wizard: { setup: {
			methodId: "alt",
			choiceId: "gamma-alt",
			choiceLabel: "Gamma alt",
			groupId: "gamma",
			groupLabel: "Gamma"
		} }
	}
];
const TEST_PROVIDER_IDS = TEST_PROVIDERS.map((provider) => provider.id).toSorted((left, right) => left.localeCompare(right));
function sortedValues(values) {
	return [...values].toSorted((left, right) => left.localeCompare(right));
}
function expectUniqueValues(values) {
	expect(values).toEqual([...new Set(values)]);
}
function resolveExpectedWizardChoiceValues(providers) {
	return sortedValues(providers.flatMap((provider) => {
		const methodSetups = provider.auth.filter((method) => method.wizard);
		if (methodSetups.length > 0) return methodSetups.map((method) => method.wizard?.choiceId?.trim() || buildProviderPluginMethodChoice(provider.id, method.id));
		const setup = provider.wizard?.setup;
		if (!setup) return [];
		const explicitMethodId = setup.methodId?.trim();
		if (explicitMethodId && provider.auth.some((method) => method.id === explicitMethodId)) return [setup.choiceId?.trim() || buildProviderPluginMethodChoice(provider.id, explicitMethodId)];
		if (provider.auth.length === 1) return [setup.choiceId?.trim() || provider.id];
		return provider.auth.map((method) => buildProviderPluginMethodChoice(provider.id, method.id));
	}));
}
function resolveExpectedModelPickerValues(providers) {
	return sortedValues(providers.flatMap((provider) => {
		const modelPicker = provider.wizard?.modelPicker;
		if (!modelPicker) return [];
		const explicitMethodId = modelPicker.methodId?.trim();
		if (explicitMethodId) return [buildProviderPluginMethodChoice(provider.id, explicitMethodId)];
		if (provider.auth.length === 1) return [provider.id];
		return [buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default")];
	}));
}
function expectAllChoicesResolve(values, resolver) {
	expect(values.every((value) => Boolean(resolver(value))), values.join(", ")).toBe(true);
}
beforeEach(() => {
	resolvePluginProvidersMock.mockReset();
	resolvePluginProvidersMock.mockReturnValue(TEST_PROVIDERS);
	restoreProviderResolver?.();
	restoreProviderResolver = setProviderWizardProvidersResolverForTest((params) => resolvePluginProvidersMock(params));
});
afterEach(() => {
	restoreProviderResolver?.();
	restoreProviderResolver = void 0;
});
function describeProviderWizardSetupOptionsContract() {
	describe("provider wizard setup options contract", () => {
		it("exposes every wizard setup choice through the shared wizard layer", () => {
			const options = resolveProviderWizardOptions({
				config: { plugins: {
					enabled: true,
					allow: TEST_PROVIDER_IDS,
					slots: { memory: "none" }
				} },
				env: process.env
			});
			expect(sortedValues(options.map((option) => option.value))).toEqual(resolveExpectedWizardChoiceValues(TEST_PROVIDERS));
			expectUniqueValues(options.map((option) => option.value));
		});
	});
}
function describeProviderWizardChoiceResolutionContract() {
	describe("provider wizard choice resolution contract", () => {
		it("round-trips every shared wizard choice back to its provider and auth method", () => {
			expectAllChoicesResolve(resolveProviderWizardOptions({
				config: {},
				env: process.env
			}).map((option) => option.value), (choice) => resolveProviderPluginChoice({
				providers: TEST_PROVIDERS,
				choice
			}));
		});
	});
}
function describeProviderWizardModelPickerContract() {
	describe("provider wizard model picker contract", () => {
		it("exposes every model-picker entry through the shared wizard layer", () => {
			const entries = resolveProviderModelPickerEntries({
				config: {},
				env: process.env
			});
			expect(sortedValues(entries.map((entry) => entry.value))).toEqual(resolveExpectedModelPickerValues(TEST_PROVIDERS));
			expectAllChoicesResolve(entries.map((entry) => entry.value), (choice) => resolveProviderPluginChoice({
				providers: TEST_PROVIDERS,
				choice
			}));
		});
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/provider-replay-policy.ts
async function expectPassthroughReplayPolicy(params) {
	const provider = await registerSingleProviderPlugin(params.plugin);
	const policy = provider.buildReplayPolicy?.({
		provider: params.providerId,
		modelApi: "openai-completions",
		modelId: params.modelId
	});
	expect(policy).toMatchObject({
		applyAssistantFirstOrderingFix: false,
		validateGeminiTurns: false,
		validateAnthropicTurns: false
	});
	if (params.sanitizeThoughtSignatures) expect(policy).toMatchObject({ sanitizeThoughtSignatures: {
		allowBase64Only: true,
		includeCamelCase: true
	} });
	else expect(policy).not.toHaveProperty("sanitizeThoughtSignatures");
	return provider;
}
//#endregion
//#region src/plugin-sdk/test-helpers/stream-hooks.ts
function createCapturedThinkingConfigStream() {
	let capturedPayload;
	const streamFn = (model, _context, options) => {
		const payload = { config: { thinkingConfig: { thinkingBudget: -1 } } };
		options?.onPayload?.(payload, model);
		capturedPayload = payload;
		return {};
	};
	return {
		streamFn,
		getCapturedPayload: () => capturedPayload
	};
}
//#endregion
//#region src/plugin-sdk/test-helpers/stt-live-audio.ts
const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_TTS_MODEL_ID = "eleven_multilingual_v2";
function normalizeTranscriptForMatch(value) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
const OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE = /open(?:claw|cl|flaw|clar|core)/;
function expectOpenClawLiveTranscriptMarker(value) {
	expect(normalizeTranscriptForMatch(value)).toMatch(OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE);
}
async function waitForLiveExpectation(expectation, timeoutMs = 3e4) {
	const started = Date.now();
	let lastError;
	while (Date.now() - started < timeoutMs) try {
		expectation();
		return;
	} catch (error) {
		lastError = error;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw lastError;
}
async function synthesizeElevenLabsLiveSpeech(params) {
	const baseUrl = process.env.ELEVENLABS_BASE_URL?.trim() || DEFAULT_ELEVENLABS_BASE_URL;
	const voiceId = process.env.ELEVENLABS_LIVE_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE_ID;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 3e4);
	try {
		const url = new URL(`${baseUrl.replace(/\/+$/, "")}/v1/text-to-speech/${voiceId}`);
		url.searchParams.set("output_format", params.outputFormat);
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"xi-api-key": params.apiKey,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				text: params.text,
				model_id: DEFAULT_ELEVENLABS_TTS_MODEL_ID,
				voice_settings: {
					stability: .5,
					similarity_boost: .75,
					style: 0,
					use_speaker_boost: true,
					speed: 1
				}
			}),
			signal: controller.signal
		});
		if (!response.ok) throw new Error(`ElevenLabs live TTS failed (${response.status})`);
		return Buffer.from(await response.arrayBuffer());
	} finally {
		clearTimeout(timeout);
	}
}
async function streamAudioForLiveTest(params) {
	const chunkSize = params.chunkSize ?? 160;
	const delayMs = params.delayMs ?? 5;
	for (let offset = 0; offset < params.audio.byteLength; offset += chunkSize) {
		params.sendAudio(params.audio.subarray(offset, offset + chunkSize));
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
}
async function runRealtimeSttLiveTest(params) {
	const transcripts = [];
	const partials = [];
	const errors = [];
	const expected = params.expectedNormalizedText ?? OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE;
	const session = params.provider.createSession({
		providerConfig: params.providerConfig,
		onPartial: (partial) => partials.push(partial),
		onTranscript: (transcript) => transcripts.push(transcript),
		onError: (error) => errors.push(error)
	});
	try {
		await session.connect();
		await streamAudioForLiveTest({
			audio: params.audio,
			sendAudio: (chunk) => session.sendAudio(chunk),
			chunkSize: params.chunkSize,
			delayMs: params.delayMs
		});
		if (params.closeBeforeWait) session.close();
		await waitForLiveExpectation(() => {
			if (errors[0]) throw errors[0];
			const normalized = normalizeTranscriptForMatch(transcripts.join(" "));
			if (typeof expected === "string") expect(normalized).toContain(expected);
			else expect(normalized).toMatch(expected);
		}, params.timeoutMs ?? 6e4);
	} finally {
		session.close();
	}
	expect(partials.length + transcripts.length).toBeGreaterThan(0);
	return {
		transcripts,
		partials,
		errors
	};
}
//#endregion
//#region src/plugin-sdk/test-helpers/web-fetch-provider-contract.ts
function resolveWebFetchCredentialValue(provider) {
	if (provider.requiresCredential === false) return `${provider.id}-no-key-needed`;
	const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
	if (!envVar) return `${provider.id}-test`;
	return envVar.toLowerCase().includes("api_key") ? `${provider.id}-test` : "sk-test";
}
function describeWebFetchProviderContracts(pluginId) {
	const providerIds = pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)?.webFetchProviderIds ?? [];
	let providerEntries;
	const resolveProviders = () => {
		if (providerEntries) return providerEntries;
		const publicArtifactProviders = resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({ onlyPluginIds: [pluginId] });
		if (publicArtifactProviders) {
			providerEntries = publicArtifactProviders.map((provider) => ({
				pluginId: provider.pluginId,
				provider,
				credentialValue: resolveWebFetchCredentialValue(provider)
			}));
			return providerEntries;
		}
		providerEntries = resolveWebFetchProviderContractEntriesForPluginId(pluginId);
		return providerEntries;
	};
	describe(`${pluginId} web fetch provider contract registry load`, () => {
		it("loads bundled web fetch providers", () => {
			expect(resolveProviders().length).toBeGreaterThan(0);
		});
	});
	for (const providerId of providerIds) describe(`${pluginId}:${providerId} web fetch contract`, () => {
		installWebFetchProviderContractSuite({
			provider: () => {
				const entry = resolveProviders().find((provider) => provider.provider.id === providerId);
				if (!entry) throw new Error(`web fetch provider contract entry missing for ${pluginId}:${providerId}`);
				return entry.provider;
			},
			credentialValue: () => {
				const entry = resolveProviders().find((provider) => provider.provider.id === providerId);
				if (!entry) throw new Error(`web fetch provider contract entry missing for ${pluginId}:${providerId}`);
				return entry.credentialValue;
			},
			pluginId
		});
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/web-search-provider-contract.ts
function resolveWebSearchCredentialValue(provider) {
	if (provider.requiresCredential === false) return `${provider.id}-no-key-needed`;
	const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
	if (!envVar) return `${provider.id}-test`;
	if (envVar === "OPENROUTER_API_KEY") return "openrouter-test";
	return envVar.toLowerCase().includes("api_key") ? `${provider.id}-test` : "sk-test";
}
function describeWebSearchProviderContracts(pluginId) {
	const providerIds = pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)?.webSearchProviderIds ?? [];
	let providerEntries;
	const resolveProviders = () => {
		if (providerEntries) return providerEntries;
		const publicArtifactProviders = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({ onlyPluginIds: [pluginId] });
		if (publicArtifactProviders) {
			providerEntries = publicArtifactProviders.map((provider) => ({
				pluginId: provider.pluginId,
				provider,
				credentialValue: resolveWebSearchCredentialValue(provider)
			}));
			return providerEntries;
		}
		providerEntries = resolveWebSearchProviderContractEntriesForPluginId(pluginId);
		return providerEntries;
	};
	describe(`${pluginId} web search provider contract registry load`, () => {
		it("loads bundled web search providers", () => {
			expect(resolveProviders().length).toBeGreaterThan(0);
		});
	});
	for (const providerId of providerIds) describe(`${pluginId}:${providerId} web search contract`, () => {
		installWebSearchProviderContractSuite({
			provider: () => {
				const entry = resolveProviders().find((entry) => entry.provider.id === providerId);
				if (!entry) throw new Error(`web search provider contract entry missing for ${pluginId}:${providerId}`);
				return entry.provider;
			},
			credentialValue: () => {
				const entry = resolveProviders().find((entry) => entry.provider.id === providerId);
				if (!entry) throw new Error(`web search provider contract entry missing for ${pluginId}:${providerId}`);
				return entry.credentialValue;
			}
		});
	});
}
//#endregion
export { EXPECTED_FALLBACKS, OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE, createCapturedThinkingConfigStream, createConfigWithFallbacks, createLegacyProviderConfig, describeAnthropicProviderRuntimeContract, describeCloudflareAiGatewayProviderDiscoveryContract, describeGithubCopilotProviderAuthContract, describeGithubCopilotProviderDiscoveryContract, describeGithubCopilotProviderRuntimeContract, describeGoogleProviderRuntimeContract, describeMinimaxProviderDiscoveryContract, describeModelStudioProviderDiscoveryContract, describeOpenAICodexProviderAuthContract, describeOpenAIProviderRuntimeContract, describeOpenRouterProviderRuntimeContract, describeProviderContracts, describeProviderWizardChoiceResolutionContract, describeProviderWizardModelPickerContract, describeProviderWizardSetupOptionsContract, describeSglangProviderDiscoveryContract, describeVeniceProviderRuntimeContract, describeVllmProviderDiscoveryContract, describeWebFetchProviderContracts, describeWebSearchProviderContracts, describeZAIProviderRuntimeContract, expectAugmentedCodexCatalog, expectCodexMissingAuthHint, expectDashscopeVideoTaskPoll, expectExplicitMusicGenerationCapabilities, expectExplicitVideoGenerationCapabilities, expectOpenClawLiveTranscriptMarker, expectPassthroughReplayPolicy, expectProviderOnboardAllowlistAlias, expectProviderOnboardMergedLegacyConfig, expectProviderOnboardPreservesPrimary, expectProviderOnboardPrimaryAndFallbacks, expectProviderOnboardPrimaryModel, expectSuccessfulDashscopeVideoResult, expectUnifiedModelCatalogEntries, expectUnifiedModelCatalogProviderRegistration, expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55, expectedOpenaiPluginCodexCatalogEntriesWithGpt55, importProviderRuntimeCatalogModule, installProviderPluginContractSuite, installWebFetchProviderContractSuite, installWebSearchProviderContractSuite, loadBundledPluginPublicSurface, loadBundledPluginPublicSurfaceSync, mockSuccessfulDashscopeVideoTask, normalizeTranscriptForMatch, resetDashscopeVideoProviderMocks, runRealtimeSttLiveTest, streamAudioForLiveTest, synthesizeElevenLabsLiveSpeech, waitForLiveExpectation };
