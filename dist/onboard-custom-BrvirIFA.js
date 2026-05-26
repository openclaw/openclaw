import { n as modelKey } from "./model-selection-normalize-CBfQo-Fd.js";
import "./model-selection-P-81eBKx.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { r as fetchWithTimeout } from "./fetch-timeout-CptH2le9.js";
import { t as ensureApiKeyFromEnvOrPrompt } from "./provider-auth-input-DMNIEm93.js";
import { n as t } from "./i18n-CWNhN747.js";
import { a as buildOpenAiVerificationProbeRequest, d as resolveCustomProviderId, i as buildEndpointIdFromUrl, l as resolveCustomModelAliasError, n as applyCustomApiConfig, o as normalizeEndpointId, r as buildAnthropicVerificationProbeRequest, s as normalizeOptionalProviderApiKey, u as resolveCustomModelImageInputInference } from "./onboard-custom-config-Bi3WrYnQ.js";
//#region src/commands/onboard-custom.ts
const VERIFY_TIMEOUT_MS = 3e4;
const COMPATIBILITY_OPTIONS = [
	{
		value: "openai",
		labelKey: "wizard.customProvider.compatibilityOpenAi",
		hintKey: "wizard.customProvider.compatibilityOpenAiHint"
	},
	{
		value: "anthropic",
		labelKey: "wizard.customProvider.compatibilityAnthropic",
		hintKey: "wizard.customProvider.compatibilityAnthropicHint"
	},
	{
		value: "unknown",
		labelKey: "wizard.customProvider.compatibilityUnknown",
		hintKey: "wizard.customProvider.compatibilityUnknownHint"
	}
];
function formatVerificationError(error) {
	if (!error) return "unknown error";
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return "unknown error";
	}
}
async function requestVerification(params) {
	try {
		const res = await fetchWithTimeout(params.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...params.headers
			},
			body: JSON.stringify(params.body)
		}, VERIFY_TIMEOUT_MS);
		return {
			ok: res.ok,
			status: res.status
		};
	} catch (error) {
		return {
			ok: false,
			error
		};
	}
}
async function requestOpenAiVerification(params) {
	return await requestVerification(buildOpenAiVerificationProbeRequest(params));
}
async function requestAnthropicVerification(params) {
	return await requestVerification(buildAnthropicVerificationProbeRequest(params));
}
async function promptBaseUrlAndKey(params) {
	const baseUrl = (await params.prompter.text({
		message: t("wizard.customProvider.apiBaseUrl"),
		initialValue: params.initialBaseUrl,
		placeholder: "https://api.example.com/v1",
		validate: (val) => {
			return URL.canParse(val) ? void 0 : t("wizard.customProvider.validUrl");
		}
	})).trim();
	const providerHint = buildEndpointIdFromUrl(baseUrl) || "custom";
	let apiKeyInput;
	const resolvedApiKey = await ensureApiKeyFromEnvOrPrompt({
		config: params.config,
		provider: providerHint,
		envLabel: "CUSTOM_API_KEY",
		promptMessage: t("wizard.customProvider.apiKeyPrompt"),
		normalize: normalizeSecretInput,
		validate: () => void 0,
		prompter: params.prompter,
		secretInputMode: params.secretInputMode,
		setCredential: async (apiKey) => {
			apiKeyInput = apiKey;
		}
	});
	return {
		baseUrl,
		apiKey: normalizeOptionalProviderApiKey(apiKeyInput),
		resolvedApiKey: normalizeSecretInput(resolvedApiKey)
	};
}
async function promptCustomApiRetryChoice(prompter) {
	return await prompter.select({
		message: t("wizard.customProvider.retryChoice"),
		options: [
			{
				value: "baseUrl",
				label: t("wizard.customProvider.changeBaseUrl")
			},
			{
				value: "model",
				label: t("wizard.customProvider.changeModel")
			},
			{
				value: "both",
				label: t("wizard.customProvider.changeBaseUrlAndModel")
			}
		]
	});
}
async function promptCustomApiModelId(prompter) {
	return (await prompter.text({
		message: t("wizard.customProvider.modelId"),
		placeholder: t("wizard.customProvider.modelIdPlaceholder"),
		validate: (val) => val.trim() ? void 0 : t("wizard.customProvider.modelIdRequired")
	})).trim();
}
async function applyCustomApiRetryChoice(params) {
	let { baseUrl, apiKey, resolvedApiKey, modelId } = params.current;
	if (params.retryChoice === "baseUrl" || params.retryChoice === "both") {
		const retryInput = await promptBaseUrlAndKey({
			prompter: params.prompter,
			config: params.config,
			secretInputMode: params.secretInputMode,
			initialBaseUrl: baseUrl
		});
		baseUrl = retryInput.baseUrl;
		apiKey = retryInput.apiKey;
		resolvedApiKey = retryInput.resolvedApiKey;
	}
	if (params.retryChoice === "model" || params.retryChoice === "both") modelId = await promptCustomApiModelId(params.prompter);
	return {
		baseUrl,
		apiKey,
		resolvedApiKey,
		modelId
	};
}
async function promptCustomApiConfig(params) {
	const { prompter, runtime, config } = params;
	const baseInput = await promptBaseUrlAndKey({
		prompter,
		config,
		secretInputMode: params.secretInputMode
	});
	let baseUrl = baseInput.baseUrl;
	let apiKey = baseInput.apiKey;
	let resolvedApiKey = baseInput.resolvedApiKey;
	const compatibilityChoice = await prompter.select({
		message: t("wizard.customProvider.compatibility"),
		options: COMPATIBILITY_OPTIONS.map((option) => ({
			value: option.value,
			label: t(option.labelKey),
			hint: t(option.hintKey)
		}))
	});
	let modelId = await promptCustomApiModelId(prompter);
	let compatibility = compatibilityChoice === "unknown" ? null : compatibilityChoice;
	while (true) {
		let verifiedFromProbe = false;
		if (!compatibility) {
			const probeSpinner = prompter.progress(t("wizard.customProvider.detectionProgress"));
			if ((await requestOpenAiVerification({
				baseUrl,
				apiKey: resolvedApiKey,
				modelId
			})).ok) {
				probeSpinner.stop(t("wizard.customProvider.detectedOpenAi"));
				compatibility = "openai";
				verifiedFromProbe = true;
			} else if ((await requestAnthropicVerification({
				baseUrl,
				apiKey: resolvedApiKey,
				modelId
			})).ok) {
				probeSpinner.stop(t("wizard.customProvider.detectedAnthropic"));
				compatibility = "anthropic";
				verifiedFromProbe = true;
			} else {
				probeSpinner.stop(t("wizard.customProvider.detectionFailed"));
				await prompter.note(t("wizard.customProvider.detectionFailedNote"), t("wizard.customProvider.detectionNoteTitle"));
				const retryChoice = await promptCustomApiRetryChoice(prompter);
				({baseUrl, apiKey, resolvedApiKey, modelId} = await applyCustomApiRetryChoice({
					prompter,
					config,
					secretInputMode: params.secretInputMode,
					retryChoice,
					current: {
						baseUrl,
						apiKey,
						resolvedApiKey,
						modelId
					}
				}));
				continue;
			}
		}
		if (verifiedFromProbe) break;
		const verifySpinner = prompter.progress(t("wizard.customProvider.verifying"));
		const result = compatibility === "anthropic" ? await requestAnthropicVerification({
			baseUrl,
			apiKey: resolvedApiKey,
			modelId
		}) : await requestOpenAiVerification({
			baseUrl,
			apiKey: resolvedApiKey,
			modelId
		});
		if (result.ok) {
			verifySpinner.stop(t("wizard.customProvider.verificationSuccessful"));
			break;
		}
		if (result.status !== void 0) verifySpinner.stop(t("wizard.customProvider.verificationFailedStatus", { status: result.status }));
		else verifySpinner.stop(t("wizard.customProvider.verificationFailedError", { error: formatVerificationError(result.error) }));
		const retryChoice = await promptCustomApiRetryChoice(prompter);
		({baseUrl, apiKey, resolvedApiKey, modelId} = await applyCustomApiRetryChoice({
			prompter,
			config,
			secretInputMode: params.secretInputMode,
			retryChoice,
			current: {
				baseUrl,
				apiKey,
				resolvedApiKey,
				modelId
			}
		}));
		if (compatibilityChoice === "unknown") compatibility = null;
	}
	const suggestedId = buildEndpointIdFromUrl(baseUrl);
	const providerIdInput = await prompter.text({
		message: t("wizard.customProvider.endpointId"),
		initialValue: suggestedId,
		placeholder: "custom",
		validate: (value) => {
			if (!normalizeEndpointId(value)) return t("wizard.customProvider.endpointIdRequired");
		}
	});
	const aliasInput = await prompter.text({
		message: t("wizard.customProvider.modelAlias"),
		placeholder: t("wizard.customProvider.modelAliasPlaceholder"),
		initialValue: "",
		validate: (value) => {
			return resolveCustomModelAliasError({
				raw: value,
				cfg: config,
				modelRef: modelKey(resolveCustomProviderId({
					config,
					baseUrl,
					providerId: providerIdInput
				}).providerId, modelId)
			});
		}
	});
	const imageInputInference = resolveCustomModelImageInputInference(modelId);
	const supportsImageInput = imageInputInference.confidence === "known" ? imageInputInference.supportsImageInput : await prompter.confirm({
		message: t("wizard.customProvider.imageInput"),
		initialValue: imageInputInference.supportsImageInput
	});
	const result = applyCustomApiConfig({
		config,
		baseUrl,
		modelId,
		compatibility: compatibility ?? "openai",
		apiKey,
		providerId: providerIdInput,
		alias: aliasInput,
		supportsImageInput
	});
	if (result.providerIdRenamedFrom && result.providerId) await prompter.note(t("wizard.customProvider.endpointIdRenamed", {
		from: result.providerIdRenamedFrom,
		to: result.providerId
	}), t("wizard.customProvider.endpointIdTitle"));
	runtime.log(`Configured custom provider: ${result.providerId}/${result.modelId}`);
	return result;
}
//#endregion
export { promptCustomApiConfig as t };
