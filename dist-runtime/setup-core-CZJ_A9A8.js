import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { US as migrateBaseNameToDefaultAccount, VS as applyAccountNameToChannelSection, dn as listIMessageAccountIds, f_ as setChannelDmPolicyWithAllowFrom, fn as resolveDefaultIMessageAccountId, gn as normalizeIMessageHandle, i_ as parseSetupEntriesAllowingWildcard, o_ as promptParsedAllowFromForScopedChannel, p_ as setSetupChannelEnabled, pn as resolveIMessageAccount } from "./auth-profiles-DAOR1fRn.js";
import { r as normalizeAccountId } from "./account-id-DSKLJ_RM.js";
import { s as init_session_key } from "./session-key-B-Mu-04L.js";
//#region extensions/imessage/src/setup-core.ts
init_session_key();
const channel = "imessage";
function parseIMessageAllowFromEntries(raw) {
	return parseSetupEntriesAllowingWildcard(raw, (entry) => {
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
function buildIMessageSetupPatch(input) {
	return {
		...input.cliPath ? { cliPath: input.cliPath } : {},
		...input.dbPath ? { dbPath: input.dbPath } : {},
		...input.service ? { service: input.service } : {},
		...input.region ? { region: input.region } : {}
	};
}
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
const imessageSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel,
		accountId,
		name
	}),
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel,
			accountId,
			name: input.name
		});
		const next = accountId !== "default" ? migrateBaseNameToDefaultAccount({
			cfg: namedConfig,
			channelKey: channel
		}) : namedConfig;
		if (accountId === "default") return {
			...next,
			channels: {
				...next.channels,
				imessage: {
					...next.channels?.imessage,
					enabled: true,
					...buildIMessageSetupPatch(input)
				}
			}
		};
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
function createIMessageSetupWizardProxy(loadWizard) {
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
	return {
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
			resolveStatusLines: async (params) => (await loadWizard()).imessageSetupWizard.status.resolveStatusLines?.(params) ?? [],
			resolveSelectionHint: async (params) => await (await loadWizard()).imessageSetupWizard.status.resolveSelectionHint?.(params),
			resolveQuickstartScore: async (params) => await (await loadWizard()).imessageSetupWizard.status.resolveQuickstartScore?.(params)
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
			shouldPrompt: async (params) => {
				return await ((await loadWizard()).imessageSetupWizard.textInputs?.find((entry) => entry.inputKey === "cliPath"))?.shouldPrompt?.(params) ?? false;
			},
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
}
//#endregion
export { imessageSetupAdapter as n, parseIMessageAllowFromEntries as r, createIMessageSetupWizardProxy as t };
