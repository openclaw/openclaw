import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import { g as DEFAULT_ACCOUNT_ID } from "../../session-key-BSZsryCD.js";
import { Hn as PAIRING_APPROVED_MESSAGE, Jn as setAccountEnabledInConfigSection, Un as buildAccountScopedDmSecurityPolicy, Zn as buildChannelConfigSchema, f as getChatChannelMeta, qn as deleteAccountFromConfigSection, t as buildAgentSessionKey } from "../../resolve-route-CQsiaDZO.js";
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
import "../../core-CUbPSeQH.js";
import "../../paths-DAoqckDF.js";
import { $a as resolveSignalAccount, Ad as resolveMarkdownTableMode, Am as createScopedAccountConfigAccessors, Ba as createSignalSetupWizardProxy, Cp as SignalConfigSchema, Ka as markdownToSignalTextChunks, Nd as resolveTextChunkLimit, O as collectAllowlistProviderRestrictSendersWarnings, Qa as resolveDefaultSignalAccountId, Ud as buildBaseAccountStatusSnapshot, Va as signalSetupAdapter, Wd as buildBaseChannelStatusSummary, Xd as createDefaultChannelRuntimeState, Yd as collectStatusIssuesFromLastError, Za as listSignalAccountIds, at as looksLikeUuid, ct as resolveSignalSender, eo as resolveChannelMediaMaxBytes, no as normalizeSignalMessagingTarget, ot as resolveSignalPeerId, st as resolveSignalRecipient, to as looksLikeSignalTargetId, ui as resolveOutboundSendDep, y as createPluginRuntimeStore } from "../../auth-profiles-B70DPAVa.js";
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
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, getRuntime: getSignalRuntime } = createPluginRuntimeStore("Signal runtime not initialized");
//#endregion
//#region extensions/signal/src/channel.ts
async function loadSignalChannelRuntime() {
	return await import("../../channel.runtime-D-Hmuw5J.js");
}
const signalSetupWizard = createSignalSetupWizardProxy(async () => ({ signalSetupWizard: (await loadSignalChannelRuntime()).signalSetupWizard }));
const signalMessageActions = {
	listActions: (ctx) => getSignalRuntime().channel.signal.messageActions?.listActions?.(ctx) ?? [],
	supportsAction: (ctx) => getSignalRuntime().channel.signal.messageActions?.supportsAction?.(ctx) ?? false,
	handleAction: async (ctx) => {
		const ma = getSignalRuntime().channel.signal.messageActions;
		if (!ma?.handleAction) throw new Error("Signal message actions not available");
		return ma.handleAction(ctx);
	}
};
const signalConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveSignalAccount({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))).filter(Boolean),
	resolveDefaultTo: (account) => account.config.defaultTo
});
function resolveSignalSendContext(params) {
	return {
		send: resolveOutboundSendDep(params.deps, "signal") ?? getSignalRuntime().channel.signal.sendMessageSignal,
		maxBytes: resolveChannelMediaMaxBytes({
			cfg: params.cfg,
			resolveChannelLimitMb: ({ cfg, accountId }) => cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
			accountId: params.accountId
		})
	};
}
async function sendSignalOutbound(params) {
	const { send, maxBytes } = resolveSignalSendContext(params);
	return await send(params.to, params.text, {
		cfg: params.cfg,
		...params.mediaUrl ? { mediaUrl: params.mediaUrl } : {},
		...params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {},
		maxBytes,
		accountId: params.accountId ?? void 0
	});
}
function inferSignalTargetChatType(rawTo) {
	let to = rawTo.trim();
	if (!to) return;
	if (/^signal:/i.test(to)) to = to.replace(/^signal:/i, "").trim();
	if (!to) return;
	const lower = to.toLowerCase();
	if (lower.startsWith("group:")) return "group";
	if (lower.startsWith("username:") || lower.startsWith("u:")) return "direct";
	return "direct";
}
function parseSignalExplicitTarget(raw) {
	const normalized = normalizeSignalMessagingTarget(raw);
	if (!normalized) return null;
	return {
		to: normalized,
		chatType: inferSignalTargetChatType(normalized)
	};
}
function buildSignalBaseSessionKey(params) {
	return buildAgentSessionKey({
		agentId: params.agentId,
		channel: "signal",
		accountId: params.accountId,
		peer: params.peer,
		dmScope: params.cfg.session?.dmScope ?? "main",
		identityLinks: params.cfg.session?.identityLinks
	});
}
function resolveSignalOutboundSessionRoute(params) {
	const stripped = params.target.replace(/^signal:/i, "").trim();
	const lowered = stripped.toLowerCase();
	if (lowered.startsWith("group:")) {
		const groupId = stripped.slice(6).trim();
		if (!groupId) return null;
		const peer = {
			kind: "group",
			id: groupId
		};
		const baseSessionKey = buildSignalBaseSessionKey({
			cfg: params.cfg,
			agentId: params.agentId,
			accountId: params.accountId,
			peer
		});
		return {
			sessionKey: baseSessionKey,
			baseSessionKey,
			peer,
			chatType: "group",
			from: `group:${groupId}`,
			to: `group:${groupId}`
		};
	}
	let recipient = stripped.trim();
	if (lowered.startsWith("username:")) recipient = stripped.slice(9).trim();
	else if (lowered.startsWith("u:")) recipient = stripped.slice(2).trim();
	if (!recipient) return null;
	const uuidCandidate = recipient.toLowerCase().startsWith("uuid:") ? recipient.slice(5) : recipient;
	const sender = resolveSignalSender({
		sourceUuid: looksLikeUuid(uuidCandidate) ? uuidCandidate : null,
		sourceNumber: looksLikeUuid(uuidCandidate) ? null : recipient
	});
	const peerId = sender ? resolveSignalPeerId(sender) : recipient;
	const displayRecipient = sender ? resolveSignalRecipient(sender) : recipient;
	const peer = {
		kind: "direct",
		id: peerId
	};
	const baseSessionKey = buildSignalBaseSessionKey({
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
		from: `signal:${displayRecipient}`,
		to: `signal:${displayRecipient}`
	};
}
async function sendFormattedSignalText(ctx) {
	const { send, maxBytes } = resolveSignalSendContext({
		cfg: ctx.cfg,
		accountId: ctx.accountId ?? void 0,
		deps: ctx.deps
	});
	const limit = resolveTextChunkLimit(ctx.cfg, "signal", ctx.accountId ?? void 0, { fallbackLimit: 4e3 });
	const tableMode = resolveMarkdownTableMode({
		cfg: ctx.cfg,
		channel: "signal",
		accountId: ctx.accountId ?? void 0
	});
	let chunks = limit === void 0 ? markdownToSignalTextChunks(ctx.text, Number.POSITIVE_INFINITY, { tableMode }) : markdownToSignalTextChunks(ctx.text, limit, { tableMode });
	if (chunks.length === 0 && ctx.text) chunks = [{
		text: ctx.text,
		styles: []
	}];
	const results = [];
	for (const chunk of chunks) {
		ctx.abortSignal?.throwIfAborted();
		const result = await send(ctx.to, chunk.text, {
			cfg: ctx.cfg,
			maxBytes,
			accountId: ctx.accountId ?? void 0,
			textMode: "plain",
			textStyles: chunk.styles
		});
		results.push({
			channel: "signal",
			...result
		});
	}
	return results;
}
async function sendFormattedSignalMedia(ctx) {
	ctx.abortSignal?.throwIfAborted();
	const { send, maxBytes } = resolveSignalSendContext({
		cfg: ctx.cfg,
		accountId: ctx.accountId ?? void 0,
		deps: ctx.deps
	});
	const tableMode = resolveMarkdownTableMode({
		cfg: ctx.cfg,
		channel: "signal",
		accountId: ctx.accountId ?? void 0
	});
	const formatted = markdownToSignalTextChunks(ctx.text, Number.POSITIVE_INFINITY, { tableMode })[0] ?? {
		text: ctx.text,
		styles: []
	};
	return {
		channel: "signal",
		...await send(ctx.to, formatted.text, {
			cfg: ctx.cfg,
			mediaUrl: ctx.mediaUrl,
			mediaLocalRoots: ctx.mediaLocalRoots,
			maxBytes,
			accountId: ctx.accountId ?? void 0,
			textMode: "plain",
			textStyles: formatted.styles
		})
	};
}
const signalPlugin = {
	id: "signal",
	meta: { ...getChatChannelMeta("signal") },
	setupWizard: signalSetupWizard,
	pairing: {
		idLabel: "signalNumber",
		normalizeAllowEntry: (entry) => entry.replace(/^signal:/i, ""),
		notifyApproval: async ({ id }) => {
			await getSignalRuntime().channel.signal.sendMessageSignal(id, PAIRING_APPROVED_MESSAGE);
		}
	},
	capabilities: {
		chatTypes: ["direct", "group"],
		media: true,
		reactions: true
	},
	actions: signalMessageActions,
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
	allowlist: {
		supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
		readConfig: ({ cfg, accountId }) => {
			const account = resolveSignalAccount({
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
			channelId: "signal",
			normalize: ({ cfg, accountId, values }) => signalConfigAccessors.formatAllowFrom({
				cfg,
				accountId,
				allowFrom: values
			}),
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
				channelKey: "signal",
				accountId,
				fallbackAccountId: account.accountId ?? "default",
				policy: account.config.dmPolicy,
				allowFrom: account.config.allowFrom ?? [],
				policyPathSuffix: "dmPolicy",
				normalizeEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim())
			});
		},
		collectWarnings: ({ account, cfg }) => {
			return collectAllowlistProviderRestrictSendersWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.signal !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				surface: "Signal groups",
				openScope: "any member",
				groupPolicyPath: "channels.signal.groupPolicy",
				groupAllowFromPath: "channels.signal.groupAllowFrom",
				mentionGated: false
			});
		}
	},
	messaging: {
		normalizeTarget: normalizeSignalMessagingTarget,
		parseExplicitTarget: ({ raw }) => parseSignalExplicitTarget(raw),
		inferTargetChatType: ({ to }) => inferSignalTargetChatType(to),
		resolveOutboundSessionRoute: (params) => resolveSignalOutboundSessionRoute(params),
		targetResolver: {
			looksLikeId: looksLikeSignalTargetId,
			hint: "<E.164|uuid:ID|group:ID|signal:group:ID|signal:+E.164>"
		}
	},
	setup: signalSetupAdapter,
	outbound: {
		deliveryMode: "direct",
		chunker: (text, limit) => getSignalRuntime().channel.text.chunkText(text, limit),
		chunkerMode: "text",
		textChunkLimit: 4e3,
		sendFormattedText: async ({ cfg, to, text, accountId, deps, abortSignal }) => await sendFormattedSignalText({
			cfg,
			to,
			text,
			accountId,
			deps,
			abortSignal
		}),
		sendFormattedMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, abortSignal }) => await sendFormattedSignalMedia({
			cfg,
			to,
			text,
			mediaUrl,
			mediaLocalRoots,
			accountId,
			deps,
			abortSignal
		}),
		sendText: async ({ cfg, to, text, accountId, deps }) => {
			return {
				channel: "signal",
				...await sendSignalOutbound({
					cfg,
					to,
					text,
					accountId: accountId ?? void 0,
					deps
				})
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps }) => {
			return {
				channel: "signal",
				...await sendSignalOutbound({
					cfg,
					to,
					text,
					mediaUrl,
					mediaLocalRoots,
					accountId: accountId ?? void 0,
					deps
				})
			};
		}
	},
	status: {
		defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
		collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("signal", accounts),
		buildChannelSummary: ({ snapshot }) => ({
			...buildBaseChannelStatusSummary(snapshot),
			baseUrl: snapshot.baseUrl ?? null,
			probe: snapshot.probe,
			lastProbeAt: snapshot.lastProbeAt ?? null
		}),
		probeAccount: async ({ account, timeoutMs }) => {
			const baseUrl = account.baseUrl;
			return await getSignalRuntime().channel.signal.probeSignal(baseUrl, timeoutMs);
		},
		formatCapabilitiesProbe: ({ probe }) => probe?.version ? [{ text: `Signal daemon: ${probe.version}` }] : [],
		buildAccountSnapshot: ({ account, runtime, probe }) => ({
			...buildBaseAccountStatusSnapshot({
				account,
				runtime,
				probe
			}),
			baseUrl: account.baseUrl
		})
	},
	gateway: { startAccount: async (ctx) => {
		const account = ctx.account;
		ctx.setStatus({
			accountId: account.accountId,
			baseUrl: account.baseUrl
		});
		ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
		return getSignalRuntime().channel.signal.monitorSignalProvider({
			accountId: account.accountId,
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			mediaMaxMb: account.config.mediaMaxMb
		});
	} }
};
//#endregion
//#region extensions/signal/index.ts
const plugin = {
	id: "signal",
	name: "Signal",
	description: "Signal channel plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setSignalRuntime(api.runtime);
		api.registerChannel({ plugin: signalPlugin });
	}
};
//#endregion
export { plugin as default };
