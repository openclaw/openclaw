import { Al as promptParsedAllowFromForScopedChannel, Cl as formatDocsLink, Ea as detectBinary, Fl as setChannelDmPolicyWithAllowFrom, Il as setSetupChannelEnabled, ct as resolveIMessageAccount, ot as listIMessageAccountIds, st as resolveDefaultIMessageAccountId } from "./auth-profiles-CuJtivJK.js";
import { r as parseIMessageAllowFromEntries } from "./setup-core-BxTwnA0N.js";
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
export { imessageSetupWizard as t };
