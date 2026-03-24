import "./github-copilot-token-ClyulAWr.js";
import { Cn as normalizeAccountId, Sn as DEFAULT_ACCOUNT_ID } from "./query-expansion-Dz_U9Dfk.js";
import { $ as listThreadBindingsBySessionKey, $i as isValidFileSecretRefId, Bi as projectCredentialSnapshotFields, Ci as listDiscordDirectoryPeersFromConfig, Gi as resolveDiscordAccount, Hi as inspectDiscordAccount, Ki as getChatChannelMeta, Q as autoBindSpawnedDiscordSubagent, Qi as isValidExecSecretRefId, Si as listDiscordDirectoryGroupsFromConfig, Sr as resolveDiscordGroupToolPolicy, Ui as listDiscordAccountIds, Vi as resolveConfiguredFromCredentialStatuses, Wi as resolveDefaultDiscordAccountId, Xi as setAccountEnabledInConfigSection, Yi as deleteAccountFromConfigSection, Zi as formatExecSecretRefIdValidationMessage, _ as formatDocsLink, bi as resolveOpenProviderRuntimeGroupPolicy, ea as resolveDefaultSecretProviderAlias, et as unbindThreadBindingsBySessionKey, gi as normalizeDiscordSlug, hi as parseDiscordTarget, ii as encodeJsonPointerToken, it as resolveDiscordUserAllowlist, na as isValidEnvSecretRefId, o as DiscordConfigSchema, qi as formatPairingApproveHint, ri as resolveSecretRefString, t as collectDiscordAuditChannelIds, ta as hasConfiguredSecretInput, w as resolveDiscordChannelAllowlist, xr as resolveDiscordGroupRequireMention, yi as resolveDefaultGroupPolicy } from "./audit-BhPEVt68.js";
import { f as isRecord } from "./logger-_x5WOezH.js";
import "./paths-D6tDENa_.js";
import "./fetch-D5BISjXq.js";
import { z } from "zod";
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
const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
	"name",
	"token",
	"tokenFile",
	"botToken",
	"appToken",
	"account",
	"signalNumber",
	"authDir",
	"cliPath",
	"dbPath",
	"httpUrl",
	"httpHost",
	"httpPort",
	"webhookPath",
	"webhookUrl",
	"webhookSecret",
	"service",
	"region",
	"homeserver",
	"userId",
	"accessToken",
	"password",
	"deviceName",
	"url",
	"code",
	"dmPolicy",
	"allowFrom",
	"groupPolicy",
	"groupAllowFrom",
	"defaultTo"
]);
const SINGLE_ACCOUNT_KEYS_TO_MOVE_BY_CHANNEL = { telegram: new Set(["streaming"]) };
function shouldMoveSingleAccountChannelKey(params) {
	if (COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(params.key)) return true;
	return SINGLE_ACCOUNT_KEYS_TO_MOVE_BY_CHANNEL[params.channelKey]?.has(params.key) ?? false;
}
function cloneIfObject(value) {
	if (value && typeof value === "object") return structuredClone(value);
	return value;
}
function moveSingleAccountChannelSectionToDefaultAccount(params) {
	const baseConfig = params.cfg.channels?.[params.channelKey];
	const base = typeof baseConfig === "object" && baseConfig ? baseConfig : void 0;
	if (!base) return params.cfg;
	const accounts = base.accounts ?? {};
	if (Object.keys(accounts).length > 0) return params.cfg;
	const keysToMove = Object.entries(base).filter(([key, value]) => key !== "accounts" && key !== "enabled" && value !== void 0 && shouldMoveSingleAccountChannelKey({
		channelKey: params.channelKey,
		key
	})).map(([key]) => key);
	const defaultAccount = {};
	for (const key of keysToMove) {
		const value = base[key];
		defaultAccount[key] = cloneIfObject(value);
	}
	const nextChannel = { ...base };
	for (const key of keysToMove) delete nextChannel[key];
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			[params.channelKey]: {
				...nextChannel,
				accounts: {
					...accounts,
					[DEFAULT_ACCOUNT_ID]: defaultAccount
				}
			}
		}
	};
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
//#region src/channels/plugins/pairing-message.ts
const PAIRING_APPROVED_MESSAGE = "✅ OpenClaw access approved. Send a message to start chatting.";
//#endregion
//#region src/channels/plugins/normalize/discord.ts
function normalizeDiscordMessagingTarget(raw) {
	return parseDiscordTarget(raw, { defaultKind: "channel" })?.normalized;
}
/**
* Normalize a Discord outbound target for delivery. Bare numeric IDs are
* prefixed with "channel:" to avoid the ambiguous-target error in
* parseDiscordTarget. All other formats pass through unchanged.
*/
function normalizeDiscordOutboundTarget(to) {
	const trimmed = to?.trim();
	if (!trimmed) return {
		ok: false,
		error: /* @__PURE__ */ new Error("Discord recipient is required. Use \"channel:<id>\" for channels or \"user:<id>\" for DMs.")
	};
	if (/^\d+$/.test(trimmed)) return {
		ok: true,
		to: `channel:${trimmed}`
	};
	return {
		ok: true,
		to: trimmed
	};
}
function looksLikeDiscordTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	if (/^<@!?\d+>$/.test(trimmed)) return true;
	if (/^(user|channel|discord):/i.test(trimmed)) return true;
	if (/^\d{6,}$/.test(trimmed)) return true;
	return false;
}
//#endregion
//#region src/channels/plugins/status-issues/shared.ts
function asString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function formatMatchMetadata(params) {
	const matchKey = typeof params.matchKey === "string" ? params.matchKey : typeof params.matchKey === "number" ? String(params.matchKey) : void 0;
	const matchSource = asString(params.matchSource);
	const parts = [matchKey ? `matchKey=${matchKey}` : null, matchSource ? `matchSource=${matchSource}` : null].filter((entry) => Boolean(entry));
	return parts.length > 0 ? parts.join(" ") : void 0;
}
function appendMatchMetadata(message, params) {
	const meta = formatMatchMetadata(params);
	return meta ? `${message} (${meta})` : message;
}
function resolveEnabledConfiguredAccountId(account) {
	const accountId = asString(account.accountId) ?? "default";
	const enabled = account.enabled !== false;
	const configured = account.configured === true;
	return enabled && configured ? accountId : null;
}
//#endregion
//#region src/channels/plugins/status-issues/discord.ts
function readDiscordAccountStatus(value) {
	if (!isRecord(value)) return null;
	return {
		accountId: value.accountId,
		enabled: value.enabled,
		configured: value.configured,
		application: value.application,
		audit: value.audit
	};
}
function readDiscordApplicationSummary(value) {
	if (!isRecord(value)) return {};
	const intentsRaw = value.intents;
	if (!isRecord(intentsRaw)) return {};
	return { intents: { messageContent: intentsRaw.messageContent === "enabled" || intentsRaw.messageContent === "limited" || intentsRaw.messageContent === "disabled" ? intentsRaw.messageContent : void 0 } };
}
function readDiscordPermissionsAuditSummary(value) {
	if (!isRecord(value)) return {};
	const unresolvedChannels = typeof value.unresolvedChannels === "number" && Number.isFinite(value.unresolvedChannels) ? value.unresolvedChannels : void 0;
	const channelsRaw = value.channels;
	return {
		unresolvedChannels,
		channels: Array.isArray(channelsRaw) ? channelsRaw.map((entry) => {
			if (!isRecord(entry)) return null;
			const channelId = asString(entry.channelId);
			if (!channelId) return null;
			const ok = typeof entry.ok === "boolean" ? entry.ok : void 0;
			const missing = Array.isArray(entry.missing) ? entry.missing.map((v) => asString(v)).filter(Boolean) : void 0;
			const error = asString(entry.error) ?? null;
			const matchKey = asString(entry.matchKey) ?? void 0;
			const matchSource = asString(entry.matchSource) ?? void 0;
			return {
				channelId,
				ok,
				missing: missing?.length ? missing : void 0,
				error,
				matchKey,
				matchSource
			};
		}).filter(Boolean) : void 0
	};
}
function collectDiscordStatusIssues(accounts) {
	const issues = [];
	for (const entry of accounts) {
		const account = readDiscordAccountStatus(entry);
		if (!account) continue;
		const accountId = resolveEnabledConfiguredAccountId(account);
		if (!accountId) continue;
		if (readDiscordApplicationSummary(account.application).intents?.messageContent === "disabled") issues.push({
			channel: "discord",
			accountId,
			kind: "intent",
			message: "Message Content Intent is disabled. Bot may not see normal channel messages.",
			fix: "Enable Message Content Intent in Discord Dev Portal → Bot → Privileged Gateway Intents, or require mention-only operation."
		});
		const audit = readDiscordPermissionsAuditSummary(account.audit);
		if (audit.unresolvedChannels && audit.unresolvedChannels > 0) issues.push({
			channel: "discord",
			accountId,
			kind: "config",
			message: `Some configured guild channels are not numeric IDs (unresolvedChannels=${audit.unresolvedChannels}). Permission audit can only check numeric channel IDs.`,
			fix: "Use numeric channel IDs as keys in channels.discord.guilds.*.channels (then rerun channels status --probe)."
		});
		for (const channel of audit.channels ?? []) {
			if (channel.ok === true) continue;
			const missing = channel.missing?.length ? ` missing ${channel.missing.join(", ")}` : "";
			const error = channel.error ? `: ${channel.error}` : "";
			const baseMessage = `Channel ${channel.channelId} permission check failed.${missing}${error}`;
			issues.push({
				channel: "discord",
				accountId,
				kind: "permissions",
				message: appendMatchMetadata(baseMessage, {
					matchKey: channel.matchKey,
					matchSource: channel.matchSource
				}),
				fix: "Ensure the bot role can view + send in this channel (and that channel overrides don't deny it)."
			});
		}
	}
	return issues;
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
function splitOnboardingEntries(raw) {
	return raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
}
function parseMentionOrPrefixedId(params) {
	const trimmed = params.value.trim();
	if (!trimmed) return null;
	const mentionMatch = trimmed.match(params.mentionPattern);
	if (mentionMatch?.[1]) return params.normalizeId ? params.normalizeId(mentionMatch[1]) : mentionMatch[1];
	const stripped = params.prefixPattern ? trimmed.replace(params.prefixPattern, "") : trimmed;
	if (!params.idPattern.test(stripped)) return null;
	return params.normalizeId ? params.normalizeId(stripped) : stripped;
}
function resolveOnboardingAccountId(params) {
	return params.accountId?.trim() ? normalizeAccountId(params.accountId) : params.defaultAccountId;
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
function setLegacyChannelDmPolicyWithAllowFrom(params) {
	const channelConfig = params.cfg.channels?.[params.channel] ?? {
		allowFrom: void 0,
		dm: void 0
	};
	const existingAllowFrom = channelConfig.allowFrom ?? channelConfig.dm?.allowFrom;
	const allowFrom = params.dmPolicy === "open" ? addWildcardAllowFrom(existingAllowFrom) : void 0;
	return patchLegacyDmChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		patch: {
			dmPolicy: params.dmPolicy,
			...allowFrom ? { allowFrom } : {}
		}
	});
}
function setLegacyChannelAllowFrom(params) {
	return patchLegacyDmChannelConfig({
		cfg: params.cfg,
		channel: params.channel,
		patch: { allowFrom: params.allowFrom }
	});
}
function setAccountGroupPolicyForChannel(params) {
	return patchChannelConfigForAccount({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		patch: { groupPolicy: params.groupPolicy }
	});
}
function patchLegacyDmChannelConfig(params) {
	const { cfg, channel, patch } = params;
	const channelConfig = cfg.channels?.[channel] ?? {};
	const dmConfig = channelConfig.dm ?? {};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...channelConfig,
				...patch,
				dm: {
					...dmConfig,
					enabled: typeof dmConfig.enabled === "boolean" ? dmConfig.enabled : true
				}
			}
		}
	};
}
function setOnboardingChannelEnabled(cfg, channel, enabled) {
	const channelConfig = cfg.channels?.[channel] ?? {};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...channelConfig,
				enabled
			}
		}
	};
}
function patchConfigForScopedAccount(params) {
	const { cfg, channel, accountId, patch, ensureEnabled } = params;
	return patchScopedAccountConfig({
		cfg: accountId === "default" ? cfg : moveSingleAccountChannelSectionToDefaultAccount({
			cfg,
			channelKey: channel
		}),
		channelKey: channel,
		accountId,
		patch,
		ensureChannelEnabled: ensureEnabled,
		ensureAccountEnabled: ensureEnabled
	});
}
function patchChannelConfigForAccount(params) {
	return patchConfigForScopedAccount({
		...params,
		ensureEnabled: true
	});
}
function applySingleTokenPromptResult(params) {
	let next = params.cfg;
	if (params.tokenResult.useEnv) next = patchChannelConfigForAccount({
		cfg: next,
		channel: params.channel,
		accountId: params.accountId,
		patch: {}
	});
	if (params.tokenResult.token) next = patchChannelConfigForAccount({
		cfg: next,
		channel: params.channel,
		accountId: params.accountId,
		patch: { [params.tokenPatchKey]: params.tokenResult.token }
	});
	return next;
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
async function noteChannelLookupSummary(params) {
	const lines = [];
	for (const section of params.resolvedSections) {
		if (section.values.length === 0) continue;
		lines.push(`${section.title}: ${section.values.join(", ")}`);
	}
	if (params.unresolved && params.unresolved.length > 0) lines.push(`Unresolved (kept as typed): ${params.unresolved.join(", ")}`);
	if (lines.length > 0) await params.prompter.note(lines.join("\n"), params.label);
}
async function noteChannelLookupFailure(params) {
	await params.prompter.note(`Channel lookup failed; keeping entries as typed. ${String(params.error)}`, params.label);
}
async function promptResolvedAllowFrom(params) {
	while (true) {
		const entry = await params.prompter.text({
			message: params.message,
			placeholder: params.placeholder,
			initialValue: params.existing[0] ? String(params.existing[0]) : void 0,
			validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
		});
		const parts = params.parseInputs(String(entry));
		if (!params.token) {
			const ids = parts.map(params.parseId).filter(Boolean);
			if (ids.length !== parts.length) {
				await params.prompter.note(params.invalidWithoutTokenNote, params.label);
				continue;
			}
			return mergeAllowFromEntries(params.existing, ids);
		}
		const results = await params.resolveEntries({
			token: params.token,
			entries: parts
		}).catch(() => null);
		if (!results) {
			await params.prompter.note("Failed to resolve usernames. Try again.", params.label);
			continue;
		}
		const unresolved = results.filter((res) => !res.resolved || !res.id);
		if (unresolved.length > 0) {
			await params.prompter.note(`Could not resolve: ${unresolved.map((res) => res.input).join(", ")}`, params.label);
			continue;
		}
		const ids = results.map((res) => res.id);
		return mergeAllowFromEntries(params.existing, ids);
	}
}
async function promptLegacyChannelAllowFrom(params) {
	await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
	const unique = await promptResolvedAllowFrom({
		prompter: params.prompter,
		existing: params.existing,
		token: params.token,
		message: params.message,
		placeholder: params.placeholder,
		label: params.noteTitle,
		parseInputs: splitOnboardingEntries,
		parseId: params.parseId,
		invalidWithoutTokenNote: params.invalidWithoutTokenNote,
		resolveEntries: params.resolveEntries
	});
	return setLegacyChannelAllowFrom({
		cfg: params.cfg,
		channel: params.channel,
		allowFrom: unique
	});
}
//#endregion
//#region src/channels/plugins/onboarding/channel-access.ts
function parseAllowlistEntries(raw) {
	return splitOnboardingEntries(String(raw ?? ""));
}
function formatAllowlistEntries(entries) {
	return entries.map((entry) => entry.trim()).filter(Boolean).join(", ");
}
async function promptChannelAccessPolicy(params) {
	const options = [{
		value: "allowlist",
		label: "Allowlist (recommended)"
	}];
	if (params.allowOpen !== false) options.push({
		value: "open",
		label: "Open (allow all channels)"
	});
	if (params.allowDisabled !== false) options.push({
		value: "disabled",
		label: "Disabled (block all channels)"
	});
	const initialValue = params.currentPolicy ?? "allowlist";
	return await params.prompter.select({
		message: `${params.label} access`,
		options,
		initialValue
	});
}
async function promptChannelAllowlist(params) {
	const initialValue = params.currentEntries && params.currentEntries.length > 0 ? formatAllowlistEntries(params.currentEntries) : void 0;
	return parseAllowlistEntries(await params.prompter.text({
		message: `${params.label} allowlist (comma-separated)`,
		placeholder: params.placeholder,
		initialValue
	}));
}
async function promptChannelAccessConfig(params) {
	const hasEntries = (params.currentEntries ?? []).length > 0;
	const shouldPrompt = params.defaultPrompt ?? !hasEntries;
	if (!await params.prompter.confirm({
		message: params.updatePrompt ? `Update ${params.label} access?` : `Configure ${params.label} access?`,
		initialValue: shouldPrompt
	})) return null;
	const policy = await promptChannelAccessPolicy({
		prompter: params.prompter,
		label: params.label,
		currentPolicy: params.currentPolicy,
		allowOpen: params.allowOpen,
		allowDisabled: params.allowDisabled
	});
	if (policy !== "allowlist") return {
		policy,
		entries: []
	};
	return {
		policy,
		entries: await promptChannelAllowlist({
			prompter: params.prompter,
			label: params.label,
			currentEntries: params.currentEntries,
			placeholder: params.placeholder
		})
	};
}
//#endregion
//#region src/channels/plugins/onboarding/channel-access-configure.ts
async function configureChannelAccessWithAllowlist(params) {
	let next = params.cfg;
	const accessConfig = await promptChannelAccessConfig({
		prompter: params.prompter,
		label: params.label,
		currentPolicy: params.currentPolicy,
		currentEntries: params.currentEntries,
		placeholder: params.placeholder,
		updatePrompt: params.updatePrompt
	});
	if (!accessConfig) return next;
	if (accessConfig.policy !== "allowlist") return params.setPolicy(next, accessConfig.policy);
	const resolved = await params.resolveAllowlist({
		cfg: next,
		entries: accessConfig.entries
	});
	next = params.setPolicy(next, "allowlist");
	return params.applyAllowlist({
		cfg: next,
		resolved
	});
}
//#endregion
//#region src/channels/plugins/onboarding/discord.ts
const channel = "discord";
async function noteDiscordTokenHelp(prompter) {
	await prompter.note([
		"1) Discord Developer Portal → Applications → New Application",
		"2) Bot → Add Bot → Reset Token → copy token",
		"3) OAuth2 → URL Generator → scope 'bot' → invite to your server",
		"Tip: enable Message Content Intent if you need message text. (Bot → Privileged Gateway Intents → Message Content Intent)",
		`Docs: ${formatDocsLink("/discord", "discord")}`
	].join("\n"), "Discord bot token");
}
function setDiscordGuildChannelAllowlist(cfg, accountId, entries) {
	const guilds = { ...accountId === "default" ? cfg.channels?.discord?.guilds ?? {} : cfg.channels?.discord?.accounts?.[accountId]?.guilds ?? {} };
	for (const entry of entries) {
		const guildKey = entry.guildKey || "*";
		const existing = guilds[guildKey] ?? {};
		if (entry.channelKey) {
			const channels = { ...existing.channels };
			channels[entry.channelKey] = { allow: true };
			guilds[guildKey] = {
				...existing,
				channels
			};
		} else guilds[guildKey] = existing;
	}
	return patchChannelConfigForAccount({
		cfg,
		channel: "discord",
		accountId,
		patch: { guilds }
	});
}
async function promptDiscordAllowFrom(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: resolveDefaultDiscordAccountId(params.cfg)
	});
	const token = resolveDiscordAccount({
		cfg: params.cfg,
		accountId
	}).token;
	const existing = params.cfg.channels?.discord?.allowFrom ?? params.cfg.channels?.discord?.dm?.allowFrom ?? [];
	const parseId = (value) => parseMentionOrPrefixedId({
		value,
		mentionPattern: /^<@!?(\d+)>$/,
		prefixPattern: /^(user:|discord:)/i,
		idPattern: /^\d+$/
	});
	return promptLegacyChannelAllowFrom({
		cfg: params.cfg,
		channel: "discord",
		prompter: params.prompter,
		existing,
		token,
		noteTitle: "Discord allowlist",
		noteLines: [
			"Allowlist Discord DMs by username (we resolve to user ids).",
			"Examples:",
			"- 123456789012345678",
			"- @alice",
			"- alice#1234",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/discord", "discord")}`
		],
		message: "Discord allowFrom (usernames or ids)",
		placeholder: "@alice, 123456789012345678",
		parseId,
		invalidWithoutTokenNote: "Bot token missing; use numeric user ids (or mention form) only.",
		resolveEntries: ({ token, entries }) => resolveDiscordUserAllowlist({
			token,
			entries
		})
	});
}
const discordOnboardingAdapter = {
	channel,
	getStatus: async ({ cfg }) => {
		const configured = listDiscordAccountIds(cfg).some((accountId) => {
			return inspectDiscordAccount({
				cfg,
				accountId
			}).configured;
		});
		return {
			channel,
			configured,
			statusLines: [`Discord: ${configured ? "configured" : "needs token"}`],
			selectionHint: configured ? "configured" : "needs token",
			quickstartScore: configured ? 2 : 1
		};
	},
	configure: async ({ cfg, prompter, options, accountOverrides, shouldPromptAccountIds }) => {
		const defaultDiscordAccountId = resolveDefaultDiscordAccountId(cfg);
		const discordAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "Discord",
			accountOverride: accountOverrides.discord,
			shouldPromptAccountIds,
			listAccountIds: listDiscordAccountIds,
			defaultAccountId: defaultDiscordAccountId
		});
		let next = cfg;
		const resolvedAccount = resolveDiscordAccount({
			cfg: next,
			accountId: discordAccountId
		});
		const allowEnv = discordAccountId === DEFAULT_ACCOUNT_ID;
		const tokenStep = await runSingleChannelSecretStep({
			cfg: next,
			prompter,
			providerHint: "discord",
			credentialLabel: "Discord bot token",
			secretInputMode: options?.secretInputMode,
			accountConfigured: Boolean(resolvedAccount.token),
			hasConfigToken: hasConfiguredSecretInput(resolvedAccount.config.token),
			allowEnv,
			envValue: process.env.DISCORD_BOT_TOKEN,
			envPrompt: "DISCORD_BOT_TOKEN detected. Use env var?",
			keepPrompt: "Discord token already configured. Keep it?",
			inputPrompt: "Enter Discord bot token",
			preferredEnvVar: allowEnv ? "DISCORD_BOT_TOKEN" : void 0,
			onMissingConfigured: async () => await noteDiscordTokenHelp(prompter),
			applyUseEnv: async (cfg) => applySingleTokenPromptResult({
				cfg,
				channel: "discord",
				accountId: discordAccountId,
				tokenPatchKey: "token",
				tokenResult: {
					useEnv: true,
					token: null
				}
			}),
			applySet: async (cfg, value) => applySingleTokenPromptResult({
				cfg,
				channel: "discord",
				accountId: discordAccountId,
				tokenPatchKey: "token",
				tokenResult: {
					useEnv: false,
					token: value
				}
			})
		});
		next = tokenStep.cfg;
		const currentEntries = Object.entries(resolvedAccount.config.guilds ?? {}).flatMap(([guildKey, value]) => {
			const channels = value?.channels ?? {};
			const channelKeys = Object.keys(channels);
			if (channelKeys.length === 0) return [/^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey];
			return channelKeys.map((channelKey) => `${guildKey}/${channelKey}`);
		});
		next = await configureChannelAccessWithAllowlist({
			cfg: next,
			prompter,
			label: "Discord channels",
			currentPolicy: resolvedAccount.config.groupPolicy ?? "allowlist",
			currentEntries,
			placeholder: "My Server/#general, guildId/channelId, #support",
			updatePrompt: Boolean(resolvedAccount.config.guilds),
			setPolicy: (cfg, policy) => setAccountGroupPolicyForChannel({
				cfg,
				channel: "discord",
				accountId: discordAccountId,
				groupPolicy: policy
			}),
			resolveAllowlist: async ({ cfg, entries }) => {
				const accountWithTokens = resolveDiscordAccount({
					cfg,
					accountId: discordAccountId
				});
				let resolved = entries.map((input) => ({
					input,
					resolved: false
				}));
				const activeToken = accountWithTokens.token || tokenStep.resolvedValue || "";
				if (activeToken && entries.length > 0) try {
					resolved = await resolveDiscordChannelAllowlist({
						token: activeToken,
						entries
					});
					const resolvedChannels = resolved.filter((entry) => entry.resolved && entry.channelId);
					const resolvedGuilds = resolved.filter((entry) => entry.resolved && entry.guildId && !entry.channelId);
					const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
					await noteChannelLookupSummary({
						prompter,
						label: "Discord channels",
						resolvedSections: [{
							title: "Resolved channels",
							values: resolvedChannels.map((entry) => entry.channelId).filter((value) => Boolean(value))
						}, {
							title: "Resolved guilds",
							values: resolvedGuilds.map((entry) => entry.guildId).filter((value) => Boolean(value))
						}],
						unresolved
					});
				} catch (err) {
					await noteChannelLookupFailure({
						prompter,
						label: "Discord channels",
						error: err
					});
				}
				return resolved;
			},
			applyAllowlist: ({ cfg, resolved }) => {
				const allowlistEntries = [];
				for (const entry of resolved) {
					const guildKey = entry.guildId ?? (entry.guildName ? normalizeDiscordSlug(entry.guildName) : void 0) ?? "*";
					const channelKey = entry.channelId ?? (entry.channelName ? normalizeDiscordSlug(entry.channelName) : void 0);
					if (!channelKey && guildKey === "*") continue;
					allowlistEntries.push({
						guildKey,
						...channelKey ? { channelKey } : {}
					});
				}
				return setDiscordGuildChannelAllowlist(cfg, discordAccountId, allowlistEntries);
			}
		});
		return {
			cfg: next,
			accountId: discordAccountId
		};
	},
	dmPolicy: {
		label: "Discord",
		channel,
		policyKey: "channels.discord.dmPolicy",
		allowFromKey: "channels.discord.allowFrom",
		getCurrent: (cfg) => cfg.channels?.discord?.dmPolicy ?? cfg.channels?.discord?.dm?.policy ?? "pairing",
		setPolicy: (cfg, policy) => setLegacyChannelDmPolicyWithAllowFrom({
			cfg,
			channel: "discord",
			dmPolicy: policy
		}),
		promptAllowFrom: promptDiscordAllowFrom
	},
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel, false)
};
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
function buildComputedAccountStatusSnapshot(params) {
	const { accountId, name, enabled, configured, runtime, probe } = params;
	return buildBaseAccountStatusSnapshot({
		account: {
			accountId,
			name,
			enabled,
			configured
		},
		runtime,
		probe
	});
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
export { DEFAULT_ACCOUNT_ID, DiscordConfigSchema, PAIRING_APPROVED_MESSAGE, applyAccountNameToChannelSection, autoBindSpawnedDiscordSubagent, buildChannelConfigSchema, buildComputedAccountStatusSnapshot, buildTokenChannelStatusSummary, collectDiscordAuditChannelIds, collectDiscordStatusIssues, deleteAccountFromConfigSection, discordOnboardingAdapter, emptyPluginConfigSchema, formatPairingApproveHint, getChatChannelMeta, inspectDiscordAccount, listDiscordAccountIds, listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, listThreadBindingsBySessionKey, looksLikeDiscordTargetId, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeDiscordMessagingTarget, normalizeDiscordOutboundTarget, projectCredentialSnapshotFields, resolveConfiguredFromCredentialStatuses, resolveDefaultDiscordAccountId, resolveDefaultGroupPolicy, resolveDiscordAccount, resolveDiscordGroupRequireMention, resolveDiscordGroupToolPolicy, resolveOpenProviderRuntimeGroupPolicy, setAccountEnabledInConfigSection, unbindThreadBindingsBySessionKey };
