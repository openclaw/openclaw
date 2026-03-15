import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import { h as DEFAULT_ACCOUNT_ID } from "../../session-key-BfFG0xOA.js";
import { _n as setAccountEnabledInConfigSection, bn as buildChannelConfigSchema, dn as PAIRING_APPROVED_MESSAGE, fn as buildAccountScopedDmSecurityPolicy, gn as deleteAccountFromConfigSection, m as getChatChannelMeta, t as buildAgentSessionKey } from "../../resolve-route-BZ4hHpx2.js";
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
import "../../core-qWFcsWSH.js";
import "../../paths-OqPpu-UR.js";
import { Na as resolveChannelMediaMaxBytes, Tp as resolveIMessageConfigDefaultTo, Uu as collectStatusIssuesFromLastError, al as resolveIMessageGroupRequireMention, b as createPluginRuntimeStore, ct as resolveIMessageAccount, dt as normalizeIMessageHandle, ft as parseIMessageTarget, k as collectAllowlistProviderRestrictSendersWarnings, lt as looksLikeIMessageTargetId, mf as IMessageConfigSchema, oi as resolveOutboundSendDep, ol as resolveIMessageGroupToolPolicy, ot as listIMessageAccountIds, st as resolveDefaultIMessageAccountId, ut as normalizeIMessageMessagingTarget, wp as resolveIMessageConfigAllowFrom, xp as formatTrimmedAllowFromEntries } from "../../auth-profiles-CuJtivJK.js";
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
import { g as buildAccountScopedAllowlistConfigEditor } from "../../compat-DDXNEdAm.js";
import "../../inbound-envelope-DsNRW6ln.js";
import "../../run-command-Psw08BkS.js";
import "../../device-pairing-DYWF-CWB.js";
import "../../line-iO245OTq.js";
import "../../upsert-with-lock-CLs2bE4R.js";
import "../../self-hosted-provider-setup-C4OZCxyb.js";
import "../../ollama-setup-BM-G12b6.js";
import { n as buildPassiveProbedChannelStatusSummary } from "../../channel-status-summary-C_aBM2lc.js";
import { n as imessageSetupAdapter, t as createIMessageSetupWizardProxy } from "../../setup-core-BxTwnA0N.js";
//#region extensions/imessage/src/runtime.ts
const { setRuntime: setIMessageRuntime, getRuntime: getIMessageRuntime } = createPluginRuntimeStore("iMessage runtime not initialized");
//#endregion
//#region extensions/imessage/src/channel.ts
const meta = getChatChannelMeta("imessage");
async function loadIMessageChannelRuntime() {
	return await import("../../channel.runtime-B5T-3HnB.js");
}
const imessageSetupWizard = createIMessageSetupWizardProxy(async () => ({ imessageSetupWizard: (await loadIMessageChannelRuntime()).imessageSetupWizard }));
async function sendIMessageOutbound(params) {
	const send = resolveOutboundSendDep(params.deps, "imessage") ?? getIMessageRuntime().channel.imessage.sendMessageIMessage;
	const maxBytes = resolveChannelMediaMaxBytes({
		cfg: params.cfg,
		resolveChannelLimitMb: ({ cfg, accountId }) => cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.imessage?.mediaMaxMb,
		accountId: params.accountId
	});
	return await send(params.to, params.text, {
		config: params.cfg,
		...params.mediaUrl ? { mediaUrl: params.mediaUrl } : {},
		...params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {},
		maxBytes,
		accountId: params.accountId ?? void 0,
		replyToId: params.replyToId ?? void 0
	});
}
function buildIMessageBaseSessionKey(params) {
	return buildAgentSessionKey({
		agentId: params.agentId,
		channel: "imessage",
		accountId: params.accountId,
		peer: params.peer,
		dmScope: params.cfg.session?.dmScope ?? "main",
		identityLinks: params.cfg.session?.identityLinks
	});
}
function resolveIMessageOutboundSessionRoute(params) {
	const parsed = parseIMessageTarget(params.target);
	if (parsed.kind === "handle") {
		const handle = normalizeIMessageHandle(parsed.to);
		if (!handle) return null;
		const peer = {
			kind: "direct",
			id: handle
		};
		const baseSessionKey = buildIMessageBaseSessionKey({
			cfg: params.cfg,
			agentId: params.agentId,
			accountId: params.accountId,
			peer
		});
		return {
			sessionKey: baseSessionKey,
			baseSessionKey,
			peer,
			chatType: "direct",
			from: `imessage:${handle}`,
			to: `imessage:${handle}`
		};
	}
	const peerId = parsed.kind === "chat_id" ? String(parsed.chatId) : parsed.kind === "chat_guid" ? parsed.chatGuid : parsed.chatIdentifier;
	if (!peerId) return null;
	const peer = {
		kind: "group",
		id: peerId
	};
	const baseSessionKey = buildIMessageBaseSessionKey({
		cfg: params.cfg,
		agentId: params.agentId,
		accountId: params.accountId,
		peer
	});
	const toPrefix = parsed.kind === "chat_id" ? "chat_id" : parsed.kind === "chat_guid" ? "chat_guid" : "chat_identifier";
	return {
		sessionKey: baseSessionKey,
		baseSessionKey,
		peer,
		chatType: "group",
		from: `imessage:group:${peerId}`,
		to: `${toPrefix}:${peerId}`
	};
}
const imessagePlugin = {
	id: "imessage",
	meta: {
		...meta,
		aliases: ["imsg"],
		showConfigured: false
	},
	setupWizard: imessageSetupWizard,
	pairing: {
		idLabel: "imessageSenderId",
		notifyApproval: async ({ id }) => {
			await getIMessageRuntime().channel.imessage.sendMessageIMessage(id, PAIRING_APPROVED_MESSAGE);
		}
	},
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
	allowlist: {
		supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
		readConfig: ({ cfg, accountId }) => {
			const account = resolveIMessageAccount({
				cfg,
				accountId
			});
			return {
				dmAllowFrom: (account.config.allowFrom ?? []).map(String),
				groupAllowFrom: (account.config.groupAllowFrom ?? []).map(String),
				dmPolicy: account.config.dmPolicy,
				groupPolicy: account.config.groupPolicy
			};
		},
		applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
			channelId: "imessage",
			normalize: ({ values }) => formatTrimmedAllowFromEntries(values),
			resolvePaths: (scope) => ({
				readPaths: [[scope === "dm" ? "allowFrom" : "groupAllowFrom"]],
				writePath: [scope === "dm" ? "allowFrom" : "groupAllowFrom"]
			})
		})
	},
	security: {
		resolveDmPolicy: ({ cfg, accountId, account }) => {
			return buildAccountScopedDmSecurityPolicy({
				cfg,
				channelKey: "imessage",
				accountId,
				fallbackAccountId: account.accountId ?? "default",
				policy: account.config.dmPolicy,
				allowFrom: account.config.allowFrom ?? [],
				policyPathSuffix: "dmPolicy"
			});
		},
		collectWarnings: ({ account, cfg }) => {
			return collectAllowlistProviderRestrictSendersWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.imessage !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				surface: "iMessage groups",
				openScope: "any member",
				groupPolicyPath: "channels.imessage.groupPolicy",
				groupAllowFromPath: "channels.imessage.groupAllowFrom",
				mentionGated: false
			});
		}
	},
	groups: {
		resolveRequireMention: resolveIMessageGroupRequireMention,
		resolveToolPolicy: resolveIMessageGroupToolPolicy
	},
	messaging: {
		normalizeTarget: normalizeIMessageMessagingTarget,
		resolveOutboundSessionRoute: (params) => resolveIMessageOutboundSessionRoute(params),
		targetResolver: {
			looksLikeId: looksLikeIMessageTargetId,
			hint: "<handle|chat_id:ID>"
		}
	},
	setup: imessageSetupAdapter,
	outbound: {
		deliveryMode: "direct",
		chunker: (text, limit) => getIMessageRuntime().channel.text.chunkText(text, limit),
		chunkerMode: "text",
		textChunkLimit: 4e3,
		sendText: async ({ cfg, to, text, accountId, deps, replyToId }) => {
			return {
				channel: "imessage",
				...await sendIMessageOutbound({
					cfg,
					to,
					text,
					accountId: accountId ?? void 0,
					deps,
					replyToId: replyToId ?? void 0
				})
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, replyToId }) => {
			return {
				channel: "imessage",
				...await sendIMessageOutbound({
					cfg,
					to,
					text,
					mediaUrl,
					mediaLocalRoots,
					accountId: accountId ?? void 0,
					deps,
					replyToId: replyToId ?? void 0
				})
			};
		}
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null,
			cliPath: null,
			dbPath: null
		},
		collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("imessage", accounts),
		buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot, {
			cliPath: snapshot.cliPath ?? null,
			dbPath: snapshot.dbPath ?? null
		}),
		probeAccount: async ({ timeoutMs }) => getIMessageRuntime().channel.imessage.probeIMessage(timeoutMs),
		buildAccountSnapshot: ({ account, runtime, probe }) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: account.configured,
			running: runtime?.running ?? false,
			lastStartAt: runtime?.lastStartAt ?? null,
			lastStopAt: runtime?.lastStopAt ?? null,
			lastError: runtime?.lastError ?? null,
			cliPath: runtime?.cliPath ?? account.config.cliPath ?? null,
			dbPath: runtime?.dbPath ?? account.config.dbPath ?? null,
			probe,
			lastInboundAt: runtime?.lastInboundAt ?? null,
			lastOutboundAt: runtime?.lastOutboundAt ?? null
		}),
		resolveAccountState: ({ enabled }) => enabled ? "enabled" : "disabled"
	},
	gateway: { startAccount: async (ctx) => {
		const account = ctx.account;
		const cliPath = account.config.cliPath?.trim() || "imsg";
		const dbPath = account.config.dbPath?.trim();
		ctx.setStatus({
			accountId: account.accountId,
			cliPath,
			dbPath: dbPath ?? null
		});
		ctx.log?.info(`[${account.accountId}] starting provider (${cliPath}${dbPath ? ` db=${dbPath}` : ""})`);
		return getIMessageRuntime().channel.imessage.monitorIMessageProvider({
			accountId: account.accountId,
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal
		});
	} }
};
//#endregion
//#region extensions/imessage/index.ts
const plugin = {
	id: "imessage",
	name: "iMessage",
	description: "iMessage channel plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setIMessageRuntime(api.runtime);
		api.registerChannel({ plugin: imessagePlugin });
	}
};
//#endregion
export { plugin as default };
