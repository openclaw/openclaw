import "../../provider-env-vars-BfZUtZAn.js";
import "../../session-key-BfFG0xOA.js";
import { _n as setAccountEnabledInConfigSection, bn as buildChannelConfigSchema, fn as buildAccountScopedDmSecurityPolicy, gn as deleteAccountFromConfigSection, m as getChatChannelMeta } from "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import { f as normalizeE164 } from "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../paths-OqPpu-UR.js";
import { Aa as listSignalAccountIds, Ma as resolveSignalAccount, Ta as signalSetupAdapter, gf as SignalConfigSchema, ja as resolveDefaultSignalAccountId, k as collectAllowlistProviderRestrictSendersWarnings, vp as createScopedAccountConfigAccessors, wa as createSignalSetupWizardProxy } from "../../auth-profiles-CuJtivJK.js";
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
//#region extensions/signal/src/channel.setup.ts
async function loadSignalChannelRuntime() {
	return await import("../../channel.runtime-DltO_s0r.js");
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
