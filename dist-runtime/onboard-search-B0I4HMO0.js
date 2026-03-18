import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import "./theme-CL08MjAq.js";
import "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./utils-BiUV1eIQ.js";
import { n as resolvePluginWebSearchProviders } from "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import { a as hasConfiguredSecretInput, o as init_types_secrets, t as DEFAULT_SECRET_PROVIDER_ALIAS, u as normalizeSecretInputString } from "./types.secrets-Cu0Lz6pi.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./ip-Cdtea-sx.js";
import "./mime-h80iV1FL.js";
import { t as enablePluginInConfig } from "./enable-Fw1VqrSH.js";
//#region src/commands/onboard-search.ts
init_types_secrets();
const SEARCH_PROVIDER_IDS = [
	"brave",
	"firecrawl",
	"gemini",
	"grok",
	"kimi",
	"perplexity"
];
function isSearchProvider(value) {
	return SEARCH_PROVIDER_IDS.includes(value);
}
function hasSearchProviderId(provider) {
	return isSearchProvider(provider.id);
}
const SEARCH_PROVIDER_OPTIONS = resolvePluginWebSearchProviders({ bundledAllowlistCompat: true }).filter(hasSearchProviderId).map((provider) => ({
	value: provider.id,
	label: provider.label,
	hint: provider.hint,
	envKeys: provider.envVars,
	placeholder: provider.placeholder,
	signupUrl: provider.signupUrl
}));
function hasKeyInEnv(entry) {
	return entry.envKeys.some((k) => Boolean(process.env[k]?.trim()));
}
function rawKeyValue(config, provider) {
	const search = config.tools?.web?.search;
	return resolvePluginWebSearchProviders({
		config,
		bundledAllowlistCompat: true
	}).find((candidate) => candidate.id === provider)?.getCredentialValue(search);
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
	const entry = resolvePluginWebSearchProviders({
		config,
		bundledAllowlistCompat: true
	}).find((candidate) => candidate.id === provider);
	if (entry) entry.setCredentialValue(search, key);
	const next = {
		...config,
		tools: {
			...config.tools,
			web: {
				...config.tools?.web,
				search
			}
		}
	};
	if (provider !== "firecrawl") return next;
	return enablePluginInConfig(next, "firecrawl").config;
}
function applyProviderOnly(config, provider) {
	const next = {
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
	if (provider !== "firecrawl") return next;
	return enablePluginInConfig(next, "firecrawl").config;
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
