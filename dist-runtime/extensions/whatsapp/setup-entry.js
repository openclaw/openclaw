import "../../provider-env-vars-BfZUtZAn.js";
import "../../session-key-BfFG0xOA.js";
import { bn as buildChannelConfigSchema, fn as buildAccountScopedDmSecurityPolicy, m as getChatChannelMeta } from "../../resolve-route-BZ4hHpx2.js";
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
import { Dp as resolveWhatsAppConfigDefaultTo, Ep as resolveWhatsAppConfigAllowFrom, Jf as resolveWhatsAppAccount, Kf as listWhatsAppAccountIds, M as collectOpenGroupPolicyRouteAllowlistWarnings, O as collectAllowlistProviderGroupPolicyWarnings, S as resolveWhatsAppGroupIntroHint, Sp as formatWhatsAppConfigAllowFromEntries, df as WhatsAppConfigSchema, dl as resolveWhatsAppGroupRequireMention, fl as resolveWhatsAppGroupToolPolicy, qf as resolveDefaultWhatsAppAccountId, tp as webAuthExists } from "../../auth-profiles-CuJtivJK.js";
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
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import "../../whatsapp-CCbtUMrf.js";
import { t as whatsappSetupAdapter } from "../../setup-core-DUHOOFV32.js";
//#region extensions/whatsapp/src/channel.setup.ts
async function loadWhatsAppChannelRuntime() {
	return await import("../../channel.runtime-DC8EmuJ1.js");
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
