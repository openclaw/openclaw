import "../../provider-env-vars-BfZUtZAn.js";
import "../../session-key-BSZsryCD.js";
import { Jn as setAccountEnabledInConfigSection, Un as buildAccountScopedDmSecurityPolicy, Zn as buildChannelConfigSchema, f as getChatChannelMeta, qn as deleteAccountFromConfigSection } from "../../resolve-route-CQsiaDZO.js";
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
import { Im as resolveIMessageConfigAllowFrom, Lm as resolveIMessageConfigDefaultTo, Nm as formatTrimmedAllowFromEntries, O as collectAllowlistProviderRestrictSendersWarnings, dt as resolveDefaultIMessageAccountId, ft as resolveIMessageAccount, ut as listIMessageAccountIds, xp as IMessageConfigSchema } from "../../auth-profiles-B70DPAVa.js";
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
import { n as imessageSetupAdapter, t as createIMessageSetupWizardProxy } from "../../setup-core-C4SdefP-.js";
//#region extensions/imessage/src/channel.setup.ts
async function loadIMessageChannelRuntime() {
	return await import("../../channel.runtime-CU09XD5v.js");
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
