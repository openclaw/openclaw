import "./github-copilot-token-ClyulAWr.js";
import { Cn as normalizeAccountId, Sn as DEFAULT_ACCOUNT_ID } from "./query-expansion-D0gbMLFj.js";
import { Bi as getChatChannelMeta, Li as listIMessageAccountIds, Ni as looksLikeHandleOrPhoneTarget, Pi as trimMessagingTarget, Ri as resolveDefaultIMessageAccountId, Ui as deleteAccountFromConfigSection, Vi as formatPairingApproveHint, Wi as setAccountEnabledInConfigSection, _i as resolveIMessageConfigAllowFrom, a as IMessageConfigSchema, ci as resolveIMessageGroupToolPolicy, di as resolveAllowlistProviderRuntimeGroupPolicy, fi as resolveDefaultGroupPolicy, g as formatDocsLink, gi as formatTrimmedAllowFromEntries, hi as normalizeIMessageHandle, nn as resolveChannelMediaMaxBytes, si as resolveIMessageGroupRequireMention, t as detectBinary, vi as resolveIMessageConfigDefaultTo, zi as resolveIMessageAccount } from "./onboard-helpers-D0XAAz9b.js";
import "./logger-_x5WOezH.js";
import "./paths-D6tDENa_.js";
import "./fetch-BF0xn7kd.js";
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
//#region src/channels/plugins/normalize/imessage.ts
const SERVICE_PREFIXES = [
	"imessage:",
	"sms:",
	"auto:"
];
const CHAT_TARGET_PREFIX_RE = /^(chat_id:|chatid:|chat:|chat_guid:|chatguid:|guid:|chat_identifier:|chatidentifier:|chatident:)/i;
function normalizeIMessageMessagingTarget(raw) {
	const trimmed = trimMessagingTarget(raw);
	if (!trimmed) return;
	const lower = trimmed.toLowerCase();
	for (const prefix of SERVICE_PREFIXES) if (lower.startsWith(prefix)) {
		const normalizedHandle = normalizeIMessageHandle(trimmed.slice(prefix.length).trim());
		if (!normalizedHandle) return;
		if (CHAT_TARGET_PREFIX_RE.test(normalizedHandle)) return normalizedHandle;
		return `${prefix}${normalizedHandle}`;
	}
	return normalizeIMessageHandle(trimmed) || void 0;
}
function looksLikeIMessageTargetId(raw) {
	const trimmed = trimMessagingTarget(raw);
	if (!trimmed) return false;
	if (CHAT_TARGET_PREFIX_RE.test(trimmed)) return true;
	return looksLikeHandleOrPhoneTarget({
		raw: trimmed,
		prefixPattern: /^(imessage:|sms:|auto:)/i
	});
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
function parseOnboardingEntriesWithParser(raw, parseEntry) {
	const parts = splitOnboardingEntries(String(raw ?? ""));
	const entries = [];
	for (const part of parts) {
		const parsed = parseEntry(part);
		if ("error" in parsed) return {
			entries: [],
			error: parsed.error
		};
		entries.push(parsed.value);
	}
	return { entries: normalizeAllowFromEntries(entries) };
}
function parseOnboardingEntriesAllowingWildcard(raw, parseEntry) {
	return parseOnboardingEntriesWithParser(raw, (entry) => {
		if (entry === "*") return { value: "*" };
		return parseEntry(entry);
	});
}
function normalizeAllowFromEntries(entries, normalizeEntry) {
	const normalized = entries.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => {
		if (entry === "*") return "*";
		if (!normalizeEntry) return entry;
		const value = normalizeEntry(entry);
		return typeof value === "string" ? value.trim() : "";
	}).filter(Boolean);
	return [...new Set(normalized)];
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
function setAccountAllowFromForChannel(params) {
	const { cfg, channel, accountId, allowFrom } = params;
	return patchConfigForScopedAccount({
		cfg,
		channel,
		accountId,
		patch: { allowFrom },
		ensureEnabled: false
	});
}
function setChannelDmPolicyWithAllowFrom(params) {
	const { cfg, channel, dmPolicy } = params;
	const allowFrom = dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.[channel]?.allowFrom) : void 0;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[channel]: {
				...cfg.channels?.[channel],
				dmPolicy,
				...allowFrom ? { allowFrom } : {}
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
async function promptParsedAllowFromForScopedChannel(params) {
	const accountId = resolveOnboardingAccountId({
		accountId: params.accountId,
		defaultAccountId: params.defaultAccountId
	});
	const existing = params.getExistingAllowFrom({
		cfg: params.cfg,
		accountId
	});
	await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
	const entry = await params.prompter.text({
		message: params.message,
		placeholder: params.placeholder,
		initialValue: existing[0] ? String(existing[0]) : void 0,
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			return params.parseEntries(raw).error;
		}
	});
	const unique = mergeAllowFromEntries(void 0, params.parseEntries(String(entry)).entries);
	return setAccountAllowFromForChannel({
		cfg: params.cfg,
		channel: params.channel,
		accountId,
		allowFrom: unique
	});
}
//#endregion
//#region src/channels/plugins/onboarding/imessage.ts
const channel = "imessage";
function parseIMessageAllowFromEntries(raw) {
	return parseOnboardingEntriesAllowingWildcard(raw, (entry) => {
		const lower = entry.toLowerCase();
		if (lower.startsWith("chat_id:")) {
			const id = entry.slice(8).trim();
			if (!/^\d+$/.test(id)) return { error: `Invalid chat_id: ${entry}` };
			return { value: entry };
		}
		if (lower.startsWith("chat_guid:")) {
			if (!entry.slice(10).trim()) return { error: "Invalid chat_guid entry" };
			return { value: entry };
		}
		if (lower.startsWith("chat_identifier:")) {
			if (!entry.slice(16).trim()) return { error: "Invalid chat_identifier entry" };
			return { value: entry };
		}
		if (!normalizeIMessageHandle(entry)) return { error: `Invalid handle: ${entry}` };
		return { value: entry };
	});
}
async function promptIMessageAllowFrom(params) {
	return promptParsedAllowFromForScopedChannel({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId,
		defaultAccountId: resolveDefaultIMessageAccountId(params.cfg),
		prompter: params.prompter,
		noteTitle: "iMessage allowlist",
		noteLines: [
			"Allowlist iMessage DMs by handle or chat target.",
			"Examples:",
			"- +15555550123",
			"- user@example.com",
			"- chat_id:123",
			"- chat_guid:... or chat_identifier:...",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/imessage", "imessage")}`
		],
		message: "iMessage allowFrom (handle or chat_id)",
		placeholder: "+15555550123, user@example.com, chat_id:123",
		parseEntries: parseIMessageAllowFromEntries,
		getExistingAllowFrom: ({ cfg, accountId }) => {
			return resolveIMessageAccount({
				cfg,
				accountId
			}).config.allowFrom ?? [];
		}
	});
}
const imessageOnboardingAdapter = {
	channel,
	getStatus: async ({ cfg }) => {
		const configured = listIMessageAccountIds(cfg).some((accountId) => {
			const account = resolveIMessageAccount({
				cfg,
				accountId
			});
			return Boolean(account.config.cliPath || account.config.dbPath || account.config.allowFrom || account.config.service || account.config.region);
		});
		const imessageCliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
		const imessageCliDetected = await detectBinary(imessageCliPath);
		return {
			channel,
			configured,
			statusLines: [`iMessage: ${configured ? "configured" : "needs setup"}`, `imsg: ${imessageCliDetected ? "found" : "missing"} (${imessageCliPath})`],
			selectionHint: imessageCliDetected ? "imsg found" : "imsg missing",
			quickstartScore: imessageCliDetected ? 1 : 0
		};
	},
	configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
		const defaultIMessageAccountId = resolveDefaultIMessageAccountId(cfg);
		const imessageAccountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "iMessage",
			accountOverride: accountOverrides.imessage,
			shouldPromptAccountIds,
			listAccountIds: listIMessageAccountIds,
			defaultAccountId: defaultIMessageAccountId
		});
		let next = cfg;
		let resolvedCliPath = resolveIMessageAccount({
			cfg: next,
			accountId: imessageAccountId
		}).config.cliPath ?? "imsg";
		if (!await detectBinary(resolvedCliPath)) {
			const entered = await prompter.text({
				message: "imsg CLI path",
				initialValue: resolvedCliPath,
				validate: (value) => value?.trim() ? void 0 : "Required"
			});
			resolvedCliPath = String(entered).trim();
			if (!resolvedCliPath) await prompter.note("imsg CLI path required to enable iMessage.", "iMessage");
		}
		if (resolvedCliPath) next = patchChannelConfigForAccount({
			cfg: next,
			channel: "imessage",
			accountId: imessageAccountId,
			patch: { cliPath: resolvedCliPath }
		});
		await prompter.note([
			"This is still a work in progress.",
			"Ensure OpenClaw has Full Disk Access to Messages DB.",
			"Grant Automation permission for Messages when prompted.",
			"List chats with: imsg chats --limit 20",
			`Docs: ${formatDocsLink("/imessage", "imessage")}`
		].join("\n"), "iMessage next steps");
		return {
			cfg: next,
			accountId: imessageAccountId
		};
	},
	dmPolicy: {
		label: "iMessage",
		channel,
		policyKey: "channels.imessage.dmPolicy",
		allowFromKey: "channels.imessage.allowFrom",
		getCurrent: (cfg) => cfg.channels?.imessage?.dmPolicy ?? "pairing",
		setPolicy: (cfg, policy) => setChannelDmPolicyWithAllowFrom({
			cfg,
			channel: "imessage",
			dmPolicy: policy
		}),
		promptAllowFrom: promptIMessageAllowFrom
	},
	disable: (cfg) => setOnboardingChannelEnabled(cfg, channel, false)
};
//#endregion
//#region src/plugin-sdk/status-helpers.ts
function collectStatusIssuesFromLastError(channel, accounts) {
	return accounts.flatMap((account) => {
		const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
		if (!lastError) return [];
		return [{
			channel,
			accountId: account.accountId,
			kind: "runtime",
			message: `Channel error: ${lastError}`
		}];
	});
}
//#endregion
export { DEFAULT_ACCOUNT_ID, IMessageConfigSchema, PAIRING_APPROVED_MESSAGE, applyAccountNameToChannelSection, buildChannelConfigSchema, collectStatusIssuesFromLastError, deleteAccountFromConfigSection, emptyPluginConfigSchema, formatPairingApproveHint, formatTrimmedAllowFromEntries, getChatChannelMeta, imessageOnboardingAdapter, listIMessageAccountIds, looksLikeIMessageTargetId, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeIMessageMessagingTarget, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultIMessageAccountId, resolveIMessageAccount, resolveIMessageConfigAllowFrom, resolveIMessageConfigDefaultTo, resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy, setAccountEnabledInConfigSection };
