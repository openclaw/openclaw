import "../../provider-env-vars-BfZUtZAn.js";
import { bn as buildChannelConfigSchema, m as getChatChannelMeta } from "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../paths-OqPpu-UR.js";
import { Gu as isSlackInteractiveRepliesEnabled, Iu as inspectSlackAccount, Ju as resolveSlackAccount, Ku as listSlackAccountIds, Sl as slackSetupAdapter, _f as SlackConfigSchema, bt as formatAllowFromLowercase, qu as resolveDefaultSlackAccountId, vp as createScopedAccountConfigAccessors, xl as createSlackSetupWizardProxy, yp as createScopedChannelConfigBase } from "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-BpDGEQsl.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import "../../compat-DDXNEdAm.js";
import "../../inbound-envelope-DsNRW6ln.js";
import "../../run-command-Psw08BkS.js";
import "../../device-pairing-DYWF-CWB.js";
import "../../line-iO245OTq.js";
import "../../upsert-with-lock-CLs2bE4R.js";
import "../../self-hosted-provider-setup-C4OZCxyb.js";
import "../../ollama-setup-BM-G12b6.js";
//#region extensions/slack/src/channel.setup.ts
async function loadSlackChannelRuntime() {
	return await import("../../channel.runtime-DGfq4vZk.js");
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
