import { $ as resolveEnvApiKey, Ot as encodeJsonPointerToken, St as resolveSecretRefString, an as isValidFileSecretRefId, m as resolveAllowlistModelKey, ni as DEFAULT_PROVIDER, on as resolveDefaultSecretProviderAlias } from "./model-selection-DILdVnl8.js";
import { t as PROVIDER_ENV_VARS } from "./provider-env-vars-Dsu3ddZk.js";

//#region src/commands/auth-choice.api-key.ts
const DEFAULT_KEY_PREVIEW = {
	head: 4,
	tail: 4
};
function normalizeApiKeyInput(raw) {
	const trimmed = String(raw ?? "").trim();
	if (!trimmed) return "";
	const assignmentMatch = trimmed.match(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
	const valuePart = assignmentMatch ? assignmentMatch[1].trim() : trimmed;
	const unquoted = valuePart.length >= 2 && (valuePart.startsWith("\"") && valuePart.endsWith("\"") || valuePart.startsWith("'") && valuePart.endsWith("'") || valuePart.startsWith("`") && valuePart.endsWith("`")) ? valuePart.slice(1, -1) : valuePart;
	return (unquoted.endsWith(";") ? unquoted.slice(0, -1) : unquoted).trim();
}
const validateApiKeyInput = (value) => normalizeApiKeyInput(value).length > 0 ? void 0 : "Required";
function formatApiKeyPreview(raw, opts = {}) {
	const trimmed = raw.trim();
	if (!trimmed) return "…";
	const head = opts.head ?? DEFAULT_KEY_PREVIEW.head;
	const tail = opts.tail ?? DEFAULT_KEY_PREVIEW.tail;
	if (trimmed.length <= head + tail) {
		const shortHead = Math.min(2, trimmed.length);
		const shortTail = Math.min(2, trimmed.length - shortHead);
		if (shortTail <= 0) return `${trimmed.slice(0, shortHead)}…`;
		return `${trimmed.slice(0, shortHead)}…${trimmed.slice(-shortTail)}`;
	}
	return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}

//#endregion
//#region src/commands/model-allowlist.ts
function ensureModelAllowlistEntry(params) {
	const rawModelRef = params.modelRef.trim();
	if (!rawModelRef) return params.cfg;
	const models = { ...params.cfg.agents?.defaults?.models };
	const keySet = new Set([rawModelRef]);
	const canonicalKey = resolveAllowlistModelKey(rawModelRef, params.defaultProvider ?? DEFAULT_PROVIDER);
	if (canonicalKey) keySet.add(canonicalKey);
	for (const key of keySet) models[key] = { ...models[key] };
	return {
		...params.cfg,
		agents: {
			...params.cfg.agents,
			defaults: {
				...params.cfg.agents?.defaults,
				models
			}
		}
	};
}

//#endregion
//#region src/commands/auth-choice.default-model.ts
async function applyDefaultModelChoice(params) {
	if (params.setDefaultModel) {
		const next = params.applyDefaultConfig(params.config);
		if (params.noteDefault) await params.prompter.note(`Default model set to ${params.noteDefault}`, "Model configured");
		return { config: next };
	}
	const nextWithModel = ensureModelAllowlistEntry({
		cfg: params.applyProviderConfig(params.config),
		modelRef: params.defaultModel
	});
	await params.noteAgentModel(params.defaultModel);
	return {
		config: nextWithModel,
		agentModelOverride: params.defaultModel
	};
}

//#endregion
//#region src/commands/auth-choice.apply-helpers.ts
const ENV_SOURCE_LABEL_RE = /(?:^|:\s)([A-Z][A-Z0-9_]*)$/;
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
function formatErrorMessage(error) {
	if (error instanceof Error && typeof error.message === "string" && error.message.trim()) return error.message;
	return String(error);
}
function extractEnvVarFromSourceLabel(source) {
	return ENV_SOURCE_LABEL_RE.exec(source.trim())?.[1];
}
function resolveDefaultProviderEnvVar(provider) {
	return PROVIDER_ENV_VARS[provider]?.find((candidate) => candidate.trim().length > 0);
}
function resolveDefaultFilePointerId(provider) {
	return `/providers/${encodeJsonPointerToken(provider)}/apiKey`;
}
function resolveRefFallbackInput(params) {
	const fallbackEnvVar = params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider);
	if (!fallbackEnvVar) throw new Error(`No default environment variable mapping found for provider "${params.provider}". Set a provider-specific env var, or re-run onboarding in an interactive terminal to configure a ref.`);
	const value = process.env[fallbackEnvVar]?.trim();
	if (!value) throw new Error(`Environment variable "${fallbackEnvVar}" is required for --secret-input-mode ref in non-interactive onboarding.`);
	return {
		ref: {
			source: "env",
			provider: resolveDefaultSecretProviderAlias(params.config, "env", { preferFirstProviderForSource: true }),
			id: fallbackEnvVar
		},
		resolvedValue: value
	};
}
async function resolveApiKeyRefForOnboarding(params) {
	const defaultEnvVar = params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider) ?? "";
	const defaultFilePointer = resolveDefaultFilePointerId(params.provider);
	let sourceChoice = "env";
	while (true) {
		const source = await params.prompter.select({
			message: "Where is this API key stored?",
			initialValue: sourceChoice,
			options: [{
				value: "env",
				label: "Environment variable",
				hint: "Reference a variable from your runtime environment"
			}, {
				value: "provider",
				label: "Configured secret provider",
				hint: "Use a configured file or exec secret provider"
			}]
		}) === "provider" ? "provider" : "env";
		sourceChoice = source;
		if (source === "env") {
			const envVarRaw = await params.prompter.text({
				message: "Environment variable name",
				initialValue: defaultEnvVar || void 0,
				placeholder: "OPENAI_API_KEY",
				validate: (value) => {
					const candidate = value.trim();
					if (!ENV_SECRET_REF_ID_RE.test(candidate)) return "Use an env var name like \"OPENAI_API_KEY\" (uppercase letters, numbers, underscores).";
					if (!process.env[candidate]?.trim()) return `Environment variable "${candidate}" is missing or empty in this session.`;
				}
			});
			const envCandidate = String(envVarRaw ?? "").trim();
			const envVar = envCandidate && ENV_SECRET_REF_ID_RE.test(envCandidate) ? envCandidate : defaultEnvVar;
			if (!envVar) throw new Error(`No valid environment variable name provided for provider "${params.provider}".`);
			const ref = {
				source: "env",
				provider: resolveDefaultSecretProviderAlias(params.config, "env", { preferFirstProviderForSource: true }),
				id: envVar
			};
			const resolvedValue = await resolveSecretRefString(ref, {
				config: params.config,
				env: process.env
			});
			await params.prompter.note(`Validated environment variable ${envVar}. OpenClaw will store a reference, not the key value.`, "Reference validated");
			return {
				ref,
				resolvedValue
			};
		}
		const externalProviders = Object.entries(params.config.secrets?.providers ?? {}).filter(([, provider]) => provider?.source === "file" || provider?.source === "exec");
		if (externalProviders.length === 0) {
			await params.prompter.note("No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable.", "No providers configured");
			continue;
		}
		const defaultProvider = resolveDefaultSecretProviderAlias(params.config, "file", { preferFirstProviderForSource: true });
		const selectedProvider = await params.prompter.select({
			message: "Select secret provider",
			initialValue: externalProviders.find(([providerName]) => providerName === defaultProvider)?.[0] ?? externalProviders[0]?.[0],
			options: externalProviders.map(([providerName, provider]) => ({
				value: providerName,
				label: providerName,
				hint: provider?.source === "exec" ? "Exec provider" : "File provider"
			}))
		});
		const providerEntry = params.config.secrets?.providers?.[selectedProvider];
		if (!providerEntry || providerEntry.source !== "file" && providerEntry.source !== "exec") {
			await params.prompter.note(`Provider "${selectedProvider}" is not a file/exec provider.`, "Invalid provider");
			continue;
		}
		const idPrompt = providerEntry.source === "file" ? "Secret id (JSON pointer for json mode, or 'value' for singleValue mode)" : "Secret id for the exec provider";
		const idDefault = providerEntry.source === "file" ? providerEntry.mode === "singleValue" ? "value" : defaultFilePointer : `${params.provider}/apiKey`;
		const idRaw = await params.prompter.text({
			message: idPrompt,
			initialValue: idDefault,
			placeholder: providerEntry.source === "file" ? "/providers/openai/apiKey" : "openai/api-key",
			validate: (value) => {
				const candidate = value.trim();
				if (!candidate) return "Secret id cannot be empty.";
				if (providerEntry.source === "file" && providerEntry.mode !== "singleValue" && !isValidFileSecretRefId(candidate)) return "Use an absolute JSON pointer like \"/providers/openai/apiKey\".";
				if (providerEntry.source === "file" && providerEntry.mode === "singleValue" && candidate !== "value") return "singleValue mode expects id \"value\".";
			}
		});
		const id = String(idRaw ?? "").trim() || idDefault;
		const ref = {
			source: providerEntry.source,
			provider: selectedProvider,
			id
		};
		try {
			const resolvedValue = await resolveSecretRefString(ref, {
				config: params.config,
				env: process.env
			});
			await params.prompter.note(`Validated ${providerEntry.source} reference ${selectedProvider}:${id}. OpenClaw will store a reference, not the key value.`, "Reference validated");
			return {
				ref,
				resolvedValue
			};
		} catch (error) {
			await params.prompter.note([
				`Could not validate provider reference ${selectedProvider}:${id}.`,
				formatErrorMessage(error),
				"Check your provider configuration and try again."
			].join("\n"), "Reference check failed");
		}
	}
}
function createAuthChoiceAgentModelNoter(params) {
	return async (model) => {
		if (!params.agentId) return;
		await params.prompter.note(`Default model set to ${model} for agent "${params.agentId}".`, "Model configured");
	};
}
function createAuthChoiceModelStateBridge(bindings) {
	return {
		get config() {
			return bindings.getConfig();
		},
		set config(config) {
			bindings.setConfig(config);
		},
		get agentModelOverride() {
			return bindings.getAgentModelOverride();
		},
		set agentModelOverride(model) {
			bindings.setAgentModelOverride(model);
		}
	};
}
function createAuthChoiceDefaultModelApplier(params, state) {
	const noteAgentModel = createAuthChoiceAgentModelNoter(params);
	return async (options) => {
		const applied = await applyDefaultModelChoice({
			config: state.config,
			setDefaultModel: params.setDefaultModel,
			noteAgentModel,
			prompter: params.prompter,
			...options
		});
		state.config = applied.config;
		state.agentModelOverride = applied.agentModelOverride ?? state.agentModelOverride;
	};
}
function normalizeTokenProviderInput(tokenProvider) {
	return String(tokenProvider ?? "").trim().toLowerCase() || void 0;
}
function normalizeSecretInputModeInput(secretInputMode) {
	const normalized = String(secretInputMode ?? "").trim().toLowerCase();
	if (normalized === "plaintext" || normalized === "ref") return normalized;
}
async function resolveSecretInputModeForEnvSelection(params) {
	if (params.explicitMode) return params.explicitMode;
	if (typeof params.prompter.select !== "function") return "plaintext";
	return await params.prompter.select({
		message: "How do you want to provide this API key?",
		initialValue: "plaintext",
		options: [{
			value: "plaintext",
			label: "Paste API key now",
			hint: "Stores the key directly in OpenClaw config"
		}, {
			value: "ref",
			label: "Use secret reference",
			hint: "Stores a reference to env or configured external secret providers"
		}]
	}) === "ref" ? "ref" : "plaintext";
}
async function maybeApplyApiKeyFromOption(params) {
	const tokenProvider = normalizeTokenProviderInput(params.tokenProvider);
	const expectedProviders = params.expectedProviders.map((provider) => normalizeTokenProviderInput(provider)).filter((provider) => Boolean(provider));
	if (!params.token || !tokenProvider || !expectedProviders.includes(tokenProvider)) return;
	const apiKey = params.normalize(params.token);
	await params.setCredential(apiKey, params.secretInputMode);
	return apiKey;
}
async function ensureApiKeyFromOptionEnvOrPrompt(params) {
	const optionApiKey = await maybeApplyApiKeyFromOption({
		token: params.token,
		tokenProvider: params.tokenProvider,
		secretInputMode: params.secretInputMode,
		expectedProviders: params.expectedProviders,
		normalize: params.normalize,
		setCredential: params.setCredential
	});
	if (optionApiKey) return optionApiKey;
	if (params.noteMessage) await params.prompter.note(params.noteMessage, params.noteTitle);
	return await ensureApiKeyFromEnvOrPrompt({
		config: params.config,
		provider: params.provider,
		envLabel: params.envLabel,
		promptMessage: params.promptMessage,
		normalize: params.normalize,
		validate: params.validate,
		prompter: params.prompter,
		secretInputMode: params.secretInputMode,
		setCredential: params.setCredential
	});
}
async function ensureApiKeyFromEnvOrPrompt(params) {
	const selectedMode = await resolveSecretInputModeForEnvSelection({
		prompter: params.prompter,
		explicitMode: params.secretInputMode
	});
	const envKey = resolveEnvApiKey(params.provider);
	if (selectedMode === "ref") {
		if (typeof params.prompter.select !== "function") {
			const fallback = resolveRefFallbackInput({
				config: params.config,
				provider: params.provider,
				preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : void 0
			});
			await params.setCredential(fallback.ref, selectedMode);
			return fallback.resolvedValue;
		}
		const resolved = await resolveApiKeyRefForOnboarding({
			provider: params.provider,
			config: params.config,
			prompter: params.prompter,
			preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : void 0
		});
		await params.setCredential(resolved.ref, selectedMode);
		return resolved.resolvedValue;
	}
	if (envKey && selectedMode === "plaintext") {
		if (await params.prompter.confirm({
			message: `Use existing ${params.envLabel} (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
			initialValue: true
		})) {
			await params.setCredential(envKey.apiKey, selectedMode);
			return envKey.apiKey;
		}
	}
	const key = await params.prompter.text({
		message: params.promptMessage,
		validate: params.validate
	});
	const apiKey = params.normalize(String(key ?? ""));
	await params.setCredential(apiKey, selectedMode);
	return apiKey;
}

//#endregion
export { ensureApiKeyFromOptionEnvOrPrompt as a, applyDefaultModelChoice as c, validateApiKeyInput as d, ensureApiKeyFromEnvOrPrompt as i, ensureModelAllowlistEntry as l, createAuthChoiceDefaultModelApplier as n, normalizeSecretInputModeInput as o, createAuthChoiceModelStateBridge as r, normalizeTokenProviderInput as s, createAuthChoiceAgentModelNoter as t, normalizeApiKeyInput as u };