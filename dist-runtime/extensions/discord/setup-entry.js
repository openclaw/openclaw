import "../../provider-env-vars-BfZUtZAn.js";
import { Zn as buildChannelConfigSchema, dn as init_accounts, f as getChatChannelMeta, fn as listDiscordAccountIds, gn as resolveDiscordAccount, hn as resolveDefaultDiscordAccountId } from "../../resolve-route-CQsiaDZO.js";
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
import { Ac as discordSetupAdapter, Am as createScopedAccountConfigAccessors, jm as createScopedChannelConfigBase, kc as createDiscordSetupWizardProxy, tu as inspectDiscordAccount, wt as formatAllowFromLowercase, yp as DiscordConfigSchema } from "../../auth-profiles-B70DPAVa.js";
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
//#region extensions/discord/src/channel.setup.ts
init_accounts();
async function loadDiscordChannelRuntime() {
	return await import("../../channel.runtime-DvjV6DcD.js");
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
