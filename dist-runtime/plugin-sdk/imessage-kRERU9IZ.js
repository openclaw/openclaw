import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-CbP51u9x.js";
import { I as getChatChannelMeta, bt as resolveDefaultGroupPolicy, yt as resolveAllowlistProviderRuntimeGroupPolicy } from "./runtime-DRRlb-lt.js";
import { At as resolveServicePrefixedChatTarget, Ct as looksLikeIMessageTargetId, Dt as parseChatAllowTargetPrefixes, Et as createAllowedChatSenderMatcher, Mt as resolveServicePrefixedTarget, Ot as parseChatTargetPrefixesOrThrow, St as resolveIMessageAccount, Tt as normalizeIMessageHandle, bt as listIMessageAccountIds, d as setChannelDmPolicyWithAllowFrom, f as setSetupChannelEnabled, gc as resolveIMessageGroupToolPolicy, hc as resolveIMessageGroupRequireMention, i as parseSetupEntriesAllowingWildcard, jt as resolveServicePrefixedOrChatAllowTarget, kt as resolveServicePrefixedAllowTarget, o as promptParsedAllowFromForScopedChannel, wa as detectBinary, wt as normalizeIMessageMessagingTarget, xt as resolveDefaultIMessageAccountId, yt as sendMessageIMessage } from "./setup-wizard-helpers-Bds9SZeS.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-DEV1v8zB.js";
import "./tmp-openclaw-dir-DGafsubg.js";
import "./subsystem-BunQspj4.js";
import "./utils-C9epF7GR.js";
import "./fetch-s6LpGbVn.js";
import "./retry-Bdb5CNwD.js";
import { t as emptyPluginConfigSchema } from "./config-schema-X8cahxVt.js";
import "./paths-BoU0P6Xb.js";
import { J as collectStatusIssuesFromLastError, s as IMessageConfigSchema, t as resolveChannelMediaMaxBytes } from "./signal-Bycwzc0M.js";
import { a as formatPairingApproveHint, n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection, u as buildChannelConfigSchema } from "./config-helpers-C9J9Kf27.js";
import "./fetch-CokEYQHV.js";
import "./exec-LHBFP7K9.js";
import "./agent-scope-BAdJcjtf.js";
import { r as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "./setup-helpers-kuIKtuQw.js";
import { F as resolveIMessageConfigDefaultTo, P as resolveIMessageConfigAllowFrom, j as formatTrimmedAllowFromEntries, u as formatDocsLink } from "./reply-prefix-B-13vT7e.js";
import "./logger-kC9I1OJ3.js";
import "./fetch-guard-COmtEumo.js";
import "./resolve-route-5UJLanKQ.js";
import "./pairing-token-BUkoGEse.js";
import "./query-expansion-DrHj090u.js";
import "./redact-DDISwu8-.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./channel-plugin-common-cMzLzrLW.js";
import "./secret-file-B_1xic5c.js";
//#region extensions/imessage/src/setup-core.ts
const channel$1 = "imessage";
function parseIMessageAllowFromEntries(raw) {
	return parseSetupEntriesAllowingWildcard(raw, (entry) => {
		const lower = entry.toLowerCase();
		if (lower.startsWith("chat_id:")) {
			const id = entry.slice(8).trim();
			if (!/^\d+$/.test(id)) {return { error: `Invalid chat_id: ${entry}` };}
			return { value: entry };
		}
		if (lower.startsWith("chat_guid:")) {
			if (!entry.slice(10).trim()) {return { error: "Invalid chat_guid entry" };}
			return { value: entry };
		}
		if (lower.startsWith("chat_identifier:")) {
			if (!entry.slice(16).trim()) {return { error: "Invalid chat_identifier entry" };}
			return { value: entry };
		}
		if (!normalizeIMessageHandle(entry)) {return { error: `Invalid handle: ${entry}` };}
		return { value: entry };
	});
}
function buildIMessageSetupPatch(input) {
	return {
		...input.cliPath ? { cliPath: input.cliPath } : {},
		...input.dbPath ? { dbPath: input.dbPath } : {},
		...input.service ? { service: input.service } : {},
		...input.region ? { region: input.region } : {}
	};
}
const imessageSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel$1,
			accountId,
			name: input.name
		});
		const next = accountId !== "default" ? migrateBaseNameToDefaultAccount({
			cfg: namedConfig,
			channelKey: channel$1
		}) : namedConfig;
		if (accountId === "default") {return {
			...next,
			channels: {
				...next.channels,
				imessage: {
					...next.channels?.imessage,
					enabled: true,
					...buildIMessageSetupPatch(input)
				}
			}
		};}
		return {
			...next,
			channels: {
				...next.channels,
				imessage: {
					...next.channels?.imessage,
					enabled: true,
					accounts: {
						...next.channels?.imessage?.accounts,
						[accountId]: {
							...next.channels?.imessage?.accounts?.[accountId],
							enabled: true,
							...buildIMessageSetupPatch(input)
						}
					}
				}
			}
		};
	}
};
//#endregion
//#region extensions/imessage/src/setup-surface.ts
const channel = "imessage";
async function promptIMessageAllowFrom(params) {
	return promptParsedAllowFromForScopedChannel({
		cfg: params.cfg,
		channel,
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
		getExistingAllowFrom: ({ cfg, accountId }) => resolveIMessageAccount({
			cfg,
			accountId
		}).config.allowFrom ?? []
	});
}
const imessageDmPolicy = {
	label: "iMessage",
	channel,
	policyKey: "channels.imessage.dmPolicy",
	allowFromKey: "channels.imessage.allowFrom",
	getCurrent: (cfg) => cfg.channels?.imessage?.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy) => setChannelDmPolicyWithAllowFrom({
		cfg,
		channel,
		dmPolicy: policy
	}),
	promptAllowFrom: promptIMessageAllowFrom
};
const imessageSetupWizard = {
	channel,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs setup",
		configuredHint: "imsg found",
		unconfiguredHint: "imsg missing",
		configuredScore: 1,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => listIMessageAccountIds(cfg).some((accountId) => {
			const account = resolveIMessageAccount({
				cfg,
				accountId
			});
			return Boolean(account.config.cliPath || account.config.dbPath || account.config.allowFrom || account.config.service || account.config.region);
		}),
		resolveStatusLines: async ({ cfg, configured }) => {
			const cliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
			const cliDetected = await detectBinary(cliPath);
			return [`iMessage: ${configured ? "configured" : "needs setup"}`, `imsg: ${cliDetected ? "found" : "missing"} (${cliPath})`];
		},
		resolveSelectionHint: async ({ cfg }) => {
			return await detectBinary(cfg.channels?.imessage?.cliPath ?? "imsg") ? "imsg found" : "imsg missing";
		},
		resolveQuickstartScore: async ({ cfg }) => {
			return await detectBinary(cfg.channels?.imessage?.cliPath ?? "imsg") ? 1 : 0;
		}
	},
	credentials: [],
	textInputs: [{
		inputKey: "cliPath",
		message: "imsg CLI path",
		initialValue: ({ cfg, accountId }) => resolveIMessageAccount({
			cfg,
			accountId
		}).config.cliPath ?? "imsg",
		currentValue: ({ cfg, accountId }) => resolveIMessageAccount({
			cfg,
			accountId
		}).config.cliPath ?? "imsg",
		shouldPrompt: async ({ currentValue }) => !await detectBinary(currentValue ?? "imsg"),
		confirmCurrentValue: false,
		applyCurrentValue: true,
		helpTitle: "iMessage",
		helpLines: ["imsg CLI path required to enable iMessage."]
	}],
	completionNote: {
		title: "iMessage next steps",
		lines: [
			"This is still a work in progress.",
			"Ensure OpenClaw has Full Disk Access to Messages DB.",
			"Grant Automation permission for Messages when prompted.",
			"List chats with: imsg chats --limit 20",
			`Docs: ${formatDocsLink("/imessage", "imessage")}`
		]
	},
	dmPolicy: imessageDmPolicy,
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
};
//#endregion
export { DEFAULT_ACCOUNT_ID, IMessageConfigSchema, PAIRING_APPROVED_MESSAGE, applyAccountNameToChannelSection, buildChannelConfigSchema, collectStatusIssuesFromLastError, createAllowedChatSenderMatcher, deleteAccountFromConfigSection, emptyPluginConfigSchema, formatPairingApproveHint, formatTrimmedAllowFromEntries, getChatChannelMeta, imessageSetupAdapter, imessageSetupWizard, listIMessageAccountIds, looksLikeIMessageTargetId, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeIMessageMessagingTarget, parseChatAllowTargetPrefixes, parseChatTargetPrefixesOrThrow, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultIMessageAccountId, resolveIMessageAccount, resolveIMessageConfigAllowFrom, resolveIMessageConfigDefaultTo, resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy, resolveServicePrefixedAllowTarget, resolveServicePrefixedChatTarget, resolveServicePrefixedOrChatAllowTarget, resolveServicePrefixedTarget, sendMessageIMessage, setAccountEnabledInConfigSection };
