import "../../provider-env-vars-BfZUtZAn.js";
import { Zn as buildChannelConfigSchema, f as getChatChannelMeta } from "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../paths-DAoqckDF.js";
import { $d as listSlackAccountIds, Am as createScopedAccountConfigAccessors, Cu as createSlackSetupWizardProxy, Hd as inspectSlackAccount, Zd as isSlackInteractiveRepliesEnabled, ef as resolveDefaultSlackAccountId, jm as createScopedChannelConfigBase, tf as resolveSlackAccount, wp as SlackConfigSchema, wt as formatAllowFromLowercase, wu as slackSetupAdapter } from "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-D6VN4BvH.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import "../../compat-CwB8x8Tr.js";
import "../../inbound-envelope-DsYY1Vpm.js";
import "../../run-command-B9zmAfEF.js";
import "../../device-pairing-CsJif6Rb.js";
import "../../line-DvbTO_h3.js";
import "../../upsert-with-lock-BkGBN4WL.js";
import "../../self-hosted-provider-setup-Bgv4n1Xv.js";
import "../../ollama-setup-CXkNt6CA.js";
//#region extensions/slack/src/channel.setup.ts
async function loadSlackChannelRuntime() {
	return await import("../../channel.runtime-C8p5rmiu.js");
}
function isSlackAccountConfigured(account) {
	const mode = account.config.mode ?? "socket";
	if (!Boolean(account.botToken?.trim())) return false;
	if (mode === "http") return Boolean(account.config.signingSecret?.trim());
	return Boolean(account.appToken?.trim());
}
const slackConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveSlackAccount({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.dm?.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
	resolveDefaultTo: (account) => account.config.defaultTo
});
const slackConfigBase = createScopedChannelConfigBase({
	sectionKey: "slack",
	listAccountIds: listSlackAccountIds,
	resolveAccount: (cfg, accountId) => resolveSlackAccount({
		cfg,
		accountId
	}),
	inspectAccount: (cfg, accountId) => inspectSlackAccount({
		cfg,
		accountId
	}),
	defaultAccountId: resolveDefaultSlackAccountId,
	clearBaseFields: [
		"botToken",
		"appToken",
		"name"
	]
});
const slackSetupWizard = createSlackSetupWizardProxy(async () => ({ slackSetupWizard: (await loadSlackChannelRuntime()).slackSetupWizard }));
//#endregion
//#region extensions/slack/setup-entry.ts
var setup_entry_default = { plugin: {
	id: "slack",
	meta: {
		...getChatChannelMeta("slack"),
		preferSessionLookupForAnnounceTarget: true
	},
	setupWizard: slackSetupWizard,
	capabilities: {
		chatTypes: [
			"direct",
			"channel",
			"thread"
		],
		reactions: true,
		threads: true,
		media: true,
		nativeCommands: true
	},
	agentPrompt: { messageToolHints: ({ cfg, accountId }) => isSlackInteractiveRepliesEnabled({
		cfg,
		accountId
	}) ? ["- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.", "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event."] : ["- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`)."] },
	streaming: { blockStreamingCoalesceDefaults: {
		minChars: 1500,
		idleMs: 1e3
	} },
	reload: { configPrefixes: ["channels.slack"] },
	configSchema: buildChannelConfigSchema(SlackConfigSchema),
	config: {
		...slackConfigBase,
		isConfigured: (account) => isSlackAccountConfigured(account),
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: isSlackAccountConfigured(account),
			botTokenSource: account.botTokenSource,
			appTokenSource: account.appTokenSource
		}),
		...slackConfigAccessors
	},
	setup: slackSetupAdapter
} };
//#endregion
export { setup_entry_default as default };
