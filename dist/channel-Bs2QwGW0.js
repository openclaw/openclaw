import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { At as boolean, Et as array, Nn as record, Rn as string, Tn as object, yt as _enum } from "./schemas-Del5uzR8.js";
import { r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import { r as createLazyRuntimeModule } from "./lazy-runtime-D-7_JraP.js";
import { i as createHybridChannelConfigAdapter } from "./channel-config-helpers-xZ4-bv2H.js";
import { n as describeAccountSnapshot } from "./account-helpers-BEXOONiv.js";
import { i as createChatChannelPlugin, t as buildChannelOutboundSessionRoute } from "./core-kXuNbs5U.js";
import "./channel-core-CV-k5W6W.js";
import "./channel-config-schema-BBVXL5oD.js";
import { n as createRuntimeOutboundDelegates } from "./runtime-forwarders-CJHIfxll.js";
import "./outbound-runtime-CGgaScW3.js";
import { d as createDefaultChannelRuntimeState, u as createComputedAccountStatusAdapter } from "./status-helpers-CnvYAK73.js";
import { k as createChannelMessageAdapterFromOutbound } from "./channel-message-DMGbyII_.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "./doctor-contract-CPrQ8rAS.js";
import { a as tlonSetupAdapter, d as formatTargetHint, f as normalizeShip, h as resolveTlonOutboundTarget, l as listTlonAccountIds, m as parseTlonTarget, n as createTlonSetupWizardBase, u as resolveTlonAccount } from "./setup-core-DbWuyR2f.js";
//#region extensions/tlon/src/config-schema.ts
const ShipSchema = string().min(1);
const ChannelNestSchema = string().min(1);
const TlonChannelRuleSchema = object({
	mode: _enum(["restricted", "open"]).optional(),
	allowedShips: array(ShipSchema).optional()
});
const TlonAuthorizationSchema = object({ channelRules: record(string(), TlonChannelRuleSchema).optional() });
const TlonNetworkSchema = object({ dangerouslyAllowPrivateNetwork: boolean().optional() }).strict().optional();
const tlonCommonConfigFields = {
	name: string().optional(),
	enabled: boolean().optional(),
	ship: ShipSchema.optional(),
	url: string().optional(),
	code: string().optional(),
	network: TlonNetworkSchema,
	groupChannels: array(ChannelNestSchema).optional(),
	dmAllowlist: array(ShipSchema).optional(),
	groupInviteAllowlist: array(ShipSchema).optional(),
	autoDiscoverChannels: boolean().optional(),
	showModelSignature: boolean().optional(),
	responsePrefix: string().optional(),
	autoAcceptDmInvites: boolean().optional(),
	autoAcceptGroupInvites: boolean().optional(),
	ownerShip: ShipSchema.optional()
};
const TlonAccountSchema = object({ ...tlonCommonConfigFields });
const tlonChannelConfigSchema = buildChannelConfigSchema(object({
	...tlonCommonConfigFields,
	authorization: TlonAuthorizationSchema.optional(),
	defaultAuthorizedShips: array(ShipSchema).optional(),
	accounts: record(string(), TlonAccountSchema).optional()
}));
//#endregion
//#region extensions/tlon/src/doctor.ts
const tlonDoctor = {
	legacyConfigRules,
	normalizeCompatibilityConfig
};
//#endregion
//#region extensions/tlon/src/session-route.ts
function resolveTlonOutboundSessionRoute(params) {
	const parsed = parseTlonTarget(params.target);
	if (!parsed) return null;
	if (parsed.kind === "group") return buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "tlon",
		accountId: params.accountId,
		peer: {
			kind: "group",
			id: parsed.nest
		},
		chatType: "group",
		from: `tlon:group:${parsed.nest}`,
		to: `tlon:${parsed.nest}`
	});
	return buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "tlon",
		accountId: params.accountId,
		peer: {
			kind: "direct",
			id: parsed.ship
		},
		chatType: "direct",
		from: `tlon:${parsed.ship}`,
		to: `tlon:${parsed.ship}`
	});
}
//#endregion
//#region extensions/tlon/src/channel.ts
const TLON_CHANNEL_ID = "tlon";
const loadTlonChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime-KvZn8_hb.js"));
const tlonSetupWizardProxy = createTlonSetupWizardBase({
	resolveConfigured: async ({ cfg, accountId }) => await (await loadTlonChannelRuntime()).tlonSetupWizard.status.resolveConfigured({
		cfg,
		accountId
	}),
	resolveStatusLines: async ({ cfg, accountId, configured }) => await (await loadTlonChannelRuntime()).tlonSetupWizard.status.resolveStatusLines?.({
		cfg,
		accountId,
		configured
	}) ?? [],
	finalize: async (params) => await (await loadTlonChannelRuntime()).tlonSetupWizard.finalize(params)
});
const tlonConfigAdapter = createHybridChannelConfigAdapter({
	sectionKey: TLON_CHANNEL_ID,
	listAccountIds: listTlonAccountIds,
	resolveAccount: resolveTlonAccount,
	defaultAccountId: () => DEFAULT_ACCOUNT_ID,
	clearBaseFields: [
		"ship",
		"code",
		"url",
		"name"
	],
	preserveSectionOnDefaultDelete: true,
	resolveAllowFrom: (account) => account.dmAllowlist,
	formatAllowFrom: (allowFrom) => allowFrom.map((entry) => normalizeShip(String(entry))).filter(Boolean)
});
const tlonChannelOutbound = {
	deliveryMode: "direct",
	textChunkLimit: 1e4,
	resolveTarget: ({ to }) => resolveTlonOutboundTarget(to),
	deliveryCapabilities: { durableFinal: {
		text: true,
		media: true,
		replyTo: true,
		thread: true,
		messageSendingHooks: true
	} },
	...createRuntimeOutboundDelegates({
		getRuntime: loadTlonChannelRuntime,
		sendText: { resolve: (runtime) => runtime.tlonRuntimeOutbound.sendText },
		sendMedia: { resolve: (runtime) => runtime.tlonRuntimeOutbound.sendMedia }
	})
};
const tlonMessageAdapter = createChannelMessageAdapterFromOutbound({
	id: TLON_CHANNEL_ID,
	outbound: tlonChannelOutbound
});
const tlonPlugin = createChatChannelPlugin({
	base: {
		id: TLON_CHANNEL_ID,
		meta: {
			id: TLON_CHANNEL_ID,
			label: "Tlon",
			selectionLabel: "Tlon (Urbit)",
			docsPath: "/channels/tlon",
			docsLabel: "tlon",
			blurb: "Decentralized messaging on Urbit",
			aliases: ["urbit"],
			order: 90
		},
		capabilities: {
			chatTypes: [
				"direct",
				"group",
				"thread"
			],
			media: true,
			reply: true,
			threads: true
		},
		setup: tlonSetupAdapter,
		setupWizard: tlonSetupWizardProxy,
		reload: { configPrefixes: ["channels.tlon"] },
		configSchema: tlonChannelConfigSchema,
		config: {
			...tlonConfigAdapter,
			isConfigured: (account) => account.configured,
			describeAccount: (account) => describeAccountSnapshot({
				account,
				configured: account.configured,
				extra: {
					ship: account.ship,
					url: account.url
				}
			})
		},
		doctor: tlonDoctor,
		messaging: {
			targetPrefixes: ["tlon"],
			normalizeTarget: (target) => {
				const parsed = parseTlonTarget(target);
				if (!parsed) return target.trim();
				if (parsed.kind === "dm") return parsed.ship;
				return parsed.nest;
			},
			targetResolver: {
				looksLikeId: (target) => Boolean(parseTlonTarget(target)),
				hint: formatTargetHint()
			},
			resolveOutboundSessionRoute: (params) => resolveTlonOutboundSessionRoute(params)
		},
		message: tlonMessageAdapter,
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			collectStatusIssues: (accounts) => {
				return accounts.flatMap((account) => {
					if (!account.configured) return [{
						channel: TLON_CHANNEL_ID,
						accountId: account.accountId,
						kind: "config",
						message: "Account not configured (missing ship, code, or url)"
					}];
					return [];
				});
			},
			buildChannelSummary: ({ snapshot }) => {
				const s = snapshot;
				return {
					configured: s.configured ?? false,
					ship: s.ship ?? null,
					url: s.url ?? null
				};
			},
			probeAccount: async ({ account }) => {
				if (!account.configured || !account.ship || !account.url || !account.code) return {
					ok: false,
					error: "Not configured"
				};
				return await (await loadTlonChannelRuntime()).probeTlonAccount(account);
			},
			resolveAccountSnapshot: ({ account }) => ({
				accountId: account.accountId,
				name: account.name ?? void 0,
				enabled: account.enabled,
				configured: account.configured,
				extra: {
					ship: account.ship,
					url: account.url
				}
			})
		}),
		gateway: { startAccount: async (ctx) => await (await loadTlonChannelRuntime()).startTlonGatewayAccount(ctx) }
	},
	outbound: tlonChannelOutbound
});
//#endregion
export { tlonPlugin as t };
