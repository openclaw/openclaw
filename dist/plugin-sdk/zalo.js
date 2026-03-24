import "./github-copilot-token-DsS-4gYS.js";
import { on as DEFAULT_ACCOUNT_ID, sn as normalizeAccountId } from "./query-expansion-DoSmaYz3.js";
import "./utils-DbcH71uP.js";
import "./paths-Dmn791zP.js";
import { $i as readStringParam, $t as evaluateSenderGroupAccess, Bi as isValidFileSecretRefId, C as issuePairingChallenge, D as createReplyPrefixOptions, E as createTypingCallbacks, F as extractToolSend, Fr as isNormalizedSenderAllowed, Gi as normalizeResolvedSecretInputString, Hi as ENV_SECRET_REF_ID_RE, Ii as MarkdownConfigSchema, Ir as createAccountListHelpers, Ji as setAccountEnabledInConfigSection, Ki as normalizeSecretInputString, Li as SECRET_PROVIDER_ALIAS_PATTERN, Lt as createDedupeCache, N as resolveDmGroupAccessWithLists, O as logTypingFailure, Pi as formatPairingApproveHint, Pr as formatAllowFromLowercase, Ri as formatExecSecretRefIdValidationMessage, Rn as chunkTextByBreakResolver, Rt as pruneMapToMaxSize, Ui as hasConfiguredSecretInput, Vi as resolveDefaultSecretProviderAlias, Wi as isValidEnvSecretRefId, Zi as jsonResult, _ as requestBodyErrorToText, b as waitForAbortSignal, en as resolveDefaultGroupPolicy, g as readJsonBodyWithLimit, gi as encodeJsonPointerToken, hi as resolveSecretRefString, nn as warnMissingProviderGroupPolicyFallbackOnce, qi as deleteAccountFromConfigSection, tn as resolveOpenProviderRuntimeGroupPolicy, y as registerPluginHttpRoute, zi as isValidExecSecretRefId } from "./model-auth-B5HP0Y0M.js";
import "./fetch-BIseQ86E.js";
import { z } from "zod";
//#region src/channels/plugins/directory-config-helpers.ts
function resolveDirectoryQuery(query) {
	return query?.trim().toLowerCase() || "";
}
function resolveDirectoryLimit(limit) {
	return typeof limit === "number" && limit > 0 ? limit : void 0;
}
function applyDirectoryQueryAndLimit(ids, params) {
	const q = resolveDirectoryQuery(params.query);
	const limit = resolveDirectoryLimit(params.limit);
	const filtered = ids.filter((id) => q ? id.toLowerCase().includes(q) : true);
	return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}
function toDirectoryEntries(kind, ids) {
	return ids.map((id) => ({
		kind,
		id
	}));
}
function collectDirectoryIdsFromEntries(params) {
	return (params.entries ?? []).map((entry) => String(entry).trim()).filter((entry) => Boolean(entry) && entry !== "*").map((entry) => {
		const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
		return typeof normalized === "string" ? normalized.trim() : "";
	}).filter(Boolean);
}
function dedupeDirectoryIds(ids) {
	return Array.from(new Set(ids));
}
function listDirectoryUserEntriesFromAllowFrom(params) {
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(dedupeDirectoryIds(collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeId
	})), params));
}
//#endregion
//#region src/channels/plugins/config-schema.ts
const AllowFromEntrySchema = z.union([z.string(), z.number()]);
z.array(AllowFromEntrySchema).optional();
function buildChannelConfigSchema(schema) {
	const schemaWithJson = schema;
	if (typeof schemaWithJson.toJSONSchema === "function") return { schema: schemaWithJson.toJSONSchema({
		target: "draft-07",
		unrepresentable: "any"
	}) };
	return { schema: {
		type: "object",
		additionalProperties: true
	} };
}
//#endregion
//#region src/secrets/provider-env-vars.ts
const PROVIDER_ENV_VARS = {
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_API_KEY"],
	google: ["GEMINI_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_API_KEY"],
	moonshot: ["MOONSHOT_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY", "KIMICODE_API_KEY"],
	synthetic: ["SYNTHETIC_API_KEY"],
	venice: ["VENICE_API_KEY"],
	zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
	xiaomi: ["XIAOMI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
	litellm: ["LITELLM_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	huggingface: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
	qianfan: ["QIANFAN_API_KEY"],
	xai: ["XAI_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	kilocode: ["KILOCODE_API_KEY"],
	modelstudio: ["MODELSTUDIO_API_KEY"],
	volcengine: ["VOLCANO_ENGINE_API_KEY"],
	byteplus: ["BYTEPLUS_API_KEY"]
};
const EXTRA_PROVIDER_AUTH_ENV_VARS = [
	"VOYAGE_API_KEY",
	"GROQ_API_KEY",
	"DEEPGRAM_API_KEY",
	"CEREBRAS_API_KEY",
	"NVIDIA_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"CHUTES_OAUTH_TOKEN",
	"CHUTES_API_KEY",
	"QWEN_OAUTH_TOKEN",
	"QWEN_PORTAL_API_KEY",
	"MINIMAX_OAUTH_TOKEN",
	"OLLAMA_API_KEY",
	"VLLM_API_KEY"
];
const KNOWN_SECRET_ENV_VARS = [...new Set(Object.values(PROVIDER_ENV_VARS).flatMap((keys) => keys))];
[...new Set([...KNOWN_SECRET_ENV_VARS, ...EXTRA_PROVIDER_AUTH_ENV_VARS])];
//#endregion
//#region src/commands/auth-choice.apply-helpers.ts
function formatErrorMessage(error) {
	if (error instanceof Error && typeof error.message === "string" && error.message.trim()) return error.message;
	return String(error);
}
function resolveDefaultProviderEnvVar(provider) {
	return PROVIDER_ENV_VARS[provider]?.find((candidate) => candidate.trim().length > 0);
}
function resolveDefaultFilePointerId(provider) {
	return `/providers/${encodeJsonPointerToken(provider)}/apiKey`;
}
async function promptSecretRefForOnboarding(params) {
	const defaultEnvVar = params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider) ?? "";
	const defaultFilePointer = resolveDefaultFilePointerId(params.provider);
	let sourceChoice = "env";
	while (true) {
		const source = await params.prompter.select({
			message: params.copy?.sourceMessage ?? "Where is this API key stored?",
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
				message: params.copy?.envVarMessage ?? "Environment variable name",
				initialValue: defaultEnvVar || void 0,
				placeholder: params.copy?.envVarPlaceholder ?? "OPENAI_API_KEY",
				validate: (value) => {
					const candidate = value.trim();
					if (!isValidEnvSecretRefId(candidate)) return params.copy?.envVarFormatError ?? "Use an env var name like \"OPENAI_API_KEY\" (uppercase letters, numbers, underscores).";
					if (!process.env[candidate]?.trim()) return params.copy?.envVarMissingError?.(candidate) ?? `Environment variable "${candidate}" is missing or empty in this session.`;
				}
			});
			const envCandidate = String(envVarRaw ?? "").trim();
			const envVar = envCandidate && isValidEnvSecretRefId(envCandidate) ? envCandidate : defaultEnvVar;
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
			await params.prompter.note(params.copy?.envValidatedMessage?.(envVar) ?? `Validated environment variable ${envVar}. OpenClaw will store a reference, not the key value.`, "Reference validated");
			return {
				ref,
				resolvedValue
			};
		}
		const externalProviders = Object.entries(params.config.secrets?.providers ?? {}).filter(([, provider]) => provider?.source === "file" || provider?.source === "exec");
		if (externalProviders.length === 0) {
			await params.prompter.note(params.copy?.noProvidersMessage ?? "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable.", "No providers configured");
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
				if (providerEntry.source === "exec" && !isValidExecSecretRefId(candidate)) return formatExecSecretRefIdValidationMessage();
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
			await params.prompter.note(params.copy?.providerValidatedMessage?.(selectedProvider, id, providerEntry.source) ?? `Validated ${providerEntry.source} reference ${selectedProvider}:${id}. OpenClaw will store a reference, not the key value.`, "Reference validated");
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
async function resolveSecretInputModeForEnvSelection(params) {
	if (params.explicitMode) return params.explicitMode;
	if (typeof params.prompter.select !== "function") return "plaintext";
	return await params.prompter.select({
		message: params.copy?.modeMessage ?? "How do you want to provide this API key?",
		initialValue: "plaintext",
		options: [{
			value: "plaintext",
			label: params.copy?.plaintextLabel ?? "Paste API key now",
			hint: params.copy?.plaintextHint ?? "Stores the key directly in OpenClaw config"
		}, {
			value: "ref",
			label: params.copy?.refLabel ?? "Use external secret provider",
			hint: params.copy?.refHint ?? "Stores a reference to env or configured external secret providers"
		}]
	}) === "ref" ? "ref" : "plaintext";
}
//#endregion
//#region src/plugin-sdk/onboarding.ts
async function promptAccountId$1(params) {
	const existingIds = params.listAccountIds(params.cfg);
	const initial = params.currentId?.trim() || params.defaultAccountId || "default";
	const choice = await params.prompter.select({
		message: `${params.label} account`,
		options: [...existingIds.map((id) => ({
			value: id,
			label: id === "default" ? "default (primary)" : id
		})), {
			value: "__new__",
			label: "Add a new account"
		}],
		initialValue: initial
	});
	if (choice !== "__new__") return normalizeAccountId(choice);
	const entered = await params.prompter.text({
		message: `New ${params.label} account id`,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const normalized = normalizeAccountId(String(entered));
	if (String(entered).trim() !== normalized) await params.prompter.note(`Normalized account id to "${normalized}".`, `${params.label} account`);
	return normalized;
}
//#endregion
//#region src/channels/plugins/setup-helpers.ts
function channelHasAccounts(cfg, channelKey) {
	const base = cfg.channels?.[channelKey];
	return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}
function shouldStoreNameInAccounts(params) {
	if (params.alwaysUseAccounts) return true;
	if (params.accountId !== "default") return true;
	return channelHasAccounts(params.cfg, params.channelKey);
}
function applyAccountNameToChannelSection(params) {
	const trimmed = params.name?.trim();
	if (!trimmed) return params.cfg;
	const accountId = normalizeAccountId(params.accountId);
	const baseConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
	if (!shouldStoreNameInAccounts({
		cfg: params.cfg,
		channelKey: params.channelKey,
		accountId,
		alwaysUseAccounts: params.alwaysUseAccounts
	}) && accountId === "default") {
		const safeBase = base ?? {};
		return {
			...params.cfg,
			channels: {
				...params.cfg.channels,
				[params.channelKey]: {
					...safeBase,
					name: trimmed
				}
			}
		};
	}
	const baseAccounts = base?.accounts ?? {};
	const existingAccount = baseAccounts[accountId] ?? {};
	const baseWithoutName = accountId === "default" ? (({ name: _ignored, ...rest }) => rest)(base ?? {}) : base ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...baseWithoutName,
				accounts: {
					...baseAccounts,
					[accountId]: {
						...existingAccount,
						name: trimmed
					}
				}
			}
		}
	};
}
function migrateBaseNameToDefaultAccount(params) {
	if (params.alwaysUseAccounts) return params.cfg;
	const base = params.cfg.channels?.[params.channelKey];
	const baseName = base?.name?.trim();
	if (!baseName) return params.cfg;
	const accounts = { ...base?.accounts };
	const defaultAccount = accounts["default"] ?? {};
	if (!defaultAccount.name) accounts[DEFAULT_ACCOUNT_ID] = {
		...defaultAccount,
		name: baseName
	};
	const { name: _ignored, ...rest } = base ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...rest,
				accounts
			}
		}
	};
}
function applySetupAccountConfigPatch(params) {
	return patchScopedAccountConfig({
		cfg: params.cfg,
		channelKey: params.channelKey,
		accountId: params.accountId,
		patch: params.patch
	});
}
function patchScopedAccountConfig(params) {
	const accountId = normalizeAccountId(params.accountId);
	const channelConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof channelConfig === "object" && channelConfig ? channelConfig : void 0;
	const ensureChannelEnabled = params.ensureChannelEnabled ?? true;
	const ensureAccountEnabled = params.ensureAccountEnabled ?? ensureChannelEnabled;
	const patch = params.patch;
	const accountPatch = params.accountPatch ?? patch;
	if (accountId === "default") return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...base,
				...ensureChannelEnabled ? { enabled: true } : {},
				...patch
			}
		}
	};
	const accounts = base?.accounts ?? {};
	const existingAccount = accounts[accountId] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...base,
				...ensureChannelEnabled ? { enabled: true } : {},
				accounts: {
					...accounts,
					[accountId]: {
						...existingAccount,
						...ensureAccountEnabled ? { enabled: typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true } : {},
						...accountPatch
					}
				}
			}
		}
	};
}
//#endregion
//#region src/channels/plugins/onboarding/helpers.ts
const promptAccountId = async (params) => {
	return await promptAccountId$1(params);
};
function addWildcardAllowFrom(allowFrom) {
	const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
	if (!next.includes("*")) next.push("*");
	return next;
}
function mergeAllowFromEntries(current, additions) {
	const merged = [...current ?? [], ...additions].map((v) => String(v).trim()).filter(Boolean);
	return [...new Set(merged)];
}
async function resolveAccountIdForConfigure(params) {
	const override = params.accountOverride?.trim();
	let accountId = override ? normalizeAccountId(override) : params.defaultAccountId;
	if (params.shouldPromptAccountIds && !override) accountId = await promptAccountId({
		cfg: params.cfg,
		prompter: params.prompter,
		label: params.label,
		currentId: accountId,
		listAccountIds: params.listAccountIds,
		defaultAccountId: params.defaultAccountId
	});
	return accountId;
}
function patchTopLevelChannelConfig(params) {
	const channelConfig = params.cfg.channels?.[params.channel] ?? {};
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channel]: {
				...channelConfig,
				...params.enabled ? { enabled: true } : {},
				...params.patch
			}
		}
	};
}
function setTopLevelChannelDmPolicyWithAllowFrom(params) {
	const channelConfig = params.cfg.channels?.[params.channel] ?? {};
	const existingAllowFrom = params.getAllowFrom?.(params.cfg) ?? channelConfig.allowFrom ?? void 0;
	const allowFrom = params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : void 0;
	return patchTopLevelChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		patch: {
			dmPolicy: params.dmPolicy,
			...allowFrom ? { allowFrom } : {}
		}
	});
}
function buildSingleChannelSecretPromptState(params) {
	return {
		accountConfigured: params.accountConfigured,
		hasConfigToken: params.hasConfigToken,
		canUseEnv: params.allowEnv && Boolean(params.envValue?.trim()) && !params.hasConfigToken
	};
}
async function promptSingleChannelToken(params) {
	const promptToken = async () => String(await params.prompter.text({
		message: params.inputPrompt,
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
	if (params.canUseEnv) {
		if (await params.prompter.confirm({
			message: params.envPrompt,
			initialValue: true
		})) return {
			useEnv: true,
			token: null
		};
		return {
			useEnv: false,
			token: await promptToken()
		};
	}
	if (params.hasConfigToken && params.accountConfigured) {
		if (await params.prompter.confirm({
			message: params.keepPrompt,
			initialValue: true
		})) return {
			useEnv: false,
			token: null
		};
	}
	return {
		useEnv: false,
		token: await promptToken()
	};
}
async function runSingleChannelSecretStep(params) {
	const promptState = buildSingleChannelSecretPromptState({
		accountConfigured: params.accountConfigured,
		hasConfigToken: params.hasConfigToken,
		allowEnv: params.allowEnv,
		envValue: params.envValue
	});
	if (!promptState.accountConfigured && params.onMissingConfigured) await params.onMissingConfigured();
	const result = await promptSingleChannelSecretInput({
		cfg: params.cfg,
		prompter: params.prompter,
		providerHint: params.providerHint,
		credentialLabel: params.credentialLabel,
		secretInputMode: params.secretInputMode,
		accountConfigured: promptState.accountConfigured,
		canUseEnv: promptState.canUseEnv,
		hasConfigToken: promptState.hasConfigToken,
		envPrompt: params.envPrompt,
		keepPrompt: params.keepPrompt,
		inputPrompt: params.inputPrompt,
		preferredEnvVar: params.preferredEnvVar
	});
	if (result.action === "use-env") return {
		cfg: params.applyUseEnv ? await params.applyUseEnv(params.cfg) : params.cfg,
		action: result.action,
		resolvedValue: params.envValue?.trim() || void 0
	};
	if (result.action === "set") return {
		cfg: params.applySet ? await params.applySet(params.cfg, result.value, result.resolvedValue) : params.cfg,
		action: result.action,
		resolvedValue: result.resolvedValue
	};
	return {
		cfg: params.cfg,
		action: result.action
	};
}
async function promptSingleChannelSecretInput(params) {
	if (await resolveSecretInputModeForEnvSelection({
		prompter: params.prompter,
		explicitMode: params.secretInputMode,
		copy: {
			modeMessage: `How do you want to provide this ${params.credentialLabel}?`,
			plaintextLabel: `Enter ${params.credentialLabel}`,
			plaintextHint: "Stores the credential directly in OpenClaw config",
			refLabel: "Use external secret provider",
			refHint: "Stores a reference to env or configured external secret providers"
		}
	}) === "plaintext") {
		const plainResult = await promptSingleChannelToken({
			prompter: params.prompter,
			accountConfigured: params.accountConfigured,
			canUseEnv: params.canUseEnv,
			hasConfigToken: params.hasConfigToken,
			envPrompt: params.envPrompt,
			keepPrompt: params.keepPrompt,
			inputPrompt: params.inputPrompt
		});
		if (plainResult.useEnv) return { action: "use-env" };
		if (plainResult.token) return {
			action: "set",
			value: plainResult.token,
			resolvedValue: plainResult.token
		};
		return { action: "keep" };
	}
	if (params.hasConfigToken && params.accountConfigured) {
		if (await params.prompter.confirm({
			message: params.keepPrompt,
			initialValue: true
		})) return { action: "keep" };
	}
	const resolved = await promptSecretRefForOnboarding({
		provider: params.providerHint,
		config: params.cfg,
		prompter: params.prompter,
		preferredEnvVar: params.preferredEnvVar,
		copy: {
			sourceMessage: `Where is this ${params.credentialLabel} stored?`,
			envVarPlaceholder: params.preferredEnvVar ?? "OPENCLAW_SECRET",
			envVarFormatError: "Use an env var name like \"OPENCLAW_SECRET\" (uppercase letters, numbers, underscores).",
			noProvidersMessage: "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable."
		}
	});
	return {
		action: "set",
		value: resolved.ref,
		resolvedValue: resolved.resolvedValue
	};
}
//#endregion
//#region src/channels/plugins/pairing-message.ts
const PAIRING_APPROVED_MESSAGE = "✅ OpenClaw access approved. Send a message to start chatting.";
//#endregion
//#region src/plugin-sdk/secret-input-schema.ts
function buildSecretInputSchema() {
	const providerSchema = z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN, "Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: \"default\").");
	return z.union([z.string(), z.discriminatedUnion("source", [
		z.object({
			source: z.literal("env"),
			provider: providerSchema,
			id: z.string().regex(ENV_SECRET_REF_ID_RE, "Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: \"OPENAI_API_KEY\").")
		}),
		z.object({
			source: z.literal("file"),
			provider: providerSchema,
			id: z.string().refine(isValidFileSecretRefId, "File secret reference id must be an absolute JSON pointer (example: \"/providers/openai/apiKey\"), or \"value\" for singleValue mode.")
		}),
		z.object({
			source: z.literal("exec"),
			provider: providerSchema,
			id: z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage())
		})
	])]);
}
//#endregion
//#region src/plugins/config-schema.ts
function error(message) {
	return {
		success: false,
		error: { issues: [{
			path: [],
			message
		}] }
	};
}
function emptyPluginConfigSchema() {
	return {
		safeParse(value) {
			if (value === void 0) return {
				success: true,
				data: void 0
			};
			if (!value || typeof value !== "object" || Array.isArray(value)) return error("expected config object");
			if (Object.keys(value).length > 0) return error("config must be empty");
			return {
				success: true,
				data: value
			};
		},
		jsonSchema: {
			type: "object",
			additionalProperties: false,
			properties: {}
		}
	};
}
//#endregion
//#region src/plugin-sdk/command-auth.ts
function resolveDirectDmAuthorizationOutcome(params) {
	if (params.isGroup) return "allowed";
	if (params.dmPolicy === "disabled") return "disabled";
	if (params.dmPolicy !== "open" && !params.senderAllowedForCommands) return "unauthorized";
	return "allowed";
}
async function resolveSenderCommandAuthorizationWithRuntime(params) {
	return resolveSenderCommandAuthorization({
		...params,
		shouldComputeCommandAuthorized: params.runtime.shouldComputeCommandAuthorized,
		resolveCommandAuthorizedFromAuthorizers: params.runtime.resolveCommandAuthorizedFromAuthorizers
	});
}
async function resolveSenderCommandAuthorization(params) {
	const shouldComputeAuth = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
	const storeAllowFrom = !params.isGroup && params.dmPolicy !== "allowlist" && (params.dmPolicy !== "open" || shouldComputeAuth) ? await params.readAllowFromStore().catch(() => []) : [];
	const access = resolveDmGroupAccessWithLists({
		isGroup: params.isGroup,
		dmPolicy: params.dmPolicy,
		groupPolicy: "allowlist",
		allowFrom: params.configuredAllowFrom,
		groupAllowFrom: params.configuredGroupAllowFrom ?? [],
		storeAllowFrom,
		isSenderAllowed: (allowFrom) => params.isSenderAllowed(params.senderId, allowFrom)
	});
	const effectiveAllowFrom = access.effectiveAllowFrom;
	const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
	const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
	const senderAllowedForCommands = params.isSenderAllowed(params.senderId, params.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom);
	const ownerAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveAllowFrom);
	const groupAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveGroupAllowFrom);
	return {
		shouldComputeAuth,
		effectiveAllowFrom,
		effectiveGroupAllowFrom,
		senderAllowedForCommands,
		commandAuthorized: shouldComputeAuth ? params.resolveCommandAuthorizedFromAuthorizers({
			useAccessGroups,
			authorizers: [{
				configured: effectiveAllowFrom.length > 0,
				allowed: ownerAllowedForCommands
			}, {
				configured: effectiveGroupAllowFrom.length > 0,
				allowed: groupAllowedForCommands
			}]
		}) : void 0
	};
}
//#endregion
//#region src/plugin-sdk/config-paths.ts
function resolveChannelAccountConfigBasePath(params) {
	const accounts = (params.cfg.channels?.[params.channelKey])?.accounts;
	return Boolean(accounts?.[params.accountId]) ? `channels.${params.channelKey}.accounts.${params.accountId}.` : `channels.${params.channelKey}.`;
}
//#endregion
//#region src/plugin-sdk/inbound-envelope.ts
function createInboundEnvelopeBuilder(params) {
	const storePath = params.resolveStorePath(params.sessionStore, { agentId: params.route.agentId });
	const envelopeOptions = params.resolveEnvelopeFormatOptions(params.cfg);
	return (input) => {
		const previousTimestamp = params.readSessionUpdatedAt({
			storePath,
			sessionKey: params.route.sessionKey
		});
		return {
			storePath,
			body: params.formatAgentEnvelope({
				channel: input.channel,
				from: input.from,
				timestamp: input.timestamp,
				previousTimestamp,
				envelope: envelopeOptions,
				body: input.body
			})
		};
	};
}
function resolveInboundRouteEnvelopeBuilder(params) {
	const route = params.resolveAgentRoute({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		peer: params.peer
	});
	return {
		route,
		buildEnvelope: createInboundEnvelopeBuilder({
			cfg: params.cfg,
			route,
			sessionStore: params.sessionStore,
			resolveStorePath: params.resolveStorePath,
			readSessionUpdatedAt: params.readSessionUpdatedAt,
			resolveEnvelopeFormatOptions: params.resolveEnvelopeFormatOptions,
			formatAgentEnvelope: params.formatAgentEnvelope
		})
	};
}
function resolveInboundRouteEnvelopeBuilderWithRuntime(params) {
	return resolveInboundRouteEnvelopeBuilder({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		peer: params.peer,
		resolveAgentRoute: (routeParams) => params.runtime.routing.resolveAgentRoute(routeParams),
		sessionStore: params.sessionStore,
		resolveStorePath: params.runtime.session.resolveStorePath,
		readSessionUpdatedAt: params.runtime.session.readSessionUpdatedAt,
		resolveEnvelopeFormatOptions: params.runtime.reply.resolveEnvelopeFormatOptions,
		formatAgentEnvelope: params.runtime.reply.formatAgentEnvelope
	});
}
//#endregion
//#region src/plugin-sdk/pairing-access.ts
function createScopedPairingAccess(params) {
	const resolvedAccountId = normalizeAccountId(params.accountId);
	return {
		accountId: resolvedAccountId,
		readAllowFromStore: () => params.core.channel.pairing.readAllowFromStore({
			channel: params.channel,
			accountId: resolvedAccountId
		}),
		readStoreForDmPolicy: (provider, accountId) => params.core.channel.pairing.readAllowFromStore({
			channel: provider,
			accountId: normalizeAccountId(accountId)
		}),
		upsertPairingRequest: (input) => params.core.channel.pairing.upsertPairingRequest({
			channel: params.channel,
			accountId: resolvedAccountId,
			...input
		})
	};
}
//#endregion
//#region src/plugin-sdk/channel-send-result.ts
function buildChannelSendResult(channel, result) {
	return {
		channel,
		ok: result.ok,
		messageId: result.messageId ?? "",
		error: result.error ? new Error(result.error) : void 0
	};
}
//#endregion
//#region src/plugin-sdk/reply-payload.ts
function resolveOutboundMediaUrls(payload) {
	if (payload.mediaUrls?.length) return payload.mediaUrls;
	if (payload.mediaUrl) return [payload.mediaUrl];
	return [];
}
async function sendPayloadWithChunkedTextAndMedia(params) {
	const payload = params.ctx.payload;
	const text = payload.text ?? "";
	const urls = resolveOutboundMediaUrls(payload);
	if (!text && urls.length === 0) return params.emptyResult;
	if (urls.length > 0) {
		let lastResult = await params.sendMedia({
			...params.ctx,
			text,
			mediaUrl: urls[0]
		});
		for (let i = 1; i < urls.length; i++) lastResult = await params.sendMedia({
			...params.ctx,
			text: "",
			mediaUrl: urls[i]
		});
		return lastResult;
	}
	const limit = params.textChunkLimit;
	const chunks = limit && params.chunker ? params.chunker(text, limit) : [text];
	let lastResult;
	for (const chunk of chunks) lastResult = await params.sendText({
		...params.ctx,
		text: chunk
	});
	return lastResult;
}
function isNumericTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	return /^\d{3,}$/.test(trimmed);
}
async function sendMediaWithLeadingCaption(params) {
	if (params.mediaUrls.length === 0) return false;
	let first = true;
	for (const mediaUrl of params.mediaUrls) {
		const caption = first ? params.caption : void 0;
		first = false;
		try {
			await params.send({
				mediaUrl,
				caption
			});
		} catch (error) {
			if (params.onError) {
				params.onError(error, mediaUrl);
				continue;
			}
			throw error;
		}
	}
	return true;
}
//#endregion
//#region src/plugin-sdk/status-helpers.ts
function buildBaseChannelStatusSummary(snapshot) {
	return {
		configured: snapshot.configured ?? false,
		running: snapshot.running ?? false,
		lastStartAt: snapshot.lastStartAt ?? null,
		lastStopAt: snapshot.lastStopAt ?? null,
		lastError: snapshot.lastError ?? null
	};
}
function buildBaseAccountStatusSnapshot(params) {
	const { account, runtime, probe } = params;
	return {
		accountId: account.accountId,
		name: account.name,
		enabled: account.enabled,
		configured: account.configured,
		...buildRuntimeAccountStatusSnapshot({
			runtime,
			probe
		}),
		lastInboundAt: runtime?.lastInboundAt ?? null,
		lastOutboundAt: runtime?.lastOutboundAt ?? null
	};
}
function buildRuntimeAccountStatusSnapshot(params) {
	const { runtime, probe } = params;
	return {
		running: runtime?.running ?? false,
		lastStartAt: runtime?.lastStartAt ?? null,
		lastStopAt: runtime?.lastStopAt ?? null,
		lastError: runtime?.lastError ?? null,
		probe
	};
}
function buildTokenChannelStatusSummary(snapshot, opts) {
	const base = {
		...buildBaseChannelStatusSummary(snapshot),
		tokenSource: snapshot.tokenSource ?? "none",
		probe: snapshot.probe,
		lastProbeAt: snapshot.lastProbeAt ?? null
	};
	if (opts?.includeMode === false) return base;
	return {
		...base,
		mode: snapshot.mode ?? null
	};
}
//#endregion
//#region src/plugin-sdk/text-chunking.ts
function chunkTextForOutbound(text, limit) {
	return chunkTextByBreakResolver(text, limit, (window) => {
		const lastNewline = window.lastIndexOf("\n");
		const lastSpace = window.lastIndexOf(" ");
		return lastNewline > 0 ? lastNewline : lastSpace;
	});
}
//#endregion
//#region src/plugin-sdk/webhook-memory-guards.ts
const WEBHOOK_RATE_LIMIT_DEFAULTS = Object.freeze({
	windowMs: 6e4,
	maxRequests: 120,
	maxTrackedKeys: 4096
});
const WEBHOOK_ANOMALY_COUNTER_DEFAULTS = Object.freeze({
	maxTrackedKeys: 4096,
	ttlMs: 360 * 6e4,
	logEvery: 25
});
const WEBHOOK_ANOMALY_STATUS_CODES = Object.freeze([
	400,
	401,
	408,
	413,
	415,
	429
]);
function createFixedWindowRateLimiter(options) {
	const windowMs = Math.max(1, Math.floor(options.windowMs));
	const maxRequests = Math.max(1, Math.floor(options.maxRequests));
	const maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys));
	const pruneIntervalMs = Math.max(1, Math.floor(options.pruneIntervalMs ?? windowMs));
	const state = /* @__PURE__ */ new Map();
	let lastPruneMs = 0;
	const touch = (key, value) => {
		state.delete(key);
		state.set(key, value);
	};
	const prune = (nowMs) => {
		for (const [key, entry] of state) if (nowMs - entry.windowStartMs >= windowMs) state.delete(key);
	};
	return {
		isRateLimited: (key, nowMs = Date.now()) => {
			if (!key) return false;
			if (nowMs - lastPruneMs >= pruneIntervalMs) {
				prune(nowMs);
				lastPruneMs = nowMs;
			}
			const existing = state.get(key);
			if (!existing || nowMs - existing.windowStartMs >= windowMs) {
				touch(key, {
					count: 1,
					windowStartMs: nowMs
				});
				pruneMapToMaxSize(state, maxTrackedKeys);
				return false;
			}
			const nextCount = existing.count + 1;
			touch(key, {
				count: nextCount,
				windowStartMs: existing.windowStartMs
			});
			pruneMapToMaxSize(state, maxTrackedKeys);
			return nextCount > maxRequests;
		},
		size: () => state.size,
		clear: () => {
			state.clear();
			lastPruneMs = 0;
		}
	};
}
function createBoundedCounter(options) {
	const maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys));
	const ttlMs = Math.max(0, Math.floor(options.ttlMs ?? 0));
	const pruneIntervalMs = Math.max(1, Math.floor(options.pruneIntervalMs ?? (ttlMs > 0 ? ttlMs : 6e4)));
	const counters = /* @__PURE__ */ new Map();
	let lastPruneMs = 0;
	const touch = (key, value) => {
		counters.delete(key);
		counters.set(key, value);
	};
	const isExpired = (entry, nowMs) => ttlMs > 0 && nowMs - entry.updatedAtMs >= ttlMs;
	const prune = (nowMs) => {
		if (ttlMs > 0) {
			for (const [key, entry] of counters) if (isExpired(entry, nowMs)) counters.delete(key);
		}
	};
	return {
		increment: (key, nowMs = Date.now()) => {
			if (!key) return 0;
			if (nowMs - lastPruneMs >= pruneIntervalMs) {
				prune(nowMs);
				lastPruneMs = nowMs;
			}
			const existing = counters.get(key);
			const nextCount = (existing && !isExpired(existing, nowMs) ? existing.count : 0) + 1;
			touch(key, {
				count: nextCount,
				updatedAtMs: nowMs
			});
			pruneMapToMaxSize(counters, maxTrackedKeys);
			return nextCount;
		},
		size: () => counters.size,
		clear: () => {
			counters.clear();
			lastPruneMs = 0;
		}
	};
}
function createWebhookAnomalyTracker(options) {
	const maxTrackedKeys = Math.max(1, Math.floor(options?.maxTrackedKeys ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys));
	const ttlMs = Math.max(0, Math.floor(options?.ttlMs ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs));
	const logEvery = Math.max(1, Math.floor(options?.logEvery ?? WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery));
	const trackedStatusCodes = new Set(options?.trackedStatusCodes ?? WEBHOOK_ANOMALY_STATUS_CODES);
	const counter = createBoundedCounter({
		maxTrackedKeys,
		ttlMs
	});
	return {
		record: ({ key, statusCode, message, log, nowMs }) => {
			if (!trackedStatusCodes.has(statusCode)) return 0;
			const next = counter.increment(key, nowMs);
			if (log && (next === 1 || next % logEvery === 0)) log(message(next));
			return next;
		},
		size: () => counter.size(),
		clear: () => counter.clear()
	};
}
//#endregion
//#region src/plugin-sdk/webhook-path.ts
function normalizeWebhookPath(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "/";
	const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
	return withSlash;
}
function resolveWebhookPath(params) {
	const trimmedPath = params.webhookPath?.trim();
	if (trimmedPath) return normalizeWebhookPath(trimmedPath);
	if (params.webhookUrl?.trim()) try {
		return normalizeWebhookPath(new URL(params.webhookUrl).pathname || "/");
	} catch {
		return null;
	}
	return params.defaultPath ?? null;
}
//#endregion
//#region src/plugin-sdk/webhook-request-guards.ts
const WEBHOOK_BODY_READ_DEFAULTS = Object.freeze({
	preAuth: {
		maxBytes: 64 * 1024,
		timeoutMs: 5e3
	},
	postAuth: {
		maxBytes: 1024 * 1024,
		timeoutMs: 3e4
	}
});
Object.freeze({
	maxInFlightPerKey: 8,
	maxTrackedKeys: 4096
});
function resolveWebhookBodyReadLimits(params) {
	const defaults = params.profile === "pre-auth" ? WEBHOOK_BODY_READ_DEFAULTS.preAuth : WEBHOOK_BODY_READ_DEFAULTS.postAuth;
	return {
		maxBytes: typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes) && params.maxBytes > 0 ? Math.floor(params.maxBytes) : defaults.maxBytes,
		timeoutMs: typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? Math.floor(params.timeoutMs) : defaults.timeoutMs
	};
}
function respondWebhookBodyReadError(params) {
	const { res, code, invalidMessage } = params;
	if (code === "PAYLOAD_TOO_LARGE") {
		res.statusCode = 413;
		res.end(requestBodyErrorToText("PAYLOAD_TOO_LARGE"));
		return { ok: false };
	}
	if (code === "REQUEST_BODY_TIMEOUT") {
		res.statusCode = 408;
		res.end(requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
		return { ok: false };
	}
	if (code === "CONNECTION_CLOSED") {
		res.statusCode = 400;
		res.end(requestBodyErrorToText("CONNECTION_CLOSED"));
		return { ok: false };
	}
	res.statusCode = 400;
	res.end(invalidMessage ?? "Bad Request");
	return { ok: false };
}
function isJsonContentType(value) {
	const first = Array.isArray(value) ? value[0] : value;
	if (!first) return false;
	const mediaType = first.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}
function applyBasicWebhookRequestGuards(params) {
	const allowMethods = params.allowMethods?.length ? params.allowMethods : null;
	if (allowMethods && !allowMethods.includes(params.req.method ?? "")) {
		params.res.statusCode = 405;
		params.res.setHeader("Allow", allowMethods.join(", "));
		params.res.end("Method Not Allowed");
		return false;
	}
	if (params.rateLimiter && params.rateLimitKey && params.rateLimiter.isRateLimited(params.rateLimitKey, params.nowMs ?? Date.now())) {
		params.res.statusCode = 429;
		params.res.end("Too Many Requests");
		return false;
	}
	if (params.requireJsonContentType && params.req.method === "POST" && !isJsonContentType(params.req.headers["content-type"])) {
		params.res.statusCode = 415;
		params.res.end("Unsupported Media Type");
		return false;
	}
	return true;
}
function beginWebhookRequestPipelineOrReject(params) {
	if (!applyBasicWebhookRequestGuards({
		req: params.req,
		res: params.res,
		allowMethods: params.allowMethods,
		rateLimiter: params.rateLimiter,
		rateLimitKey: params.rateLimitKey,
		nowMs: params.nowMs,
		requireJsonContentType: params.requireJsonContentType
	})) return { ok: false };
	const inFlightKey = params.inFlightKey ?? "";
	const inFlightLimiter = params.inFlightLimiter;
	if (inFlightLimiter && inFlightKey && !inFlightLimiter.tryAcquire(inFlightKey)) {
		params.res.statusCode = params.inFlightLimitStatusCode ?? 429;
		params.res.end(params.inFlightLimitMessage ?? "Too Many Requests");
		return { ok: false };
	}
	let released = false;
	return {
		ok: true,
		release: () => {
			if (released) return;
			released = true;
			if (inFlightLimiter && inFlightKey) inFlightLimiter.release(inFlightKey);
		}
	};
}
async function readJsonWebhookBodyOrReject(params) {
	const limits = resolveWebhookBodyReadLimits({
		maxBytes: params.maxBytes,
		timeoutMs: params.timeoutMs,
		profile: params.profile
	});
	const body = await readJsonBodyWithLimit(params.req, {
		maxBytes: limits.maxBytes,
		timeoutMs: limits.timeoutMs,
		emptyObjectOnEmpty: params.emptyObjectOnEmpty
	});
	if (body.ok) return {
		ok: true,
		value: body.value
	};
	return respondWebhookBodyReadError({
		res: params.res,
		code: body.code,
		invalidMessage: params.invalidJsonMessage
	});
}
//#endregion
//#region src/plugin-sdk/webhook-targets.ts
function registerWebhookTargetWithPluginRoute(params) {
	return registerWebhookTarget(params.targetsByPath, params.target, {
		onFirstPathTarget: ({ path }) => registerPluginHttpRoute({
			...params.route,
			path,
			replaceExisting: params.route.replaceExisting ?? true
		}),
		onLastPathTargetRemoved: params.onLastPathTargetRemoved
	});
}
const pathTeardownByTargetMap = /* @__PURE__ */ new WeakMap();
function getPathTeardownMap(targetsByPath) {
	const mapKey = targetsByPath;
	const existing = pathTeardownByTargetMap.get(mapKey);
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	pathTeardownByTargetMap.set(mapKey, created);
	return created;
}
function registerWebhookTarget(targetsByPath, target, opts) {
	const key = normalizeWebhookPath(target.path);
	const normalizedTarget = {
		...target,
		path: key
	};
	const existing = targetsByPath.get(key) ?? [];
	if (existing.length === 0) {
		const onFirstPathResult = opts?.onFirstPathTarget?.({
			path: key,
			target: normalizedTarget
		});
		if (typeof onFirstPathResult === "function") getPathTeardownMap(targetsByPath).set(key, onFirstPathResult);
	}
	targetsByPath.set(key, [...existing, normalizedTarget]);
	let isActive = true;
	const unregister = () => {
		if (!isActive) return;
		isActive = false;
		const updated = (targetsByPath.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
		if (updated.length > 0) {
			targetsByPath.set(key, updated);
			return;
		}
		targetsByPath.delete(key);
		const teardown = getPathTeardownMap(targetsByPath).get(key);
		if (teardown) {
			getPathTeardownMap(targetsByPath).delete(key);
			teardown();
		}
		opts?.onLastPathTargetRemoved?.({ path: key });
	};
	return {
		target: normalizedTarget,
		unregister
	};
}
function resolveWebhookTargets(req, targetsByPath) {
	const path = normalizeWebhookPath(new URL(req.url ?? "/", "http://localhost").pathname);
	const targets = targetsByPath.get(path);
	if (!targets || targets.length === 0) return null;
	return {
		path,
		targets
	};
}
async function withResolvedWebhookRequestPipeline(params) {
	const resolved = resolveWebhookTargets(params.req, params.targetsByPath);
	if (!resolved) return false;
	const inFlightKey = typeof params.inFlightKey === "function" ? params.inFlightKey({
		req: params.req,
		path: resolved.path,
		targets: resolved.targets
	}) : params.inFlightKey ?? `${resolved.path}:${params.req.socket?.remoteAddress ?? "unknown"}`;
	const requestLifecycle = beginWebhookRequestPipelineOrReject({
		req: params.req,
		res: params.res,
		allowMethods: params.allowMethods,
		rateLimiter: params.rateLimiter,
		rateLimitKey: params.rateLimitKey,
		nowMs: params.nowMs,
		requireJsonContentType: params.requireJsonContentType,
		inFlightLimiter: params.inFlightLimiter,
		inFlightKey,
		inFlightLimitStatusCode: params.inFlightLimitStatusCode,
		inFlightLimitMessage: params.inFlightLimitMessage
	});
	if (!requestLifecycle.ok) return true;
	try {
		await params.handle(resolved);
		return true;
	} finally {
		requestLifecycle.release();
	}
}
function updateMatchedWebhookTarget(matched, target) {
	if (matched) return {
		ok: false,
		result: { kind: "ambiguous" }
	};
	return {
		ok: true,
		matched: target
	};
}
function finalizeMatchedWebhookTarget(matched) {
	if (!matched) return { kind: "none" };
	return {
		kind: "single",
		target: matched
	};
}
function resolveSingleWebhookTarget(targets, isMatch) {
	let matched;
	for (const target of targets) {
		if (!isMatch(target)) continue;
		const updated = updateMatchedWebhookTarget(matched, target);
		if (!updated.ok) return updated.result;
		matched = updated.matched;
	}
	return finalizeMatchedWebhookTarget(matched);
}
function resolveWebhookTargetWithAuthOrRejectSync(params) {
	return resolveWebhookTargetMatchOrReject(params, resolveSingleWebhookTarget(params.targets, params.isMatch));
}
function resolveWebhookTargetMatchOrReject(params, match) {
	if (match.kind === "single") return match.target;
	if (match.kind === "ambiguous") {
		params.res.statusCode = params.ambiguousStatusCode ?? 401;
		params.res.end(params.ambiguousMessage ?? "ambiguous webhook target");
		return null;
	}
	params.res.statusCode = params.unauthorizedStatusCode ?? 401;
	params.res.end(params.unauthorizedMessage ?? "unauthorized");
	return null;
}
//#endregion
export { DEFAULT_ACCOUNT_ID, MarkdownConfigSchema, PAIRING_APPROVED_MESSAGE, WEBHOOK_ANOMALY_COUNTER_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, addWildcardAllowFrom, applyAccountNameToChannelSection, applyBasicWebhookRequestGuards, applySetupAccountConfigPatch, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, buildChannelSendResult, buildSecretInputSchema, buildSingleChannelSecretPromptState, buildTokenChannelStatusSummary, chunkTextForOutbound, createAccountListHelpers, createDedupeCache, createFixedWindowRateLimiter, createReplyPrefixOptions, createScopedPairingAccess, createTypingCallbacks, createWebhookAnomalyTracker, deleteAccountFromConfigSection, emptyPluginConfigSchema, evaluateSenderGroupAccess, extractToolSend, formatAllowFromLowercase, formatPairingApproveHint, hasConfiguredSecretInput, isNormalizedSenderAllowed, isNumericTargetId, issuePairingChallenge, jsonResult, listDirectoryUserEntriesFromAllowFrom, logTypingFailure, mergeAllowFromEntries, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeResolvedSecretInputString, normalizeSecretInputString, promptAccountId, promptSingleChannelSecretInput, readJsonWebhookBodyOrReject, readStringParam, registerWebhookTarget, registerWebhookTargetWithPluginRoute, resolveAccountIdForConfigure, resolveChannelAccountConfigBasePath, resolveDefaultGroupPolicy, resolveDirectDmAuthorizationOutcome, resolveInboundRouteEnvelopeBuilderWithRuntime, resolveOpenProviderRuntimeGroupPolicy, resolveOutboundMediaUrls, resolveSenderCommandAuthorizationWithRuntime, resolveSingleWebhookTarget, resolveWebhookPath, resolveWebhookTargetWithAuthOrRejectSync, resolveWebhookTargets, runSingleChannelSecretStep, sendMediaWithLeadingCaption, sendPayloadWithChunkedTextAndMedia, setAccountEnabledInConfigSection, setTopLevelChannelDmPolicyWithAllowFrom, waitForAbortSignal, warnMissingProviderGroupPolicyFallbackOnce, withResolvedWebhookRequestPipeline };
