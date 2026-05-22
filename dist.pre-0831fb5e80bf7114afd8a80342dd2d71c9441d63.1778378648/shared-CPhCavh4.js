import { l as normalizeE164 } from "./utils-927g1oFZ.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-9_btbLFO.js";
import { n as resolveChannelGroupRequireMention, r as resolveChannelGroupToolsPolicy } from "./group-policy-DQPom3Tt.js";
import { l as createScopedDmSecurityResolver, s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-Dd68-pWO.js";
import { n as describeAccountSnapshot } from "./account-helpers-f9qw90VM.js";
import "./account-core-CEoHktRh.js";
import { c as getChatChannelMeta, r as createChannelPluginBase } from "./core-X81hhXAW.js";
import { a as readChannelAllowFromStore } from "./pairing-store-BPeRu37Y.js";
import { f as collectOpenGroupPolicyRouteAllowlistWarnings, g as createAllowlistProviderGroupPolicyWarningCollector } from "./channel-policy-C4Te_3Ry.js";
import { a as createDelegatedSetupWizardProxy } from "./setup-wizard-proxy-BaKY7ooP.js";
import "./setup-runtime-502IkWVj.js";
import "./account-resolution-BjQzGUOQ.js";
import "./channel-pairing-Ccj9LOYk.js";
import { r as resolveDefaultWhatsAppAccountId, t as listAccountIds } from "./account-ids-B2OHI47p.js";
import { a as resolveWhatsAppAccount, n as hasAnyWhatsAppAuth } from "./accounts-Ck6-qbs0.js";
import { a as normalizeWhatsAppAllowFromEntries } from "./normalize-target-CaovcPV4.js";
import { t as WhatsAppChannelConfigSchema } from "./config-schema-DoLOenU9.js";
import { n as whatsappDoctor } from "./doctor-Dzk9nV5M.js";
import { t as resolveLegacyGroupSessionKey } from "./group-session-contract-DBPsdoWl.js";
import { n as unsupportedSecretRefSurfacePatterns, t as collectUnsupportedSecretRefConfigCandidates } from "./security-contract-DyPToZZr.js";
import { n as deriveLegacySessionChatType, r as isLegacyGroupSessionKey, t as canonicalizeLegacySessionKey } from "./session-contract-CQXnKd9U.js";
//#region extensions/whatsapp/src/config-accessors.ts
function formatWhatsAppConfigAllowFromEntries(allowFrom) {
	return normalizeWhatsAppAllowFromEntries(allowFrom);
}
//#endregion
//#region extensions/whatsapp/src/group-intro.ts
const WHATSAPP_GROUP_INTRO_HINT = "WhatsApp IDs: SenderId is the participant JID (group participant id).";
function resolveWhatsAppGroupIntroHint() {
	return WHATSAPP_GROUP_INTRO_HINT;
}
function resolveWhatsAppMentionStripRegexes(ctx) {
	const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/i, "");
	if (!selfE164) return [];
	const escaped = selfE164.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [new RegExp(escaped, "g"), new RegExp(`@${escaped}`, "g")];
}
//#endregion
//#region extensions/whatsapp/src/group-policy.ts
function resolveWhatsAppGroupRequireMention(params) {
	return resolveChannelGroupRequireMention({
		cfg: params.cfg,
		channel: "whatsapp",
		groupId: params.groupId,
		accountId: params.accountId
	});
}
function resolveWhatsAppGroupToolPolicy(params) {
	return resolveChannelGroupToolsPolicy({
		cfg: params.cfg,
		channel: "whatsapp",
		groupId: params.groupId,
		accountId: params.accountId,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	});
}
//#endregion
//#region extensions/whatsapp/src/security-fix.ts
function applyGroupAllowFromFromStore(params) {
	const next = structuredClone(params.cfg ?? {});
	const section = next.channels?.whatsapp;
	if (!section || typeof section !== "object" || params.storeAllowFrom.length === 0) return params.cfg;
	let changed = false;
	const maybeApply = (prefix, holder) => {
		if (holder.groupPolicy !== "allowlist") return;
		const allowFrom = Array.isArray(holder.allowFrom) ? holder.allowFrom : [];
		const groupAllowFrom = Array.isArray(holder.groupAllowFrom) ? holder.groupAllowFrom : [];
		if (allowFrom.length > 0 || groupAllowFrom.length > 0) return;
		holder.groupAllowFrom = params.storeAllowFrom;
		params.changes.push(`${prefix}groupAllowFrom=pairing-store`);
		changed = true;
	};
	maybeApply("channels.whatsapp.", section);
	const accounts = section.accounts;
	if (accounts && typeof accounts === "object") for (const [accountId, accountValue] of Object.entries(accounts)) {
		if (!accountValue || typeof accountValue !== "object") continue;
		maybeApply(`channels.whatsapp.accounts.${accountId}.`, accountValue);
	}
	return changed ? next : params.cfg;
}
async function applyWhatsAppSecurityConfigFixes(params) {
	const fromStore = await readChannelAllowFromStore("whatsapp", params.env, DEFAULT_ACCOUNT_ID).catch(() => []);
	const normalized = Array.from(new Set(fromStore.map((entry) => entry.trim()))).filter(Boolean);
	if (normalized.length === 0) return {
		config: params.cfg,
		changes: []
	};
	const changes = [];
	return {
		config: applyGroupAllowFromFromStore({
			cfg: params.cfg,
			storeAllowFrom: normalized,
			changes
		}),
		changes
	};
}
//#endregion
//#region extensions/whatsapp/src/shared.ts
const WHATSAPP_CHANNEL = "whatsapp";
const WHATSAPP_GROUP_SCOPE_FIELDS = [
	"groupPolicy",
	"groupAllowFrom",
	"groups"
];
function resolveWhatsAppAccountKey(accounts, accountId) {
	if (!accounts) return;
	if (Object.hasOwn(accounts, accountId)) return accountId;
	const normalizedAccountId = accountId.trim().toLowerCase();
	return Object.keys(accounts).find((key) => key.trim().toLowerCase() === normalizedAccountId);
}
function resolveWhatsAppGroupScopeBasePath(params) {
	const accountId = typeof params.accountId === "string" ? params.accountId.trim() || "default" : DEFAULT_ACCOUNT_ID;
	const accounts = params.cfg.channels?.whatsapp?.accounts;
	const accountKey = resolveWhatsAppAccountKey(accounts, accountId);
	const defaultAccountKey = resolveWhatsAppAccountKey(accounts, DEFAULT_ACCOUNT_ID);
	const accountConfig = accountKey ? accounts?.[accountKey] : void 0;
	const defaultAccountConfig = defaultAccountKey ? accounts?.[defaultAccountKey] : void 0;
	const matchesAnyGroupScopeField = (config) => WHATSAPP_GROUP_SCOPE_FIELDS.some((field) => config?.[field] !== void 0);
	if (matchesAnyGroupScopeField(accountConfig)) return `channels.whatsapp.accounts.${accountKey}`;
	if (accountId !== "default" && matchesAnyGroupScopeField(defaultAccountConfig)) return `channels.whatsapp.accounts.${defaultAccountKey}`;
	return "channels.whatsapp";
}
function resolveWhatsAppConfigPath(params) {
	return `${resolveWhatsAppGroupScopeBasePath(params)}.${params.field}`;
}
async function loadWhatsAppChannelRuntime() {
	return await import("./channel.runtime-j7KZ8hAa.js");
}
async function loadWhatsAppSetupSurface() {
	return await import("./setup-surface-Dtx3cwlc.js");
}
const whatsappSetupWizardProxy = createWhatsAppSetupWizardProxy(async () => (await loadWhatsAppSetupSurface()).whatsappSetupWizard);
const whatsappConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: WHATSAPP_CHANNEL,
	listAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveWhatsAppAccount),
	defaultAccountId: resolveDefaultWhatsAppAccountId,
	clearBaseFields: [],
	allowTopLevel: false,
	resolveAllowFrom: (account) => account.allowFrom,
	formatAllowFrom: (allowFrom) => formatWhatsAppConfigAllowFromEntries(allowFrom),
	resolveDefaultTo: (account) => account.defaultTo
});
const whatsappResolveDmPolicy = createScopedDmSecurityResolver({
	channelKey: WHATSAPP_CHANNEL,
	resolvePolicy: (account) => account.dmPolicy,
	resolveAllowFrom: (account) => account.allowFrom,
	policyPathSuffix: "dmPolicy",
	normalizeEntry: (raw) => normalizeE164(raw),
	inheritSharedDefaultsFromDefaultAccount: true
});
function createWhatsAppSetupWizardProxy(loadWizard) {
	return createDelegatedSetupWizardProxy({
		channel: WHATSAPP_CHANNEL,
		loadWizard,
		status: {
			configuredLabel: "linked",
			unconfiguredLabel: "not linked",
			configuredHint: "linked",
			unconfiguredHint: "not linked",
			configuredScore: 5,
			unconfiguredScore: 4
		},
		resolveShouldPromptAccountIds: (params) => params.shouldPromptAccountIds,
		credentials: [],
		delegateFinalize: true,
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
			options?.onAccountId?.(WHATSAPP_CHANNEL, accountId);
		}
	});
}
function createWhatsAppPluginBase(params) {
	const collectWhatsAppSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector({
		providerConfigPresent: (cfg) => cfg.channels?.whatsapp !== void 0,
		resolveGroupPolicy: ({ account }) => account.groupPolicy,
		collect: ({ account, accountId, cfg, groupPolicy }) => collectOpenGroupPolicyRouteAllowlistWarnings({
			groupPolicy,
			routeAllowlistConfigured: Boolean(account.groups) && Object.keys(account.groups ?? {}).length > 0,
			restrictSenders: {
				surface: "WhatsApp groups",
				openScope: "any member in allowed groups",
				groupPolicyPath: resolveWhatsAppConfigPath({
					cfg,
					accountId,
					field: "groupPolicy"
				}),
				groupAllowFromPath: resolveWhatsAppConfigPath({
					cfg,
					accountId,
					field: "groupAllowFrom"
				})
			},
			noRouteAllowlist: {
				surface: "WhatsApp groups",
				routeAllowlistPath: resolveWhatsAppConfigPath({
					cfg,
					accountId,
					field: "groups"
				}),
				routeScope: "group",
				groupPolicyPath: resolveWhatsAppConfigPath({
					cfg,
					accountId,
					field: "groupPolicy"
				}),
				groupAllowFromPath: resolveWhatsAppConfigPath({
					cfg,
					accountId,
					field: "groupAllowFrom"
				})
			}
		})
	});
	const base = createChannelPluginBase({
		id: WHATSAPP_CHANNEL,
		meta: {
			...getChatChannelMeta(WHATSAPP_CHANNEL),
			showConfigured: false,
			quickstartAllowFrom: true,
			forceAccountBinding: true,
			preferSessionLookupForAnnounceTarget: true
		},
		setupWizard: params.setupWizard,
		capabilities: {
			chatTypes: [
				"direct",
				"group",
				"channel"
			],
			polls: true,
			reactions: true,
			media: true,
			tts: { voice: {
				synthesisTarget: "voice-note",
				transcodesAudio: true
			} }
		},
		reload: {
			configPrefixes: ["web"],
			noopPrefixes: ["channels.whatsapp"]
		},
		gatewayMethods: ["web.login.start", "web.login.wait"],
		configSchema: WhatsAppChannelConfigSchema,
		config: {
			...whatsappConfigAdapter,
			isEnabled: (account, cfg) => account.enabled && cfg.web?.enabled !== false,
			disabledReason: () => "disabled",
			isConfigured: params.isConfigured,
			hasPersistedAuthState: ({ cfg }) => hasAnyWhatsAppAuth(cfg),
			unconfiguredReason: () => "not linked",
			describeAccount: (account) => describeAccountSnapshot({
				account,
				configured: Boolean(account.authDir),
				extra: {
					linked: Boolean(account.authDir),
					dmPolicy: account.dmPolicy,
					allowFrom: account.allowFrom
				}
			})
		},
		security: {
			applyConfigFixes: applyWhatsAppSecurityConfigFixes,
			resolveDmPolicy: whatsappResolveDmPolicy,
			collectWarnings: collectWhatsAppSecurityWarnings
		},
		doctor: whatsappDoctor,
		setup: params.setup,
		groups: params.groups
	});
	return {
		...base,
		setupWizard: base.setupWizard,
		capabilities: base.capabilities,
		reload: base.reload,
		gatewayMethods: base.gatewayMethods,
		configSchema: base.configSchema,
		config: base.config,
		messaging: {
			defaultMarkdownTableMode: "bullets",
			deriveLegacySessionChatType,
			resolveLegacyGroupSessionKey,
			isLegacyGroupSessionKey,
			canonicalizeLegacySessionKey: (params) => canonicalizeLegacySessionKey({
				key: params.key,
				agentId: params.agentId
			})
		},
		secrets: {
			unsupportedSecretRefSurfacePatterns,
			collectUnsupportedSecretRefConfigCandidates
		},
		security: base.security,
		groups: base.groups
	};
}
//#endregion
export { resolveWhatsAppGroupToolPolicy as a, formatWhatsAppConfigAllowFromEntries as c, resolveWhatsAppGroupRequireMention as i, loadWhatsAppChannelRuntime as n, resolveWhatsAppGroupIntroHint as o, whatsappSetupWizardProxy as r, resolveWhatsAppMentionStripRegexes as s, createWhatsAppPluginBase as t };
