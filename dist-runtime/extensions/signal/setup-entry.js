import "../../provider-env-vars-BfZUtZAn.js";
import "../../session-key-BSZsryCD.js";
import { Jn as setAccountEnabledInConfigSection, Un as buildAccountScopedDmSecurityPolicy, Zn as buildChannelConfigSchema, f as getChatChannelMeta, qn as deleteAccountFromConfigSection } from "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import { p as normalizeE164 } from "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../paths-DAoqckDF.js";
import { $a as resolveSignalAccount, Am as createScopedAccountConfigAccessors, Ba as createSignalSetupWizardProxy, Cp as SignalConfigSchema, O as collectAllowlistProviderRestrictSendersWarnings, Qa as resolveDefaultSignalAccountId, Va as signalSetupAdapter, Za as listSignalAccountIds } from "../../auth-profiles-B70DPAVa.js";
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
//#region extensions/signal/src/channel.setup.ts
async function loadSignalChannelRuntime() {
	return await import("../../channel.runtime-D-Hmuw5J.js");
}
const signalSetupWizard = createSignalSetupWizardProxy(async () => ({ signalSetupWizard: (await loadSignalChannelRuntime()).signalSetupWizard }));
const signalConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveSignalAccount({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))).filter(Boolean),
	resolveDefaultTo: (account) => account.config.defaultTo
});
//#endregion
//#region extensions/signal/setup-entry.ts
var setup_entry_default = { plugin: {
	id: "signal",
	meta: { ...getChatChannelMeta("signal") },
	setupWizard: signalSetupWizard,
	capabilities: {
		chatTypes: ["direct", "group"],
		media: true,
		reactions: true
	},
	streaming: { blockStreamingCoalesceDefaults: {
		minChars: 1500,
		idleMs: 1e3
	} },
	reload: { configPrefixes: ["channels.signal"] },
	configSchema: buildChannelConfigSchema(SignalConfigSchema),
	config: {
		listAccountIds: (cfg) => listSignalAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveSignalAccount({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
			cfg,
			sectionKey: "signal",
			accountId,
			enabled,
			allowTopLevel: true
		}),
		deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
			cfg,
			sectionKey: "signal",
			accountId,
			clearBaseFields: [
				"account",
				"httpUrl",
				"httpHost",
				"httpPort",
				"cliPath",
				"name"
			]
		}),
		isConfigured: (account) => account.configured,
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: account.configured,
			baseUrl: account.baseUrl
		}),
		...signalConfigAccessors
	},
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => buildAccountScopedDmSecurityPolicy({
			cfg,
			channelKey: "signal",
			accountId,
			fallbackAccountId: account.accountId ?? "default",
			policy: account.config.dmPolicy,
			allowFrom: account.config.allowFrom ?? [],
			policyPathSuffix: "dmPolicy",
			normalizeEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim())
		}),
		collectWarnings: ({ account, cfg }) => collectAllowlistProviderRestrictSendersWarnings({
			cfg,
			providerConfigPresent: cfg.channels?.signal !== void 0,
			configuredGroupPolicy: account.config.groupPolicy,
			surface: "Signal groups",
			openScope: "any member",
			groupPolicyPath: "channels.signal.groupPolicy",
			groupAllowFromPath: "channels.signal.groupAllowFrom",
			mentionGated: false
		})
	},
	setup: signalSetupAdapter
} };
//#endregion
export { setup_entry_default as default };
