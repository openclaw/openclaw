import { i as upsertAuthProfile } from "./profiles-CV7WLKIX.js";
import { t as normalizeOptionalSecretInput } from "./normalize-secret-input-CZ08wtw1.js";
//#region src/plugins/provider-api-key-auth.ts
let providerApiKeyAuthRuntimePromise;
function loadProviderApiKeyAuthRuntime() {
	providerApiKeyAuthRuntimePromise ??= import("./provider-api-key-auth.runtime-CCUtT1Yx.js");
	return providerApiKeyAuthRuntimePromise;
}
function resolveStringOption(opts, optionKey) {
	return normalizeOptionalSecretInput(opts?.[optionKey]);
}
function resolveProfileId(params) {
	return params.profileId?.trim() || `${params.providerId}:default`;
}
function resolveProfileIds(params) {
	const explicit = Array.from(new Set((params.profileIds ?? []).map((value) => value.trim()).filter(Boolean)));
	if (explicit.length > 0) {return explicit;}
	return [resolveProfileId(params)];
}
async function applyApiKeyConfig(params) {
	const { applyAuthProfileConfig, applyPrimaryModel } = await loadProviderApiKeyAuthRuntime();
	let next = params.ctx.config;
	for (const profileId of params.profileIds) {next = applyAuthProfileConfig(next, {
		profileId,
		provider: profileId.split(":", 1)[0]?.trim() || params.providerId,
		mode: "api_key"
	});}
	if (params.applyConfig) {next = params.applyConfig(next);}
	return params.defaultModel ? applyPrimaryModel(next, params.defaultModel) : next;
}
function createProviderApiKeyAuthMethod(params) {
	return {
		id: params.methodId,
		label: params.label,
		hint: params.hint,
		kind: "api_key",
		wizard: params.wizard,
		run: async (ctx) => {
			const opts = ctx.opts;
			const flagValue = resolveStringOption(opts, params.optionKey);
			let capturedSecretInput;
			let capturedCredential = false;
			let capturedMode;
			const { buildApiKeyCredential, ensureApiKeyFromOptionEnvOrPrompt, normalizeApiKeyInput, validateApiKeyInput } = await loadProviderApiKeyAuthRuntime();
			await ensureApiKeyFromOptionEnvOrPrompt({
				token: flagValue ?? normalizeOptionalSecretInput(ctx.opts?.token),
				tokenProvider: flagValue ? params.providerId : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
				secretInputMode: ctx.allowSecretRefPrompt === false ? ctx.secretInputMode ?? "plaintext" : ctx.secretInputMode,
				config: ctx.config,
				expectedProviders: params.expectedProviders ?? [params.providerId],
				provider: params.providerId,
				envLabel: params.envVar,
				promptMessage: params.promptMessage,
				normalize: normalizeApiKeyInput,
				validate: validateApiKeyInput,
				prompter: ctx.prompter,
				noteMessage: params.noteMessage,
				noteTitle: params.noteTitle,
				setCredential: async (apiKey, mode) => {
					capturedSecretInput = apiKey;
					capturedCredential = true;
					capturedMode = mode;
				}
			});
			if (!capturedCredential) {throw new Error(`Missing API key input for provider "${params.providerId}".`);}
			const credentialInput = capturedSecretInput ?? "";
			return {
				profiles: resolveProfileIds(params).map((profileId) => ({
					profileId,
					credential: buildApiKeyCredential(profileId.split(":", 1)[0]?.trim() || params.providerId, credentialInput, params.metadata, capturedMode ? { secretInputMode: capturedMode } : void 0)
				})),
				...params.applyConfig ? { configPatch: params.applyConfig(ctx.config) } : {},
				...params.defaultModel ? { defaultModel: params.defaultModel } : {}
			};
		},
		runNonInteractive: async (ctx) => {
			const opts = ctx.opts;
			const resolved = await ctx.resolveApiKey({
				provider: params.providerId,
				flagValue: resolveStringOption(opts, params.optionKey),
				flagName: params.flagName,
				envVar: params.envVar,
				...params.allowProfile === false ? { allowProfile: false } : {}
			});
			if (!resolved) {return null;}
			const profileIds = resolveProfileIds(params);
			if (resolved.source !== "profile") {for (const profileId of profileIds) {
				const credential = ctx.toApiKeyCredential({
					provider: profileId.split(":", 1)[0]?.trim() || params.providerId,
					resolved,
					...params.metadata ? { metadata: params.metadata } : {}
				});
				if (!credential) return null;
				upsertAuthProfile({
					profileId,
					credential,
					agentDir: ctx.agentDir
				});
			}}
			return await applyApiKeyConfig({
				ctx,
				providerId: params.providerId,
				profileIds,
				defaultModel: params.defaultModel,
				applyConfig: params.applyConfig
			});
		}
	};
}
//#endregion
export { createProviderApiKeyAuthMethod as t };
