import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-Bje8XVt9.js";
import { s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "../../channel-config-helpers-DAD0c7H8.js";
import "../../text-runtime-CFBwIeh_.js";
import { n as describeAccountSnapshot } from "../../account-helpers-CZufvFy_.js";
import { n as formatNormalizedAllowFromEntries } from "../../allow-from-95hK47_c.js";
import { a as resolveDefaultGoogleChatAccountId, i as listGoogleChatAccountIds, n as googlechatSetupAdapter, o as resolveGoogleChatAccount, s as resolveGoogleChatConfigAccessorAccount, t as googlechatSetupWizard } from "../../setup-surface-Du7i-UsT.js";
//#region extensions/googlechat/src/channel.setup.ts
const formatGoogleChatAllowFromEntry = (entry) => normalizeLowercaseStringOrEmpty(entry.trim().replace(/^(googlechat|google-chat|gchat):/i, "").replace(/^user:/i, "").replace(/^users\//i, ""));
const googlechatSetupPlugin = {
	id: "googlechat",
	meta: {
		id: "googlechat",
		label: "Google Chat",
		selectionLabel: "Google Chat (Chat API)",
		docsPath: "/channels/googlechat",
		docsLabel: "googlechat",
		blurb: "Google Workspace Chat app with HTTP webhook.",
		aliases: ["gchat", "google-chat"],
		order: 55,
		detailLabel: "Google Chat",
		systemImage: "message.badge",
		markdownCapable: true
	},
	setup: googlechatSetupAdapter,
	setupWizard: googlechatSetupWizard,
	capabilities: {
		chatTypes: [
			"direct",
			"group",
			"thread"
		],
		reactions: true,
		threads: true,
		media: true,
		nativeCommands: false,
		blockStreaming: true
	},
	streaming: { blockStreamingCoalesceDefaults: {
		minChars: 1500,
		idleMs: 1e3
	} },
	reload: { configPrefixes: ["channels.googlechat"] },
	config: {
		...createScopedChannelConfigAdapter({
			sectionKey: "googlechat",
			listAccountIds: listGoogleChatAccountIds,
			resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
			resolveAccessorAccount: resolveGoogleChatConfigAccessorAccount,
			defaultAccountId: resolveDefaultGoogleChatAccountId,
			clearBaseFields: [
				"serviceAccount",
				"serviceAccountFile",
				"audienceType",
				"audience",
				"webhookPath",
				"webhookUrl",
				"botUser",
				"name"
			],
			resolveAllowFrom: (account) => account.config.dm?.allowFrom,
			formatAllowFrom: (allowFrom) => formatNormalizedAllowFromEntries({
				allowFrom,
				normalizeEntry: formatGoogleChatAllowFromEntry
			}),
			resolveDefaultTo: (account) => account.config.defaultTo
		}),
		isConfigured: (account) => account.credentialSource !== "none",
		describeAccount: (account) => describeAccountSnapshot({
			account,
			configured: account.credentialSource !== "none",
			extra: { credentialSource: account.credentialSource }
		})
	}
};
//#endregion
export { googlechatSetupPlugin };
