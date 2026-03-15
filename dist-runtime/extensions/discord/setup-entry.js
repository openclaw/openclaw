import "../../provider-env-vars-BfZUtZAn.js";
import { Jt as resolveDiscordAccount, Wt as listDiscordAccountIds, bn as buildChannelConfigSchema, m as getChatChannelMeta, qt as resolveDefaultDiscordAccountId } from "../../resolve-route-BZ4hHpx2.js";
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
import { $c as inspectDiscordAccount, bt as formatAllowFromLowercase, ff as DiscordConfigSchema, oc as createDiscordSetupWizardProxy, sc as discordSetupAdapter, vp as createScopedAccountConfigAccessors, yp as createScopedChannelConfigBase } from "../../auth-profiles-CuJtivJK.js";
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
//#region extensions/discord/src/channel.setup.ts
async function loadDiscordChannelRuntime() {
	return await import("../../channel.runtime-9muoc0AS.js");
}
const discordConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveDiscordAccount({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.config.dm?.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
	resolveDefaultTo: (account) => account.config.defaultTo
});
const discordConfigBase = createScopedChannelConfigBase({
	sectionKey: "discord",
	listAccountIds: listDiscordAccountIds,
	resolveAccount: (cfg, accountId) => resolveDiscordAccount({
		cfg,
		accountId
	}),
	inspectAccount: (cfg, accountId) => inspectDiscordAccount({
		cfg,
		accountId
	}),
	defaultAccountId: resolveDefaultDiscordAccountId,
	clearBaseFields: ["token", "name"]
});
const discordSetupWizard = createDiscordSetupWizardProxy(async () => ({ discordSetupWizard: (await loadDiscordChannelRuntime()).discordSetupWizard }));
//#endregion
//#region extensions/discord/setup-entry.ts
var setup_entry_default = { plugin: {
	id: "discord",
	meta: { ...getChatChannelMeta("discord") },
	setupWizard: discordSetupWizard,
	capabilities: {
		chatTypes: [
			"direct",
			"channel",
			"thread"
		],
		polls: true,
		reactions: true,
		threads: true,
		media: true,
		nativeCommands: true
	},
	streaming: { blockStreamingCoalesceDefaults: {
		minChars: 1500,
		idleMs: 1e3
	} },
	reload: { configPrefixes: ["channels.discord"] },
	configSchema: buildChannelConfigSchema(DiscordConfigSchema),
	config: {
		...discordConfigBase,
		isConfigured: (account) => Boolean(account.token?.trim()),
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.token?.trim()),
			tokenSource: account.tokenSource
		}),
		...discordConfigAccessors
	},
	setup: discordSetupAdapter
} };
//#endregion
export { setup_entry_default as default };
