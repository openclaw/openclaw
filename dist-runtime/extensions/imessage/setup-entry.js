import "../../provider-env-vars-BfZUtZAn.js";
import "../../session-key-BfFG0xOA.js";
import { _n as setAccountEnabledInConfigSection, bn as buildChannelConfigSchema, fn as buildAccountScopedDmSecurityPolicy, gn as deleteAccountFromConfigSection, m as getChatChannelMeta } from "../../resolve-route-BZ4hHpx2.js";
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
import { Tp as resolveIMessageConfigDefaultTo, ct as resolveIMessageAccount, k as collectAllowlistProviderRestrictSendersWarnings, mf as IMessageConfigSchema, ot as listIMessageAccountIds, st as resolveDefaultIMessageAccountId, wp as resolveIMessageConfigAllowFrom, xp as formatTrimmedAllowFromEntries } from "../../auth-profiles-CuJtivJK.js";
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
import { n as imessageSetupAdapter, t as createIMessageSetupWizardProxy } from "../../setup-core-BxTwnA0N.js";
//#region extensions/imessage/src/channel.setup.ts
async function loadIMessageChannelRuntime() {
	return await import("../../channel.runtime-B5T-3HnB.js");
}
const imessageSetupWizard = createIMessageSetupWizardProxy(async () => ({ imessageSetupWizard: (await loadIMessageChannelRuntime()).imessageSetupWizard }));
//#endregion
//#region extensions/imessage/setup-entry.ts
var setup_entry_default = { plugin: {
	id: "imessage",
	meta: {
		...getChatChannelMeta("imessage"),
		aliases: ["imsg"],
		showConfigured: false
	},
	setupWizard: imessageSetupWizard,
	capabilities: {
		chatTypes: ["direct", "group"],
		media: true
	},
	reload: { configPrefixes: ["channels.imessage"] },
	configSchema: buildChannelConfigSchema(IMessageConfigSchema),
	config: {
		listAccountIds: (cfg) => listIMessageAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveIMessageAccount({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultIMessageAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
			cfg,
			sectionKey: "imessage",
			accountId,
			enabled,
			allowTopLevel: true
		}),
		deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
			cfg,
			sectionKey: "imessage",
			accountId,
			clearBaseFields: [
				"cliPath",
				"dbPath",
				"service",
				"region",
				"name"
			]
		}),
		isConfigured: (account) => account.configured,
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: account.configured
		}),
		resolveAllowFrom: ({ cfg, accountId }) => resolveIMessageConfigAllowFrom({
			cfg,
			accountId
		}),
		formatAllowFrom: ({ allowFrom }) => formatTrimmedAllowFromEntries(allowFrom),
		resolveDefaultTo: ({ cfg, accountId }) => resolveIMessageConfigDefaultTo({
			cfg,
			accountId
		})
	},
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => buildAccountScopedDmSecurityPolicy({
			cfg,
			channelKey: "imessage",
			accountId,
			fallbackAccountId: account.accountId ?? "default",
			policy: account.config.dmPolicy,
			allowFrom: account.config.allowFrom ?? [],
			policyPathSuffix: "dmPolicy"
		}),
		collectWarnings: ({ account, cfg }) => collectAllowlistProviderRestrictSendersWarnings({
			cfg,
			providerConfigPresent: cfg.channels?.imessage !== void 0,
			configuredGroupPolicy: account.config.groupPolicy,
			surface: "iMessage groups",
			openScope: "any member",
			groupPolicyPath: "channels.imessage.groupPolicy",
			groupAllowFromPath: "channels.imessage.groupAllowFrom",
			mentionGated: false
		})
	},
	setup: imessageSetupAdapter
} };
//#endregion
export { setup_entry_default as default };
