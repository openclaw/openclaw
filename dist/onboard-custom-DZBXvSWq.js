import { n as modelKey } from "./model-selection-normalize-B4tdZ1L4.js";
import "./model-selection-VRXWv5rs.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CrCOUFln.js";
import { r as fetchWithTimeout } from "./fetch-timeout-BxQNNg4F.js";
import { t as ensureApiKeyFromEnvOrPrompt } from "./provider-auth-input-BB3v7mkT.js";
import { a as buildOpenAiVerificationProbeRequest, d as resolveCustomProviderId, i as buildEndpointIdFromUrl, l as resolveCustomModelAliasError, n as applyCustomApiConfig, o as normalizeEndpointId, r as buildAnthropicVerificationProbeRequest, s as normalizeOptionalProviderApiKey, u as resolveCustomModelImageInputInference } from "./onboard-custom-config-6_fbioRX.js";
//#region src/commands/onboard-custom.ts
const VERIFY_TIMEOUT_MS = 3e4;
const COMPATIBILITY_OPTIONS = [
	{
		value: "openai",
		label: "OpenAI-compatible",
		hint: "Uses /chat/completions"
	},
	{
		value: "anthropic",
		label: "Anthropic-compatible",
		hint: "Uses /messages"
	},
	{
		value: "unknown",
		label: "Unknown (detect automatically)",
		hint: "Probes OpenAI then Anthropic endpoints"
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
		message: "API Base URL",
		initialValue: params.initialBaseUrl,
		placeholder: "https://api.example.com/v1",
		validate: (val) => {
			return URL.canParse(val) ? void 0 : "Please enter a valid URL (e.g. http://...)";
		}
	})).trim();
	const providerHint = buildEndpointIdFromUrl(baseUrl) || "custom";
	let apiKeyInput;
	const resolvedApiKey = await ensureApiKeyFromEnvOrPrompt({
		config: params.config,
		provider: providerHint,
		envLabel: "CUSTOM_API_KEY",
		promptMessage: "API Key (leave blank if not required)",
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
		message: "What would you like to change?",
		options: [
			{
				value: "baseUrl",
				label: "Change base URL"
			},
			{
				value: "model",
				label: "Change model"
			},
			{
				value: "both",
				label: "Change base URL and model"
			}
		]
	});
}
async function promptCustomApiModelId(prompter) {
	return (await prompter.text({
		message: "Model ID",
		placeholder: "e.g. llama3, claude-3-7-sonnet",
		validate: (val) => val.trim() ? void 0 : "Model ID is required"
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
		message: "Endpoint compatibility",
		options: COMPATIBILITY_OPTIONS.map((option) => ({
			value: option.value,
			label: option.label,
			hint: option.hint
		}))
	});
	let modelId = await promptCustomApiModelId(prompter);
	let compatibility = compatibilityChoice === "unknown" ? null : compatibilityChoice;
	while (true) {
		let verifiedFromProbe = false;
		if (!compatibility) {
			const probeSpinner = prompter.progress("Detecting endpoint type...");
			if ((await requestOpenAiVerification({
				baseUrl,
				apiKey: resolvedApiKey,
				modelId
			})).ok) {
				probeSpinner.stop("Detected OpenAI-compatible endpoint.");
				compatibility = "openai";
				verifiedFromProbe = true;
			} else if ((await requestAnthropicVerification({
				baseUrl,
				apiKey: resolvedApiKey,
				modelId
			})).ok) {
				probeSpinner.stop("Detected Anthropic-compatible endpoint.");
				compatibility = "anthropic";
				verifiedFromProbe = true;
			} else {
				probeSpinner.stop("Could not detect endpoint type.");
				await prompter.note("This endpoint did not respond to OpenAI or Anthropic style requests.", "Endpoint detection");
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
		const verifySpinner = prompter.progress("Verifying...");
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
			verifySpinner.stop("Verification successful.");
			break;
		}
		if (result.status !== void 0) verifySpinner.stop(`Verification failed: status ${result.status}`);
		else verifySpinner.stop(`Verification failed: ${formatVerificationError(result.error)}`);
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
		message: "Endpoint ID",
		initialValue: suggestedId,
		placeholder: "custom",
		validate: (value) => {
			if (!normalizeEndpointId(value)) return "Endpoint ID is required.";
		}
	});
	const aliasInput = await prompter.text({
		message: "Model alias (optional)",
		placeholder: "e.g. local, ollama",
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
		message: "Does this model support image input?",
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
	if (result.providerIdRenamedFrom && result.providerId) await prompter.note(`Endpoint ID "${result.providerIdRenamedFrom}" already exists for a different base URL. Using "${result.providerId}".`, "Endpoint ID");
	runtime.log(`Configured custom provider: ${result.providerId}/${result.modelId}`);
	return result;
}
//#endregion
export { promptCustomApiConfig as t };
