import "../../provider-env-vars-BfZUtZAn.js";
import "../../session-key-BSZsryCD.js";
import { Un as buildAccountScopedDmSecurityPolicy, Zn as buildChannelConfigSchema, f as getChatChannelMeta } from "../../resolve-route-CQsiaDZO.js";
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
import { D as collectAllowlistProviderGroupPolicyWarnings, Pm as formatWhatsAppConfigAllowFromEntries, Rm as resolveWhatsAppConfigAllowFrom, am as resolveDefaultWhatsAppAccountId, im as listWhatsAppAccountIds, j as collectOpenGroupPolicyRouteAllowlistWarnings, mu as resolveWhatsAppGroupToolPolicy, om as resolveWhatsAppAccount, pm as webAuthExists, pu as resolveWhatsAppGroupRequireMention, vp as WhatsAppConfigSchema, x as resolveWhatsAppGroupIntroHint, zm as resolveWhatsAppConfigDefaultTo } from "../../auth-profiles-B70DPAVa.js";
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
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import "../../whatsapp-CtQSo8tE.js";
import { t as whatsappSetupAdapter } from "../../setup-core-Db6UrHEy.js";
//#region extensions/whatsapp/src/channel.setup.ts
async function loadWhatsAppChannelRuntime() {
	return await import("../../channel.runtime-CGhraMFU.js");
}
const whatsappSetupWizardProxy = {
	channel: "whatsapp",
	status: {
		configuredLabel: "linked",
		unconfiguredLabel: "not linked",
		configuredHint: "linked",
		unconfiguredHint: "not linked",
		configuredScore: 5,
		unconfiguredScore: 4,
		resolveConfigured: async ({ cfg }) => await (await loadWhatsAppChannelRuntime()).whatsappSetupWizard.status.resolveConfigured({ cfg }),
		resolveStatusLines: async ({ cfg, configured }) => await (await loadWhatsAppChannelRuntime()).whatsappSetupWizard.status.resolveStatusLines?.({
			cfg,
			configured
		}) ?? []
	},
	resolveShouldPromptAccountIds: (params) => (params.shouldPromptAccountIds || params.options?.promptWhatsAppAccountId) ?? false,
	credentials: [],
	finalize: async (params) => await (await loadWhatsAppChannelRuntime()).whatsappSetupWizard.finalize(params),
	disable: (cfg) => ({
		...cfg,
		channels: {
			...cfg.channels,
			whatsapp: {
				...cfg.channels?.whatsapp,
				enabled: false
			}
		}
	}),
	onAccountRecorded: (accountId, options) => {
		options?.onWhatsAppAccountId?.(accountId);
	}
};
//#endregion
//#region extensions/whatsapp/setup-entry.ts
var setup_entry_default = { plugin: {
	id: "whatsapp",
	meta: {
		...getChatChannelMeta("whatsapp"),
		showConfigured: false,
		quickstartAllowFrom: true,
		forceAccountBinding: true,
		preferSessionLookupForAnnounceTarget: true
	},
	setupWizard: whatsappSetupWizardProxy,
	capabilities: {
		chatTypes: ["direct", "group"],
		polls: true,
		reactions: true,
		media: true
	},
	reload: {
		configPrefixes: ["web"],
		noopPrefixes: ["channels.whatsapp"]
	},
	gatewayMethods: ["web.login.start", "web.login.wait"],
	configSchema: buildChannelConfigSchema(WhatsAppConfigSchema),
	config: {
		listAccountIds: (cfg) => listWhatsAppAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultWhatsAppAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => {
			const accountKey = accountId || "default";
			const accounts = { ...cfg.channels?.whatsapp?.accounts };
			const existing = accounts[accountKey] ?? {};
			return {
				...cfg,
				channels: {
					...cfg.channels,
					whatsapp: {
						...cfg.channels?.whatsapp,
						accounts: {
							...accounts,
							[accountKey]: {
								...existing,
								enabled
							}
						}
					}
				}
			};
		},
		deleteAccount: ({ cfg, accountId }) => {
			const accountKey = accountId || "default";
			const accounts = { ...cfg.channels?.whatsapp?.accounts };
			delete accounts[accountKey];
			return {
				...cfg,
				channels: {
					...cfg.channels,
					whatsapp: {
						...cfg.channels?.whatsapp,
						accounts: Object.keys(accounts).length ? accounts : void 0
					}
				}
			};
		},
		isEnabled: (account, cfg) => account.enabled && cfg.web?.enabled !== false,
		disabledReason: () => "disabled",
		isConfigured: async (account) => await webAuthExists(account.authDir),
		unconfiguredReason: () => "not linked",
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.authDir),
			linked: Boolean(account.authDir),
			dmPolicy: account.dmPolicy,
			allowFrom: account.allowFrom
		}),
		resolveAllowFrom: ({ cfg, accountId }) => resolveWhatsAppConfigAllowFrom({
			cfg,
			accountId
		}),
		formatAllowFrom: ({ allowFrom }) => formatWhatsAppConfigAllowFromEntries(allowFrom),
		resolveDefaultTo: ({ cfg, accountId }) => resolveWhatsAppConfigDefaultTo({
			cfg,
			accountId
		})
	},
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => buildAccountScopedDmSecurityPolicy({
			cfg,
			channelKey: "whatsapp",
			accountId,
			fallbackAccountId: account.accountId ?? "default",
			policy: account.dmPolicy,
			allowFrom: account.allowFrom ?? [],
			policyPathSuffix: "dmPolicy",
			normalizeEntry: (raw) => normalizeE164(raw)
		}),
		collectWarnings: ({ account, cfg }) => {
			const groupAllowlistConfigured = Boolean(account.groups) && Object.keys(account.groups ?? {}).length > 0;
			return collectAllowlistProviderGroupPolicyWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.whatsapp !== void 0,
				configuredGroupPolicy: account.groupPolicy,
				collect: (groupPolicy) => collectOpenGroupPolicyRouteAllowlistWarnings({
					groupPolicy,
					routeAllowlistConfigured: groupAllowlistConfigured,
					restrictSenders: {
						surface: "WhatsApp groups",
						openScope: "any member in allowed groups",
						groupPolicyPath: "channels.whatsapp.groupPolicy",
						groupAllowFromPath: "channels.whatsapp.groupAllowFrom"
					},
					noRouteAllowlist: {
						surface: "WhatsApp groups",
						routeAllowlistPath: "channels.whatsapp.groups",
						routeScope: "group",
						groupPolicyPath: "channels.whatsapp.groupPolicy",
						groupAllowFromPath: "channels.whatsapp.groupAllowFrom"
					}
				})
			});
		}
	},
	setup: whatsappSetupAdapter,
	groups: {
		resolveRequireMention: resolveWhatsAppGroupRequireMention,
		resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
		resolveGroupIntroHint: resolveWhatsAppGroupIntroHint
	}
} };
//#endregion
export { setup_entry_default as default };
