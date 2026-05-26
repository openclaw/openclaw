import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { i as createPatchedAccountSetupAdapter } from "./setup-helpers-D1h9Zq-C.js";
import { C as parseSetupEntriesAllowingWildcard, J as setSetupChannelEnabled, T as patchChannelConfigForAccount, V as setAccountAllowFromForChannel, j as promptParsedAllowFromForAccount, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Cm8y4liy.js";
import { a as createDelegatedSetupWizardProxy, c as createDelegatedTextInputShouldPrompt, o as createCliPathTextInput } from "./setup-wizard-proxy-HeBrCZ-u.js";
import "./setup-runtime-hbbN9wHP.js";
import "./setup-tools-WOmaR-iv.js";
import { i as resolveIMessageAccount, r as resolveDefaultIMessageAccountId } from "./accounts-DwISomWw.js";
import { a as normalizeIMessageHandle } from "./targets-C6d5PYq2.js";
//#region extensions/imessage/src/setup-core.ts
const channel = "imessage";
function parseIMessageAllowFromEntries(raw) {
	return parseSetupEntriesAllowingWildcard(raw, (entry) => {
		const lower = normalizeLowercaseStringOrEmpty(entry);
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
	return promptParsedAllowFromForAccount({
		cfg: params.cfg,
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
		}).config.allowFrom ?? [],
		applyAllowFrom: ({ cfg, accountId, allowFrom }) => setAccountAllowFromForChannel({
			cfg,
			channel,
			accountId,
			allowFrom
		})
	});
}
const imessageDmPolicy = {
	label: "iMessage",
	channel,
	policyKey: "channels.imessage.dmPolicy",
	allowFromKey: "channels.imessage.allowFrom",
	resolveConfigKeys: (_cfg, accountId) => {
		const targetAccountId = accountId ?? resolveDefaultIMessageAccountId(_cfg);
		return targetAccountId !== "default" ? {
			policyKey: `channels.imessage.accounts.${targetAccountId}.dmPolicy`,
			allowFromKey: `channels.imessage.accounts.${targetAccountId}.allowFrom`
		} : {
			policyKey: "channels.imessage.dmPolicy",
			allowFromKey: "channels.imessage.allowFrom"
		};
	},
	getCurrent: (cfg, accountId) => {
		return resolveIMessageAccount({
			cfg,
			accountId: accountId ?? resolveDefaultIMessageAccountId(cfg)
		}).config.dmPolicy ?? "pairing";
	},
	setPolicy: (cfg, policy, accountId) => {
		const targetAccountId = accountId ?? resolveDefaultIMessageAccountId(cfg);
		return patchChannelConfigForAccount({
			cfg,
			channel,
			accountId: targetAccountId,
			patch: policy === "open" ? {
				dmPolicy: "open",
				allowFrom: mergeAllowFromEntries(resolveIMessageAccount({
					cfg,
					accountId: targetAccountId
				}).config.allowFrom, ["*"])
			} : { dmPolicy: policy }
		});
	},
	promptAllowFrom: promptIMessageAllowFrom
};
function resolveIMessageCliPath(params) {
	return resolveIMessageAccount(params).config.cliPath ?? "imsg";
}
function createIMessageCliPathTextInput(shouldPrompt) {
	return createCliPathTextInput({
		inputKey: "cliPath",
		message: "imsg CLI path",
		resolvePath: ({ cfg, accountId }) => resolveIMessageCliPath({
			cfg,
			accountId
		}),
		shouldPrompt,
		helpTitle: "iMessage",
		helpLines: ["imsg CLI path required to enable iMessage."]
	});
}
const imessageCompletionNote = {
	title: "iMessage next steps",
	lines: [
		"Run OpenClaw on the Mac signed into Messages, or set cliPath to an SSH wrapper that runs imsg on that Mac.",
		"Linux/Windows hosts cannot run the default local imsg path directly.",
		"Run `imsg launch`, then `openclaw channels status --probe` to verify private API actions.",
		"Ensure OpenClaw has Full Disk Access to Messages DB.",
		"Grant Automation permission for Messages when prompted.",
		"List chats with: imsg chats --limit 20",
		`Docs: ${formatDocsLink("/imessage", "imessage")}`
	]
};
const imessageSetupAdapter = createPatchedAccountSetupAdapter({
	channelKey: channel,
	buildPatch: (input) => buildIMessageSetupPatch(input)
});
const imessageSetupStatusBase = {
	configuredLabel: "configured",
	unconfiguredLabel: "needs setup",
	configuredHint: "imsg found",
	unconfiguredHint: "imsg missing",
	configuredScore: 1,
	unconfiguredScore: 0,
	resolveConfigured: ({ cfg, accountId }) => resolveIMessageAccount({
		cfg,
		accountId
	}).configured
};
function createIMessageSetupWizardProxy(loadWizard) {
	return createDelegatedSetupWizardProxy({
		channel,
		loadWizard,
		status: {
			configuredLabel: imessageSetupStatusBase.configuredLabel,
			unconfiguredLabel: imessageSetupStatusBase.unconfiguredLabel,
			configuredHint: imessageSetupStatusBase.configuredHint,
			unconfiguredHint: imessageSetupStatusBase.unconfiguredHint,
			configuredScore: imessageSetupStatusBase.configuredScore,
			unconfiguredScore: imessageSetupStatusBase.unconfiguredScore
		},
		credentials: [],
		textInputs: [createIMessageCliPathTextInput(createDelegatedTextInputShouldPrompt({
			loadWizard,
			inputKey: "cliPath"
		}))],
		completionNote: imessageCompletionNote,
		dmPolicy: imessageDmPolicy,
		disable: (cfg) => setSetupChannelEnabled(cfg, channel, false)
	});
}
//#endregion
export { imessageSetupAdapter as a, imessageDmPolicy as i, createIMessageSetupWizardProxy as n, imessageSetupStatusBase as o, imessageCompletionNote as r, createIMessageCliPathTextInput as t };
