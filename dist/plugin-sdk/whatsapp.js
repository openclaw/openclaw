import { at as DEFAULT_ACCOUNT_ID, ot as normalizeAccountId } from "./run-with-concurrency-xRatbMJ3.js";
import { Er as formatCliCommand, c as WhatsAppConfigSchema, sr as getChatChannelMeta } from "./config-CRz4FKeF.js";
import { f as isRecord, g as pathExists, h as normalizeE164 } from "./logger-D7wQiObc.js";
import "./paths-0d8fBoC4.js";
import { a as resolveWhatsAppAuthDir, i as resolveWhatsAppAccount, n as listWhatsAppAccountIds, r as resolveDefaultWhatsAppAccountId } from "./accounts-iQWyTiEu.js";
import { a as listWhatsAppDirectoryPeersFromConfig, i as listWhatsAppDirectoryGroupsFromConfig } from "./plugins-CwZgecUt.js";
import { D as resolveWhatsAppConfigDefaultTo, E as resolveWhatsAppConfigAllowFrom, O as looksLikeWhatsAppTargetId, T as formatWhatsAppConfigAllowFromEntries, _ as resolveWhatsAppGroupToolPolicy, g as resolveWhatsAppGroupRequireMention, h as resolveWhatsAppMentionStripPatterns, k as normalizeWhatsAppMessagingTarget, m as resolveWhatsAppGroupIntroHint } from "./thinking-BoczdzWi.js";
import "./accounts-jO6XV2rV.js";
import "./send-C-R3F21G.js";
import { f as readStringParam, r as createActionGate } from "./common-DNTE2oTg.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-B7IAo4Vj.js";
import { U as resolveAllowlistProviderRuntimeGroupPolicy, W as resolveDefaultGroupPolicy, n as formatDocsLink } from "./reply-HhSNKHH1.js";
import "./image-ops-B1VWuODj.js";
import "./pi-embedded-helpers-DMyZFsAj.js";
import "./accounts-v9AU8oT0.js";
import "./send-CS4PZL9j.js";
import "./github-copilot-token-CKKBybuX.js";
import "./paths-BE40Chxn.js";
import "./send-lT3Ae-By.js";
import { r as resolveWhatsAppHeartbeatRecipients } from "./channel-web-DL5I2i9F.js";
import "./tokens-DQlEd3qg.js";
import "./audio-transcription-runner-qHTnCKVv.js";
import "./image-BOGlGhJ6.js";
import "./chrome-P1IQrFbF.js";
import "./skills-DIehSA_V.js";
import "./path-alias-guards-DdX97sU3.js";
import "./redact-ANq-gzX9.js";
import "./errors-B3GIhEzD.js";
import "./fs-safe-CslOH3Os.js";
import "./proxy-env-Cl92ZZ5Z.js";
import "./store-BugB53gm.js";
import "./tool-images-B3pXxi1_.js";
import "./fetch-guard-BKC0sdGh.js";
import "./api-key-rotation-DEvy3-Sc.js";
import "./local-roots-DJgdju_5.js";
import "./proxy-fetch-CBTFtikU.js";
import "./deliver-R62h-3C6.js";
import "./commands-registry-C5Er1DxF.js";
import "./skill-commands-BDYokLJf.js";
import "./fetch-O45GieZo.js";
import "./diagnostic-ityfRGW2.js";
import "./pi-model-discovery-Dx8VN-H0.js";
import "./ir-PuFpKJJp.js";
import "./render-95l30zcf.js";
import "./send-aVL-rEiv.js";
import "./outbound-attachment-MKUdWPu8.js";
import "./send-DKMLFQCw.js";
import "./channel-activity-D3aGDxVz.js";
import "./tables-DGycOe97.js";
import "./proxy-BOZmkV9K.js";
import "./manager-DQZW1fmS.js";
import "./query-expansion--Duqch_o.js";
import "./outbound-BFAeZNnq.js";
import "./session-BU1y1MLA.js";
import { t as loginWeb } from "./login-ClFTkwhC.js";
import path from "node:path";

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
	if (params.accountId !== DEFAULT_ACCOUNT_ID) return true;
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
	}) && accountId === DEFAULT_ACCOUNT_ID) {
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
	const baseWithoutName = accountId === DEFAULT_ACCOUNT_ID ? (({ name: _ignored, ...rest }) => rest)(base ?? {}) : base ?? {};
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
	const defaultAccount = accounts[DEFAULT_ACCOUNT_ID] ?? {};
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

//#endregion
//#region src/channels/plugins/config-schema.ts
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
//#region src/channels/plugins/helpers.ts
function formatPairingApproveHint(channelId) {
	return `Approve via: ${formatCliCommand(`openclaw pairing list ${channelId}`)} / ${formatCliCommand(`openclaw pairing approve ${channelId} <code>`)}`;
}

//#endregion
//#region src/config/merge-config.ts
function mergeConfigSection(base, patch, options = {}) {
	const next = { ...base ?? void 0 };
	for (const [key, value] of Object.entries(patch)) {
		if (value === void 0) {
			if (options.unsetOnUndefined?.includes(key)) delete next[key];
			continue;
		}
		next[key] = value;
	}
	return next;
}
function mergeWhatsAppConfig(cfg, patch, options) {
	return {
		...cfg,
		channels: {
			...cfg.channels,
			whatsapp: mergeConfigSection(cfg.channels?.whatsapp, patch, options)
		}
	};
}

//#endregion
//#region src/plugin-sdk/onboarding.ts
async function promptAccountId$1(params) {
	const existingIds = params.listAccountIds(params.cfg);
	const initial = params.currentId?.trim() || params.defaultAccountId || DEFAULT_ACCOUNT_ID;
	const choice = await params.prompter.select({
		message: `${params.label} account`,
		options: [...existingIds.map((id) => ({
			value: id,
			label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id
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
function splitOnboardingEntries(raw) {
	return raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
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

//#endregion
//#region src/channels/plugins/onboarding/whatsapp.ts
const channel = "whatsapp";
function setWhatsAppDmPolicy(cfg, dmPolicy) {
	return mergeWhatsAppConfig(cfg, { dmPolicy });
}
function setWhatsAppAllowFrom(cfg, allowFrom) {
	return mergeWhatsAppConfig(cfg, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}
function setWhatsAppSelfChatMode(cfg, selfChatMode) {
	return mergeWhatsAppConfig(cfg, { selfChatMode });
}
async function detectWhatsAppLinked(cfg, accountId) {
	const { authDir } = resolveWhatsAppAuthDir({
		cfg,
		accountId
	});
	return await pathExists(path.join(authDir, "creds.json"));
}
async function promptWhatsAppOwnerAllowFrom(params) {
	const { prompter, existingAllowFrom } = params;
	await prompter.note("We need the sender/owner number so OpenClaw can allowlist you.", "WhatsApp number");
	const entry = await prompter.text({
		message: "Your personal WhatsApp number (the phone you will message from)",
		placeholder: "+15555550123",
		initialValue: existingAllowFrom[0],
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			if (!normalizeE164(raw)) return `Invalid number: ${raw}`;
		}
	});
	const normalized = normalizeE164(String(entry).trim());
	if (!normalized) throw new Error("Invalid WhatsApp owner number (expected E.164 after validation).");
	return {
		normalized,
		allowFrom: normalizeAllowFromEntries([...existingAllowFrom.filter((item) => item !== "*"), normalized], normalizeE164)
	};
}
async function applyWhatsAppOwnerAllowlist(params) {
	const { normalized, allowFrom } = await promptWhatsAppOwnerAllowFrom({
		prompter: params.prompter,
		existingAllowFrom: params.existingAllowFrom
	});
	let next = setWhatsAppSelfChatMode(params.cfg, true);
	next = setWhatsAppDmPolicy(next, "allowlist");
	next = setWhatsAppAllowFrom(next, allowFrom);
	await params.prompter.note([...params.messageLines, `- allowFrom includes ${normalized}`].join("\n"), params.title);
	return next;
}
function parseWhatsAppAllowFromEntries(raw) {
	const parts = splitOnboardingEntries(raw);
	if (parts.length === 0) return { entries: [] };
	const entries = [];
	for (const part of parts) {
		if (part === "*") {
			entries.push("*");
			continue;
		}
		const normalized = normalizeE164(part);
		if (!normalized) return {
			entries: [],
			invalidEntry: part
		};
		entries.push(normalized);
	}
	return { entries: normalizeAllowFromEntries(entries, normalizeE164) };
}
async function promptWhatsAppAllowFrom(cfg, _runtime, prompter, options) {
	const existingPolicy = cfg.channels?.whatsapp?.dmPolicy ?? "pairing";
	const existingAllowFrom = cfg.channels?.whatsapp?.allowFrom ?? [];
	const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
	if (options?.forceAllowlist) return await applyWhatsAppOwnerAllowlist({
		cfg,
		prompter,
		existingAllowFrom,
		title: "WhatsApp allowlist",
		messageLines: ["Allowlist mode enabled."]
	});
	await prompter.note([
		"WhatsApp direct chats are gated by `channels.whatsapp.dmPolicy` + `channels.whatsapp.allowFrom`.",
		"- pairing (default): unknown senders get a pairing code; owner approves",
		"- allowlist: unknown senders are blocked",
		"- open: public inbound DMs (requires allowFrom to include \"*\")",
		"- disabled: ignore WhatsApp DMs",
		"",
		`Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
		`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
	].join("\n"), "WhatsApp DM access");
	if (await prompter.select({
		message: "WhatsApp phone setup",
		options: [{
			value: "personal",
			label: "This is my personal phone number"
		}, {
			value: "separate",
			label: "Separate phone just for OpenClaw"
		}]
	}) === "personal") return await applyWhatsAppOwnerAllowlist({
		cfg,
		prompter,
		existingAllowFrom,
		title: "WhatsApp personal phone",
		messageLines: ["Personal phone mode enabled.", "- dmPolicy set to allowlist (pairing skipped)"]
	});
	const policy = await prompter.select({
		message: "WhatsApp DM policy",
		options: [
			{
				value: "pairing",
				label: "Pairing (recommended)"
			},
			{
				value: "allowlist",
				label: "Allowlist only (block unknown senders)"
			},
			{
				value: "open",
				label: "Open (public inbound DMs)"
			},
			{
				value: "disabled",
				label: "Disabled (ignore WhatsApp DMs)"
			}
		]
	});
	let next = setWhatsAppSelfChatMode(cfg, false);
	next = setWhatsAppDmPolicy(next, policy);
	if (policy === "open") {
		const allowFrom = normalizeAllowFromEntries(["*", ...existingAllowFrom], normalizeE164);
		next = setWhatsAppAllowFrom(next, allowFrom.length > 0 ? allowFrom : ["*"]);
		return next;
	}
	if (policy === "disabled") return next;
	const allowOptions = existingAllowFrom.length > 0 ? [
		{
			value: "keep",
			label: "Keep current allowFrom"
		},
		{
			value: "unset",
			label: "Unset allowFrom (use pairing approvals only)"
		},
		{
			value: "list",
			label: "Set allowFrom to specific numbers"
		}
	] : [{
		value: "unset",
		label: "Unset allowFrom (default)"
	}, {
		value: "list",
		label: "Set allowFrom to specific numbers"
	}];
	const mode = await prompter.select({
		message: "WhatsApp allowFrom (optional pre-allowlist)",
		options: allowOptions.map((opt) => ({
			value: opt.value,
			label: opt.label
		}))
	});
	if (mode === "keep") {} else if (mode === "unset") next = setWhatsAppAllowFrom(next, void 0);
	else {
		const allowRaw = await prompter.text({
			message: "Allowed sender numbers (comma-separated, E.164)",
			placeholder: "+15555550123, +447700900123",
			validate: (value) => {
				const raw = String(value ?? "").trim();
				if (!raw) return "Required";
				const parsed = parseWhatsAppAllowFromEntries(raw);
				if (parsed.entries.length === 0 && !parsed.invalidEntry) return "Required";
				if (parsed.invalidEntry) return `Invalid number: ${parsed.invalidEntry}`;
			}
		});
		const parsed = parseWhatsAppAllowFromEntries(String(allowRaw));
		next = setWhatsAppAllowFrom(next, parsed.entries);
	}
	return next;
}
const whatsappOnboardingAdapter = {
	channel,
	getStatus: async ({ cfg, accountOverrides }) => {
		const defaultAccountId = resolveDefaultWhatsAppAccountId(cfg);
		const accountId = resolveOnboardingAccountId({
			accountId: accountOverrides.whatsapp,
			defaultAccountId
		});
		const linked = await detectWhatsAppLinked(cfg, accountId);
		return {
			channel,
			configured: linked,
			statusLines: [`WhatsApp (${accountId === DEFAULT_ACCOUNT_ID ? "default" : accountId}): ${linked ? "linked" : "not linked"}`],
			selectionHint: linked ? "linked" : "not linked",
			quickstartScore: linked ? 5 : 4
		};
	},
	configure: async ({ cfg, runtime, prompter, options, accountOverrides, shouldPromptAccountIds, forceAllowFrom }) => {
		const accountId = await resolveAccountIdForConfigure({
			cfg,
			prompter,
			label: "WhatsApp",
			accountOverride: accountOverrides.whatsapp,
			shouldPromptAccountIds: Boolean(shouldPromptAccountIds || options?.promptWhatsAppAccountId),
			listAccountIds: listWhatsAppAccountIds,
			defaultAccountId: resolveDefaultWhatsAppAccountId(cfg)
		});
		let next = cfg;
		if (accountId !== DEFAULT_ACCOUNT_ID) next = {
			...next,
			channels: {
				...next.channels,
				whatsapp: {
					...next.channels?.whatsapp,
					accounts: {
						...next.channels?.whatsapp?.accounts,
						[accountId]: {
							...next.channels?.whatsapp?.accounts?.[accountId],
							enabled: next.channels?.whatsapp?.accounts?.[accountId]?.enabled ?? true
						}
					}
				}
			}
		};
		const linked = await detectWhatsAppLinked(next, accountId);
		const { authDir } = resolveWhatsAppAuthDir({
			cfg: next,
			accountId
		});
		if (!linked) await prompter.note([
			"Scan the QR with WhatsApp on your phone.",
			`Credentials are stored under ${authDir}/ for future runs.`,
			`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
		].join("\n"), "WhatsApp linking");
		if (await prompter.confirm({
			message: linked ? "WhatsApp already linked. Re-link now?" : "Link WhatsApp now (QR)?",
			initialValue: !linked
		})) try {
			await loginWeb(false, void 0, runtime, accountId);
		} catch (err) {
			runtime.error(`WhatsApp login failed: ${String(err)}`);
			await prompter.note(`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`, "WhatsApp help");
		}
		else if (!linked) await prompter.note(`Run \`${formatCliCommand("openclaw channels login")}\` later to link WhatsApp.`, "WhatsApp");
		next = await promptWhatsAppAllowFrom(next, runtime, prompter, { forceAllowlist: forceAllowFrom });
		return {
			cfg: next,
			accountId
		};
	},
	onAccountRecorded: (accountId, options) => {
		options?.onWhatsAppAccountId?.(accountId);
	}
};

//#endregion
//#region src/channels/plugins/status-issues/shared.ts
function asString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function collectIssuesForEnabledAccounts(params) {
	const issues = [];
	for (const entry of params.accounts) {
		const account = params.readAccount(entry);
		if (!account || account.enabled === false) continue;
		const accountId = asString(account.accountId) ?? "default";
		params.collectIssues({
			account,
			accountId,
			issues
		});
	}
	return issues;
}

//#endregion
//#region src/channels/plugins/status-issues/whatsapp.ts
function readWhatsAppAccountStatus(value) {
	if (!isRecord(value)) return null;
	return {
		accountId: value.accountId,
		enabled: value.enabled,
		linked: value.linked,
		connected: value.connected,
		running: value.running,
		reconnectAttempts: value.reconnectAttempts,
		lastError: value.lastError
	};
}
function collectWhatsAppStatusIssues(accounts) {
	return collectIssuesForEnabledAccounts({
		accounts,
		readAccount: readWhatsAppAccountStatus,
		collectIssues: ({ account, accountId, issues }) => {
			const linked = account.linked === true;
			const running = account.running === true;
			const connected = account.connected === true;
			const reconnectAttempts = typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : null;
			const lastError = asString(account.lastError);
			if (!linked) {
				issues.push({
					channel: "whatsapp",
					accountId,
					kind: "auth",
					message: "Not linked (no WhatsApp Web session).",
					fix: `Run: ${formatCliCommand("openclaw channels login")} (scan QR on the gateway host).`
				});
				return;
			}
			if (running && !connected) issues.push({
				channel: "whatsapp",
				accountId,
				kind: "runtime",
				message: `Linked but disconnected${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
				fix: `Run: ${formatCliCommand("openclaw doctor")} (or restart the gateway). If it persists, relink via channels login and check logs.`
			});
		}
	});
}

//#endregion
export { DEFAULT_ACCOUNT_ID, WhatsAppConfigSchema, applyAccountNameToChannelSection, buildChannelConfigSchema, collectWhatsAppStatusIssues, createActionGate, emptyPluginConfigSchema, formatPairingApproveHint, formatWhatsAppConfigAllowFromEntries, getChatChannelMeta, listWhatsAppAccountIds, listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, looksLikeWhatsAppTargetId, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeE164, normalizeWhatsAppMessagingTarget, readStringParam, resolveAllowlistProviderRuntimeGroupPolicy, resolveDefaultGroupPolicy, resolveDefaultWhatsAppAccountId, resolveWhatsAppAccount, resolveWhatsAppConfigAllowFrom, resolveWhatsAppConfigDefaultTo, resolveWhatsAppGroupIntroHint, resolveWhatsAppGroupRequireMention, resolveWhatsAppGroupToolPolicy, resolveWhatsAppHeartbeatRecipients, resolveWhatsAppMentionStripPatterns, resolveWhatsAppOutboundTarget, whatsappOnboardingAdapter };