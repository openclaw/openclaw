import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { i as createPatchedAccountSetupAdapter } from "./setup-helpers-BC9z9VvG.js";
import { t as createSetupTranslator } from "./i18n-CWNhN747.js";
import { C as parseSetupEntriesAllowingWildcard, J as setSetupChannelEnabled, T as patchChannelConfigForAccount, V as setAccountAllowFromForChannel, j as promptParsedAllowFromForAccount, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import { a as createDelegatedSetupWizardProxy, c as createDelegatedTextInputShouldPrompt, o as createCliPathTextInput } from "./setup-wizard-proxy-B15glc8O.js";
import "./setup-runtime-BRbeJqWD.js";
import "./setup-tools-DuiMNzp5.js";
import { i as resolveIMessageAccount, r as resolveDefaultIMessageAccountId } from "./accounts-G6A_hywc.js";
import { o as normalizeIMessageHandle } from "./targets-C7radLf6.js";
//#region extensions/imessage/src/setup-core.ts
const t = createSetupTranslator();
const channel = "imessage";
const CHAT_TARGET_ALLOWFROM_PREFIXES = [
	"chat_id:",
	"chatid:",
	"chat:",
	"chat_guid:",
	"chatguid:",
	"guid:",
	"chat_identifier:",
	"chatidentifier:",
	"chatident:"
];
const SERVICE_ALLOWFROM_PREFIXES = [
	"imessage:",
	"sms:",
	"auto:"
];
function normalizeAllowFromEntryForPrefixCheck(entry) {
	let lower = normalizeLowercaseStringOrEmpty(entry);
	let stripped = true;
	while (stripped) {
		stripped = false;
		for (const prefix of SERVICE_ALLOWFROM_PREFIXES) if (lower.startsWith(prefix)) {
			lower = lower.slice(prefix.length).trim();
			stripped = true;
		}
	}
	return lower;
}
function parseIMessageAllowFromEntries(raw) {
	return parseSetupEntriesAllowingWildcard(raw, (entry) => {
		const lower = normalizeAllowFromEntryForPrefixCheck(entry);
		if (CHAT_TARGET_ALLOWFROM_PREFIXES.some((prefix) => lower.startsWith(prefix))) return { error: `iMessage allowFrom entries must be sender handles: ${entry}` };
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
			"Allowlist iMessage DMs by sender handle.",
			"Examples:",
			"- +15555550123",
			"- user@example.com",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/imessage", "imessage")}`
		],
		message: "iMessage allowFrom (sender handle)",
		placeholder: "+15555550123, user@example.com",
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
	configuredLabel: t("wizard.channels.statusConfigured"),
	unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
	configuredHint: t("wizard.imessage.imsgFound"),
	unconfiguredHint: t("wizard.imessage.imsgMissing"),
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
