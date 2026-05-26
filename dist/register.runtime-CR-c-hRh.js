import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as parseDurationMs } from "./parse-duration-961Oqdwr.js";
import { n as listProfilesForProvider } from "./profile-list-1dJMPDMe.js";
import { n as suggestOAuthProfileIdForLegacyDefault } from "./repair-CzDi-eiN.js";
import { a as upsertAuthProfile } from "./profiles-Bj_dclxz.js";
import { c as resolveClaudeThinkingProfile, l as cloneFirstTemplateModel } from "./provider-model-shared-D-slKnZa.js";
import { n as validateAnthropicSetupToken, t as buildTokenProfileId } from "./provider-auth-token-UPsyWe0E.js";
import { t as applyAuthProfileConfig } from "./provider-auth-helpers-Hp3hWZu2.js";
import { t as createProviderApiKeyAuthMethod } from "./provider-api-key-auth-DaaaGg6p.js";
import "./provider-auth-D5QGE8z6.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./cli-runtime-BuPrSAIi.js";
import { a as fetchClaudeUsage } from "./provider-usage-DQntMfSF.js";
import { n as readClaudeCliCredentialsForSetup, r as readClaudeCliCredentialsForSetupNonInteractive, t as readClaudeCliCredentialsForRuntime } from "./cli-auth-seam-0lbzWXCP.js";
import { n as CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS, r as CLAUDE_CLI_DEFAULT_MODEL_REF, t as CLAUDE_CLI_BACKEND_ID } from "./cli-constants-DOBc9V80.js";
import "./cli-shared-DuRAlDAW.js";
import { t as buildAnthropicCliBackend } from "./cli-backend-BDU6UI9e.js";
import { t as buildAnthropicCliMigrationResult } from "./cli-migration-BJQsc9PB.js";
import { n as normalizeAnthropicProviderConfigForProvider, t as applyAnthropicConfigDefaults } from "./config-defaults-BVzWUUo-.js";
import { t as anthropicMediaUnderstandingProvider } from "./media-understanding-provider-Se38-DRL.js";
import { t as buildReplayPolicy } from "./replay-policy-BUmMrBSH.js";
import { l as wrapAnthropicProviderStream } from "./stream-wrappers-DsqXTMSp.js";
//#region extensions/anthropic/register.runtime.ts
const PROVIDER_ID = "anthropic";
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-opus-4-7";
const ANTHROPIC_OPUS_47_MODEL_ID = "claude-opus-4-7";
const ANTHROPIC_OPUS_47_DOT_MODEL_ID = "claude-opus-4.7";
const ANTHROPIC_OPUS_47_CONTEXT_TOKENS = 1048576;
const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS = [
	ANTHROPIC_OPUS_46_MODEL_ID,
	ANTHROPIC_OPUS_46_DOT_MODEL_ID,
	"claude-opus-4-5",
	"claude-opus-4.5"
];
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"];
const ANTHROPIC_SONNET_46_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = "claude-sonnet-4.6";
const ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS = ["claude-sonnet-4-5", "claude-sonnet-4.5"];
const ANTHROPIC_MODERN_MODEL_PREFIXES = [
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-opus-4-5",
	"claude-sonnet-4-5",
	"claude-haiku-4-5"
];
const ANTHROPIC_SETUP_TOKEN_NOTE_LINES = [
	"Anthropic setup-token auth is supported in OpenClaw.",
	"OpenClaw prefers Claude CLI reuse when it is available on the host.",
	"Anthropic staff told us this OpenClaw path is allowed again.",
	`If you want a direct API billing path instead, use ${formatCliCommand("openclaw models auth login --provider anthropic --method api-key --set-default")} or ${formatCliCommand("openclaw models auth login --provider anthropic --method cli --set-default")}.`
];
const CLAUDE_CLI_CANONICAL_ALLOWLIST_REFS = CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS.map((ref) => ref.startsWith(`claude-cli/`) ? `anthropic/${ref.slice(CLAUDE_CLI_BACKEND_ID.length + 1)}` : ref);
const CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF = CLAUDE_CLI_DEFAULT_MODEL_REF.startsWith(`claude-cli/`) ? `anthropic/${CLAUDE_CLI_DEFAULT_MODEL_REF.slice(CLAUDE_CLI_BACKEND_ID.length + 1)}` : CLAUDE_CLI_DEFAULT_MODEL_REF;
function normalizeAnthropicSetupTokenInput(value) {
	return value.replaceAll(/\s+/g, "").trim();
}
function resolveAnthropicSetupTokenProfileId(rawProfileId) {
	if (typeof rawProfileId === "string") {
		const trimmed = rawProfileId.trim();
		if (trimmed.length > 0) {
			if (trimmed.startsWith(`${PROVIDER_ID}:`)) return trimmed;
			return buildTokenProfileId({
				provider: PROVIDER_ID,
				name: trimmed
			});
		}
	}
	return `${PROVIDER_ID}:default`;
}
function resolveAnthropicSetupTokenExpiry(rawExpiresIn) {
	if (typeof rawExpiresIn !== "string" || rawExpiresIn.trim().length === 0) return;
	return Date.now() + parseDurationMs(rawExpiresIn.trim(), { defaultUnit: "d" });
}
async function runAnthropicSetupTokenAuth(ctx) {
	const token = (typeof ctx.opts?.token === "string" && ctx.opts.token.trim().length > 0 ? normalizeAnthropicSetupTokenInput(ctx.opts.token) : void 0) ?? normalizeAnthropicSetupTokenInput(await ctx.prompter.text({
		message: "Paste Anthropic setup-token",
		validate: (value) => validateAnthropicSetupToken(normalizeAnthropicSetupTokenInput(value))
	}));
	const tokenError = validateAnthropicSetupToken(token);
	if (tokenError) throw new Error(tokenError);
	const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts?.tokenProfileId);
	const expires = resolveAnthropicSetupTokenExpiry(ctx.opts?.tokenExpiresIn);
	return {
		profiles: [{
			profileId,
			credential: {
				type: "token",
				provider: PROVIDER_ID,
				token,
				...expires ? { expires } : {}
			}
		}],
		defaultModel: DEFAULT_ANTHROPIC_MODEL,
		notes: [...ANTHROPIC_SETUP_TOKEN_NOTE_LINES]
	};
}
async function runAnthropicSetupTokenNonInteractive(ctx) {
	const rawToken = typeof ctx.opts.token === "string" ? normalizeAnthropicSetupTokenInput(ctx.opts.token) : "";
	const tokenError = validateAnthropicSetupToken(rawToken);
	if (tokenError) {
		ctx.runtime.error(["Anthropic setup-token auth requires --token with a valid setup-token.", tokenError].join("\n"));
		ctx.runtime.exit(1);
		return null;
	}
	const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts.tokenProfileId);
	const expires = resolveAnthropicSetupTokenExpiry(ctx.opts.tokenExpiresIn);
	upsertAuthProfile({
		profileId,
		credential: {
			type: "token",
			provider: PROVIDER_ID,
			token: rawToken,
			...expires ? { expires } : {}
		},
		agentDir: ctx.agentDir
	});
	ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[0]);
	ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[1]);
	const withProfile = applyAuthProfileConfig(ctx.config, {
		profileId,
		provider: PROVIDER_ID,
		mode: "token"
	});
	const existingModelConfig = withProfile.agents?.defaults?.model && typeof withProfile.agents.defaults.model === "object" ? withProfile.agents.defaults.model : {};
	return {
		...withProfile,
		agents: {
			...withProfile.agents,
			defaults: {
				...withProfile.agents?.defaults,
				model: {
					...existingModelConfig,
					primary: DEFAULT_ANTHROPIC_MODEL
				}
			}
		}
	};
}
function resolveAnthropic46ForwardCompatModel(params) {
	const trimmedModelId = params.ctx.modelId.trim();
	const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
	if (trimmedModelId !== lower) return;
	if (!(lower === params.dashModelId || lower === params.dotModelId || lower.startsWith(`${params.dashModelId}-`) || lower.startsWith(`${params.dotModelId}-`))) return;
	const templateIds = [];
	if (lower.startsWith(params.dashModelId)) templateIds.push(lower.replace(params.dashModelId, params.dashTemplateId));
	if (lower.startsWith(params.dotModelId)) templateIds.push(lower.replace(params.dotModelId, params.dotTemplateId));
	templateIds.push(...params.fallbackTemplateIds);
	return cloneFirstTemplateModel({
		providerId: PROVIDER_ID,
		modelId: trimmedModelId,
		templateIds,
		ctx: params.ctx,
		patch: normalizeLowercaseStringOrEmpty(params.ctx.provider) === "claude-cli" ? { provider: CLAUDE_CLI_BACKEND_ID } : void 0
	});
}
function resolveAnthropicForwardCompatModel(ctx) {
	return resolveAnthropic46ForwardCompatModel({
		ctx,
		dashModelId: ANTHROPIC_OPUS_47_MODEL_ID,
		dotModelId: ANTHROPIC_OPUS_47_DOT_MODEL_ID,
		dashTemplateId: ANTHROPIC_OPUS_46_MODEL_ID,
		dotTemplateId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
		fallbackTemplateIds: ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS
	}) ?? resolveAnthropic46ForwardCompatModel({
		ctx,
		dashModelId: ANTHROPIC_OPUS_46_MODEL_ID,
		dotModelId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
		dashTemplateId: "claude-opus-4-5",
		dotTemplateId: "claude-opus-4.5",
		fallbackTemplateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS
	}) ?? resolveAnthropic46ForwardCompatModel({
		ctx,
		dashModelId: ANTHROPIC_SONNET_46_MODEL_ID,
		dotModelId: ANTHROPIC_SONNET_46_DOT_MODEL_ID,
		dashTemplateId: "claude-sonnet-4-5",
		dotTemplateId: "claude-sonnet-4.5",
		fallbackTemplateIds: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS
	});
}
function isAnthropicOpus47Model(modelId) {
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	return normalized.startsWith(ANTHROPIC_OPUS_47_MODEL_ID) || normalized.startsWith(ANTHROPIC_OPUS_47_DOT_MODEL_ID);
}
function hasConfiguredModelContextOverride(config, provider, modelId) {
	const providers = config?.models?.providers;
	if (!providers || typeof providers !== "object") return false;
	const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
	const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
	for (const [providerId, providerConfig] of Object.entries(providers)) {
		if (normalizeLowercaseStringOrEmpty(providerId) !== normalizedProvider) continue;
		if (!Array.isArray(providerConfig?.models)) continue;
		for (const model of providerConfig.models) {
			if (normalizeLowercaseStringOrEmpty(typeof model?.id === "string" ? model.id : "") !== normalizedModelId) continue;
			if (typeof model?.contextTokens === "number" && model.contextTokens > 0 || typeof model?.contextWindow === "number" && model.contextWindow > 0) return true;
		}
	}
	return false;
}
function applyAnthropicOpus47ContextWindow(params) {
	if (!isAnthropicOpus47Model(params.modelId)) return;
	if (hasConfiguredModelContextOverride(params.config, params.provider, params.modelId)) return;
	const nextContextWindow = Math.max(params.model.contextWindow ?? 0, ANTHROPIC_OPUS_47_CONTEXT_TOKENS);
	const nextContextTokens = typeof params.model.contextTokens === "number" ? Math.max(params.model.contextTokens, ANTHROPIC_OPUS_47_CONTEXT_TOKENS) : ANTHROPIC_OPUS_47_CONTEXT_TOKENS;
	if (nextContextWindow === params.model.contextWindow && nextContextTokens === params.model.contextTokens) return;
	return {
		...params.model,
		contextWindow: nextContextWindow,
		contextTokens: nextContextTokens
	};
}
function matchesAnthropicModernModel(modelId) {
	const lower = normalizeLowercaseStringOrEmpty(modelId);
	return ANTHROPIC_MODERN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
function buildAnthropicAuthDoctorHint(params) {
	const legacyProfileId = params.profileId ?? "anthropic:default";
	const suggested = suggestOAuthProfileIdForLegacyDefault({
		cfg: params.config,
		store: params.store,
		provider: PROVIDER_ID,
		legacyProfileId
	});
	if (!suggested || suggested === legacyProfileId) return "";
	const storeOauthProfiles = listProfilesForProvider(params.store, PROVIDER_ID).filter((id) => params.store.profiles[id]?.type === "oauth").join(", ");
	const cfgMode = params.config?.auth?.profiles?.[legacyProfileId]?.mode;
	const cfgProvider = params.config?.auth?.profiles?.[legacyProfileId]?.provider;
	return [
		"Doctor hint (for GitHub issue):",
		`- provider: ${PROVIDER_ID}`,
		`- config: ${legacyProfileId}${cfgProvider || cfgMode ? ` (provider=${cfgProvider ?? "?"}, mode=${cfgMode ?? "?"})` : ""}`,
		`- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
		`- suggested profile: ${suggested}`,
		`Fix: run "${formatCliCommand("openclaw doctor --yes")}"`
	].join("\n");
}
function resolveClaudeCliSyntheticAuth() {
	const credential = readClaudeCliCredentialsForRuntime();
	if (!credential) return;
	return credential.type === "oauth" ? {
		apiKey: credential.access,
		source: "Claude CLI native auth",
		mode: "oauth",
		expiresAt: credential.expires
	} : {
		apiKey: credential.token,
		source: "Claude CLI native auth",
		mode: "token",
		expiresAt: credential.expires
	};
}
async function runAnthropicCliMigration(ctx) {
	const credential = readClaudeCliCredentialsForSetup();
	if (!credential) throw new Error(["Claude CLI is not authenticated on this host.", `Run ${formatCliCommand("claude auth login")} first, then re-run this setup.`].join("\n"));
	return buildAnthropicCliMigrationResult(ctx.config, credential);
}
async function runAnthropicCliMigrationNonInteractive(ctx) {
	const credential = readClaudeCliCredentialsForSetupNonInteractive();
	if (!credential) {
		ctx.runtime.error(["Auth choice \"anthropic-cli\" requires Claude CLI auth on this host.", `Run ${formatCliCommand("claude auth login")} first.`].join("\n"));
		ctx.runtime.exit(1);
		return null;
	}
	const result = buildAnthropicCliMigrationResult(ctx.config, credential);
	const currentDefaults = ctx.config.agents?.defaults;
	const currentModel = currentDefaults?.model;
	const currentFallbacks = currentModel && typeof currentModel === "object" && "fallbacks" in currentModel ? currentModel.fallbacks : void 0;
	const migratedModel = result.configPatch?.agents?.defaults?.model;
	const migratedFallbacks = migratedModel && typeof migratedModel === "object" && "fallbacks" in migratedModel ? migratedModel.fallbacks : void 0;
	const nextFallbacks = Array.isArray(migratedFallbacks) ? migratedFallbacks : currentFallbacks;
	return {
		...ctx.config,
		...result.configPatch,
		agents: {
			...ctx.config.agents,
			...result.configPatch?.agents,
			defaults: {
				...currentDefaults,
				...result.configPatch?.agents?.defaults,
				model: {
					...Array.isArray(nextFallbacks) ? { fallbacks: nextFallbacks } : {},
					primary: result.defaultModel
				}
			}
		}
	};
}
function buildAnthropicProvider() {
	const providerId = "anthropic";
	const defaultAnthropicModel = DEFAULT_ANTHROPIC_MODEL;
	return {
		id: providerId,
		label: "Anthropic",
		docsPath: "/providers/models",
		hookAliases: [CLAUDE_CLI_BACKEND_ID],
		envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
		oauthProfileIdRepairs: [{
			legacyProfileId: "anthropic:default",
			promptLabel: "Anthropic"
		}],
		auth: [
			{
				id: "cli",
				label: "Claude CLI",
				hint: "Reuse a local Claude CLI login and run Anthropic models through the Claude CLI runtime",
				kind: "custom",
				wizard: {
					choiceId: "anthropic-cli",
					choiceLabel: "Anthropic Claude CLI",
					choiceHint: "Reuse a local Claude CLI login on this host",
					assistantPriority: -20,
					groupId: "anthropic",
					groupLabel: "Anthropic",
					groupHint: "Claude CLI + API key",
					modelAllowlist: {
						allowedKeys: [...CLAUDE_CLI_CANONICAL_ALLOWLIST_REFS],
						initialSelections: [CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF],
						message: "Claude CLI models"
					}
				},
				run: async (ctx) => await runAnthropicCliMigration(ctx),
				runNonInteractive: async (ctx) => await runAnthropicCliMigrationNonInteractive({
					config: ctx.config,
					runtime: ctx.runtime,
					agentDir: ctx.agentDir
				})
			},
			{
				id: "setup-token",
				label: "Anthropic setup-token",
				hint: "Manual bearer token path",
				kind: "token",
				wizard: {
					choiceId: "setup-token",
					choiceLabel: "Anthropic setup-token",
					choiceHint: "Manual token path",
					assistantPriority: 40,
					groupId: "anthropic",
					groupLabel: "Anthropic",
					groupHint: "Claude CLI + API key + token"
				},
				run: async (ctx) => await runAnthropicSetupTokenAuth(ctx),
				runNonInteractive: async (ctx) => await runAnthropicSetupTokenNonInteractive(ctx)
			},
			createProviderApiKeyAuthMethod({
				providerId,
				methodId: "api-key",
				label: "Anthropic API key",
				hint: "Direct Anthropic API key",
				optionKey: "anthropicApiKey",
				flagName: "--anthropic-api-key",
				envVar: "ANTHROPIC_API_KEY",
				promptMessage: "Enter Anthropic API key",
				defaultModel: defaultAnthropicModel,
				expectedProviders: ["anthropic"],
				wizard: {
					choiceId: "apiKey",
					choiceLabel: "Anthropic API key",
					groupId: "anthropic",
					groupLabel: "Anthropic",
					groupHint: "Claude CLI + API key"
				}
			})
		],
		normalizeConfig: ({ provider, providerConfig }) => normalizeAnthropicProviderConfigForProvider({
			provider,
			providerConfig
		}),
		applyConfigDefaults: ({ config, env }) => applyAnthropicConfigDefaults({
			config,
			env
		}),
		resolveDynamicModel: (ctx) => {
			const model = resolveAnthropicForwardCompatModel(ctx);
			if (!model) return;
			return applyAnthropicOpus47ContextWindow({
				config: ctx.config,
				provider: ctx.provider,
				modelId: ctx.modelId,
				model
			}) ?? model;
		},
		normalizeResolvedModel: (ctx) => applyAnthropicOpus47ContextWindow(ctx),
		resolveSyntheticAuth: ({ provider }) => normalizeLowercaseStringOrEmpty(provider) === "claude-cli" ? resolveClaudeCliSyntheticAuth() : void 0,
		buildReplayPolicy,
		isModernModelRef: ({ modelId }) => matchesAnthropicModernModel(modelId),
		resolveReasoningOutputMode: () => "native",
		resolveThinkingProfile: ({ modelId }) => resolveClaudeThinkingProfile(modelId),
		wrapStreamFn: wrapAnthropicProviderStream,
		resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
		fetchUsageSnapshot: async (ctx) => await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
		isCacheTtlEligible: () => true,
		buildAuthDoctorHint: (ctx) => buildAnthropicAuthDoctorHint({
			config: ctx.config,
			store: ctx.store,
			profileId: ctx.profileId
		})
	};
}
function registerAnthropicPlugin(api) {
	api.registerCliBackend(buildAnthropicCliBackend());
	api.registerProvider(buildAnthropicProvider());
	api.registerMediaUnderstandingProvider(anthropicMediaUnderstandingProvider);
}
//#endregion
export { registerAnthropicPlugin as n, buildAnthropicProvider as t };
