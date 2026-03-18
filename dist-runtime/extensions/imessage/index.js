import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import { g as DEFAULT_ACCOUNT_ID } from "../../session-key-BSZsryCD.js";
import { Hn as PAIRING_APPROVED_MESSAGE, Jn as setAccountEnabledInConfigSection, Un as buildAccountScopedDmSecurityPolicy, Zn as buildChannelConfigSchema, f as getChatChannelMeta, qn as deleteAccountFromConfigSection, t as buildAgentSessionKey } from "../../resolve-route-CQsiaDZO.js";
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
import "../../core-CUbPSeQH.js";
import "../../paths-DAoqckDF.js";
import { Im as resolveIMessageConfigAllowFrom, Lm as resolveIMessageConfigDefaultTo, Nm as formatTrimmedAllowFromEntries, O as collectAllowlistProviderRestrictSendersWarnings, Yd as collectStatusIssuesFromLastError, cu as resolveIMessageGroupToolPolicy, dt as resolveDefaultIMessageAccountId, eo as resolveChannelMediaMaxBytes, ft as resolveIMessageAccount, gt as parseIMessageTarget, ht as normalizeIMessageHandle, mt as normalizeIMessageMessagingTarget, pt as looksLikeIMessageTargetId, su as resolveIMessageGroupRequireMention, ui as resolveOutboundSendDep, ut as listIMessageAccountIds, xp as IMessageConfigSchema, y as createPluginRuntimeStore } from "../../auth-profiles-B70DPAVa.js";
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
import { g as buildAccountScopedAllowlistConfigEditor } from "../../compat-CwB8x8Tr.js";
import "../../inbound-envelope-DsYY1Vpm.js";
import "../../run-command-B9zmAfEF.js";
import "../../device-pairing-CsJif6Rb.js";
import "../../line-DvbTO_h3.js";
import "../../upsert-with-lock-BkGBN4WL.js";
import "../../self-hosted-provider-setup-Bgv4n1Xv.js";
import "../../ollama-setup-CXkNt6CA.js";
import { n as buildPassiveProbedChannelStatusSummary } from "../../channel-status-summary-DPOZ4DXQ.js";
import { n as imessageSetupAdapter, t as createIMessageSetupWizardProxy } from "../../setup-core-C4SdefP-.js";
//#region extensions/imessage/src/runtime.ts
const { setRuntime: setIMessageRuntime, getRuntime: getIMessageRuntime } = createPluginRuntimeStore("iMessage runtime not initialized");
//#endregion
//#region extensions/imessage/src/channel.ts
const meta = getChatChannelMeta("imessage");
async function loadIMessageChannelRuntime() {
	return await import("../../channel.runtime-CU09XD5v.js");
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
