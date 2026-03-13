import { a as hasConfiguredSecretInput, l as normalizeSecretInputString, t as DEFAULT_SECRET_PROVIDER_ALIAS } from "./types.secrets-d7ZFrG7U.js";
//#region src/commands/onboard-search.ts
const SEARCH_PROVIDER_OPTIONS = [
	{
		value: "brave",
		label: "Brave Search",
		hint: "Structured results · country/language/time filters",
		envKeys: ["BRAVE_API_KEY"],
		placeholder: "BSA...",
		signupUrl: "https://brave.com/search/api/"
	},
	{
		value: "gemini",
		label: "Gemini (Google Search)",
		hint: "Google Search grounding · AI-synthesized",
		envKeys: ["GEMINI_API_KEY"],
		placeholder: "AIza...",
		signupUrl: "https://aistudio.google.com/apikey"
	},
	{
		value: "grok",
		label: "Grok (xAI)",
		hint: "xAI web-grounded responses",
		envKeys: ["XAI_API_KEY"],
		placeholder: "xai-...",
		signupUrl: "https://console.x.ai/"
	},
	{
		value: "kimi",
		label: "Kimi (Moonshot)",
		hint: "Moonshot web search",
		envKeys: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
		placeholder: "sk-...",
		signupUrl: "https://platform.moonshot.cn/"
	},
	{
		value: "perplexity",
		label: "Perplexity Search",
		hint: "Structured results · domain/country/language/time filters",
		envKeys: ["PERPLEXITY_API_KEY"],
		placeholder: "pplx-...",
		signupUrl: "https://www.perplexity.ai/settings/api"
	}
];
function hasKeyInEnv(entry) {
	return entry.envKeys.some((k) => Boolean(process.env[k]?.trim()));
}
function rawKeyValue(config, provider) {
	const search = config.tools?.web?.search;
	switch (provider) {
		case "brave": return search?.apiKey;
		case "gemini": return search?.gemini?.apiKey;
		case "grok": return search?.grok?.apiKey;
		case "kimi": return search?.kimi?.apiKey;
		case "perplexity": return search?.perplexity?.apiKey;
	}
}
/** Returns the plaintext key string, or undefined for SecretRefs/missing. */
function resolveExistingKey(config, provider) {
	return normalizeSecretInputString(rawKeyValue(config, provider));
}
/** Returns true if a key is configured (plaintext string or SecretRef). */
function hasExistingKey(config, provider) {
	return hasConfiguredSecretInput(rawKeyValue(config, provider));
}
/** Build an env-backed SecretRef for a search provider. */
function buildSearchEnvRef(provider) {
	const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === provider);
	const envVar = entry?.envKeys.find((k) => Boolean(process.env[k]?.trim())) ?? entry?.envKeys[0];
	if (!envVar) throw new Error(`No env var mapping for search provider "${provider}" in secret-input-mode=ref.`);
	return {
		source: "env",
		provider: DEFAULT_SECRET_PROVIDER_ALIAS,
		id: envVar
	};
}
/** Resolve a plaintext key into the appropriate SecretInput based on mode. */
function resolveSearchSecretInput(provider, key, secretInputMode) {
	if (secretInputMode === "ref") return buildSearchEnvRef(provider);
	return key;
}
function applySearchKey(config, provider, key) {
	const search = {
		...config.tools?.web?.search,
		provider,
		enabled: true
	};
	switch (provider) {
		case "brave":
			search.apiKey = key;
			break;
		case "gemini":
			search.gemini = {
				...search.gemini,
				apiKey: key
			};
			break;
		case "grok":
			search.grok = {
				...search.grok,
				apiKey: key
			};
			break;
		case "kimi":
			search.kimi = {
				...search.kimi,
				apiKey: key
			};
			break;
		case "perplexity":
			search.perplexity = {
				...search.perplexity,
				apiKey: key
			};
			break;
	}
	return {
		...config,
		tools: {
			...config.tools,
			web: {
				...config.tools?.web,
				search
			}
		}
	};
}
function applyProviderOnly(config, provider) {
	return {
		...config,
		tools: {
			...config.tools,
			web: {
				...config.tools?.web,
				search: {
					...config.tools?.web?.search,
					provider,
					enabled: true
				}
			}
		}
	};
}
function preserveDisabledState(original, result) {
	if (original.tools?.web?.search?.enabled !== false) return result;
	return {
		...result,
		tools: {
			...result.tools,
			web: {
				...result.tools?.web,
				search: {
					...result.tools?.web?.search,
					enabled: false
				}
			}
		}
	};
}
async function setupSearch(config, _runtime, prompter, opts) {
	await prompter.note([
		"Web search lets your agent look things up online.",
		"Choose a provider and paste your API key.",
		"Docs: https://docs.openclaw.ai/tools/web"
	].join("\n"), "Web search");
	const existingProvider = config.tools?.web?.search?.provider;
	const options = SEARCH_PROVIDER_OPTIONS.map((entry) => {
		const hint = hasExistingKey(config, entry.value) || hasKeyInEnv(entry) ? `${entry.hint} · configured` : entry.hint;
		return {
			value: entry.value,
			label: entry.label,
			hint
		};
	});
	const defaultProvider = (() => {
		if (existingProvider && SEARCH_PROVIDER_OPTIONS.some((e) => e.value === existingProvider)) return existingProvider;
		const detected = SEARCH_PROVIDER_OPTIONS.find((e) => hasExistingKey(config, e.value) || hasKeyInEnv(e));
		if (detected) return detected.value;
		return SEARCH_PROVIDER_OPTIONS[0].value;
	})();
	const choice = await prompter.select({
		message: "Search provider",
		options: [...options, {
			value: "__skip__",
			label: "Skip for now",
			hint: "Configure later with openclaw configure --section web"
		}],
		initialValue: defaultProvider
	});
	if (choice === "__skip__") return config;
	const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === choice);
	const existingKey = resolveExistingKey(config, choice);
	const keyConfigured = hasExistingKey(config, choice);
	const envAvailable = hasKeyInEnv(entry);
	if (opts?.quickstartDefaults && (keyConfigured || envAvailable)) return preserveDisabledState(config, existingKey ? applySearchKey(config, choice, existingKey) : applyProviderOnly(config, choice));
	if (opts?.secretInputMode === "ref") {
		if (keyConfigured) return preserveDisabledState(config, applyProviderOnly(config, choice));
		const ref = buildSearchEnvRef(choice);
		await prompter.note([
			"Secret references enabled — OpenClaw will store a reference instead of the API key.",
			`Env var: ${ref.id}${envAvailable ? " (detected)" : ""}.`,
			...envAvailable ? [] : [`Set ${ref.id} in the Gateway environment.`],
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
		return applySearchKey(config, choice, ref);
	}
	const key = (await prompter.text({
		message: keyConfigured ? `${entry.label} API key (leave blank to keep current)` : envAvailable ? `${entry.label} API key (leave blank to use env var)` : `${entry.label} API key`,
		placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder
	}))?.trim() ?? "";
	if (key) return applySearchKey(config, choice, resolveSearchSecretInput(choice, key, opts?.secretInputMode));
	if (existingKey) return preserveDisabledState(config, applySearchKey(config, choice, existingKey));
	if (keyConfigured || envAvailable) return preserveDisabledState(config, applyProviderOnly(config, choice));
	await prompter.note([
		"No API key stored — web_search won't work until a key is available.",
		`Get your key at: ${entry.signupUrl}`,
		"Docs: https://docs.openclaw.ai/tools/web"
	].join("\n"), "Web search");
	return {
		...config,
		tools: {
			...config.tools,
			web: {
				...config.tools?.web,
				search: {
					...config.tools?.web?.search,
					provider: choice
				}
			}
		}
	};
}
//#endregion
export { SEARCH_PROVIDER_OPTIONS, applySearchKey, hasExistingKey, hasKeyInEnv, resolveExistingKey, setupSearch };
