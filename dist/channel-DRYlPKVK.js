import { a as normalizeLowercaseStringOrEmpty, d as normalizeStringifiedOptionalString } from "./string-coerce-LndEvhRk.js";
import { l as normalizeE164 } from "./utils-CKsuXgDI.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-CwBWagLE.js";
import { a as chunkText, c as resolveTextChunkLimit } from "./chunk-CGVwhsnj.js";
import { n as resolveOutboundSendDep } from "./send-deps-jTRjIYIm.js";
import { s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-Dzal6cfS.js";
import { t as buildOutboundBaseSessionKey } from "./base-session-key-Cg8jJPrg.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { n as describeAccountSnapshot } from "./account-helpers-Ba4hZbOH.js";
import { c as getChatChannelMeta, i as createChatChannelPlugin, r as createChannelPluginBase } from "./core-BPnS_bab.js";
import "./channel-core-BoAjH-Jl.js";
import "./routing-BfSZVtOk.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-CCZPL3sp.js";
import { r as createRestrictSendersChannelSecurity } from "./channel-policy-DorgJeIC.js";
import { t as resolveApprovalApprovers } from "./approval-approvers-CU1TPzr2.js";
import { t as createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers-7oBaTEgH.js";
import "./reply-chunking-DnJ1jlVh.js";
import { a as resolveChannelMediaMaxBytes } from "./media-runtime-DWh6m_8p.js";
import "./markdown-table-runtime-BtsiVyHf.js";
import { n as buildDmGroupAccountAllowlistAdapter } from "./allowlist-config-edit-DAOnqNNq.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./pairing-message-C5_Dm1pD.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, u as createComputedAccountStatusAdapter } from "./status-helpers-Dk-3BT6p.js";
import "./channel-status-DQzE7laT.js";
import { r as defineChannelMessageAdapter } from "./channel-message-CmG6T1ry.js";
import { i as createPairingPrefixStripper } from "./channel-pairing--8umY0wm.js";
import { n as attachChannelToResults, t as attachChannelToResult } from "./channel-send-result-CJR0gRri.js";
import "./text-utility-runtime-CG5gZFsT.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId } from "./accounts-1GlRRBqz.js";
import { c as resolveSignalSender, d as normalizeSignalMessagingTarget, l as looksLikeUuid, o as resolveSignalPeerId, s as resolveSignalRecipient, u as looksLikeSignalTargetId } from "./identity-BtCkAf6q.js";
import { n as markdownToSignalTextChunks } from "./format-D1456gkg.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "./message-actions-HzkMqDqD.js";
import { n as createSignalSetupWizardProxy, s as signalSetupAdapter } from "./setup-core-tQ7IENke.js";
import { t as SignalChannelConfigSchema } from "./config-schema-CuCenyMZ.js";
//#region extensions/signal/src/approval-auth.ts
function normalizeSignalApproverId(value) {
	const normalized = normalizeSignalMessagingTarget(String(value));
	if (!normalized || normalized.startsWith("group:") || normalized.startsWith("username:")) return;
	if (looksLikeUuid(normalized)) return `uuid:${normalized}`;
	const e164 = normalizeE164(normalized);
	return e164.length > 1 ? e164 : void 0;
}
const signalApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "Signal",
	resolveApprovers: ({ cfg, accountId }) => {
		const account = resolveSignalAccount({
			cfg,
			accountId
		}).config;
		return resolveApprovalApprovers({
			allowFrom: account.allowFrom,
			defaultTo: account.defaultTo,
			normalizeApprover: normalizeSignalApproverId
		});
	},
	normalizeSenderId: (value) => normalizeSignalApproverId(value)
});
//#endregion
//#region extensions/signal/src/outbound-session.ts
function resolveSignalOutboundTarget(target) {
	const stripped = target.replace(/^signal:/i, "").trim();
	const lowered = normalizeLowercaseStringOrEmpty(stripped);
	if (lowered.startsWith("group:")) {
		const groupId = stripped.slice(6).trim();
		if (!groupId) return null;
		return {
			peer: {
				kind: "group",
				id: groupId
			},
			chatType: "group",
			from: `group:${groupId}`,
			to: `group:${groupId}`
		};
	}
	let recipient = stripped.trim();
	if (lowered.startsWith("username:")) recipient = stripped.slice(9).trim();
	else if (lowered.startsWith("u:")) recipient = stripped.slice(2).trim();
	if (!recipient) return null;
	const uuidCandidate = normalizeLowercaseStringOrEmpty(recipient).startsWith("uuid:") ? recipient.slice(5) : recipient;
	const sender = resolveSignalSender({
		sourceUuid: looksLikeUuid(uuidCandidate) ? uuidCandidate : null,
		sourceNumber: looksLikeUuid(uuidCandidate) ? null : recipient
	});
	const peerId = sender ? resolveSignalPeerId(sender) : recipient;
	const displayRecipient = sender ? resolveSignalRecipient(sender) : recipient;
	return {
		peer: {
			kind: "direct",
			id: peerId
		},
		chatType: "direct",
		from: `signal:${displayRecipient}`,
		to: `signal:${displayRecipient}`
	};
}
//#endregion
//#region extensions/signal/src/shared.ts
const SIGNAL_CHANNEL = "signal";
async function loadSignalChannelRuntime() {
	return await import("./channel.runtime-jDWOWvQi.js");
}
const signalSetupWizard = createSignalSetupWizardProxy(async () => (await loadSignalChannelRuntime()).signalSetupWizard);
const signalConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: SIGNAL_CHANNEL,
	listAccountIds: (cfg) => listSignalAccountIds(cfg),
	resolveAccount: adaptScopedAccountAccessor((params) => resolveSignalAccount(params)),
	defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
	clearBaseFields: [
		"account",
		"httpUrl",
		"httpHost",
		"httpPort",
		"cliPath",
		"name"
	],
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => allowFrom.map((entry) => normalizeStringifiedOptionalString(entry)).filter((entry) => Boolean(entry)).map((entry) => entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))).filter(Boolean),
	resolveDefaultTo: (account) => account.config.defaultTo
});
const signalSecurityAdapter = createRestrictSendersChannelSecurity({
	channelKey: SIGNAL_CHANNEL,
	resolveDmPolicy: (account) => account.config.dmPolicy,
	resolveDmAllowFrom: (account) => account.config.allowFrom,
	resolveGroupPolicy: (account) => account.config.groupPolicy,
	surface: "Signal groups",
	openScope: "any member",
	groupPolicyPath: "channels.signal.groupPolicy",
	groupAllowFromPath: "channels.signal.groupAllowFrom",
	mentionGated: false,
	policyPathSuffix: "dmPolicy",
	normalizeDmEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim())
});
function createSignalPluginBase(params) {
	return {
		...createChannelPluginBase({
			id: SIGNAL_CHANNEL,
			meta: { ...getChatChannelMeta(SIGNAL_CHANNEL) },
			setupWizard: params.setupWizard,
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
			configSchema: SignalChannelConfigSchema,
			config: {
				...signalConfigAdapter,
				isConfigured: (account) => account.configured,
				describeAccount: (account) => describeAccountSnapshot({
					account,
					configured: account.configured,
					extra: { baseUrl: account.baseUrl }
				})
			},
			security: signalSecurityAdapter,
			setup: params.setup
		}),
		messaging: { defaultMarkdownTableMode: "bullets" }
	};
}
//#endregion
//#region extensions/signal/src/channel.ts
let signalMonitorModulePromise = null;
let signalProbeModulePromise = null;
let signalSendRuntimePromise = null;
async function loadSignalMonitorModule() {
	signalMonitorModulePromise ??= import("./monitor-Dh3PusRs.js");
	return await signalMonitorModulePromise;
}
async function loadSignalProbeModule() {
	signalProbeModulePromise ??= import("./probe-DivBe8-r.js");
	return await signalProbeModulePromise;
}
async function loadSignalSendRuntime() {
	signalSendRuntimePromise ??= import("./send.runtime-ZKbDN6rX.js");
	return await signalSendRuntimePromise;
}
async function resolveSignalSendContext(params) {
	return {
		send: resolveOutboundSendDep(params.deps, "signal") ?? (await loadSignalSendRuntime()).sendMessageSignal,
		maxBytes: resolveChannelMediaMaxBytes({
			cfg: params.cfg,
			resolveChannelLimitMb: ({ cfg, accountId }) => cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
			accountId: params.accountId
		})
	};
}
async function sendSignalOutbound(params) {
	const { send, maxBytes } = await resolveSignalSendContext(params);
	return await send(params.to, params.text, {
		cfg: params.cfg,
		...params.mediaUrl ? { mediaUrl: params.mediaUrl } : {},
		...params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {},
		...params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {},
		maxBytes,
		accountId: params.accountId ?? void 0
	});
}
const signalMessageAdapter = defineChannelMessageAdapter({
	id: "signal",
	durableFinal: { capabilities: {
		text: true,
		media: true
	} },
	send: {
		text: async (ctx) => await sendSignalOutbound({
			cfg: ctx.cfg,
			to: ctx.to,
			text: ctx.text,
			accountId: ctx.accountId ?? void 0,
			deps: ctx.deps
		}),
		media: async (ctx) => await sendSignalOutbound({
			cfg: ctx.cfg,
			to: ctx.to,
			text: ctx.text,
			mediaUrl: ctx.mediaUrl,
			mediaLocalRoots: ctx.mediaLocalRoots,
			mediaReadFile: ctx.mediaReadFile,
			accountId: ctx.accountId ?? void 0,
			deps: ctx.deps
		})
	}
});
function inferSignalTargetChatType(rawTo) {
	let to = rawTo.trim();
	if (!to) return;
	if (/^signal:/i.test(to)) to = to.replace(/^signal:/i, "").trim();
	if (!to) return;
	const lower = normalizeLowercaseStringOrEmpty(to);
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
	return buildOutboundBaseSessionKey({
		...params,
		channel: "signal"
	});
}
function resolveSignalOutboundSessionRoute(params) {
	const resolved = resolveSignalOutboundTarget(params.target);
	if (!resolved) return null;
	const baseSessionKey = buildSignalBaseSessionKey({
		cfg: params.cfg,
		agentId: params.agentId,
		accountId: params.accountId,
		peer: resolved.peer
	});
	return {
		sessionKey: baseSessionKey,
		baseSessionKey,
		...resolved
	};
}
async function sendFormattedSignalText(ctx) {
	const { send, maxBytes } = await resolveSignalSendContext({
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
		results.push(result);
	}
	return attachChannelToResults("signal", results);
}
async function sendFormattedSignalMedia(ctx) {
	ctx.abortSignal?.throwIfAborted();
	const { send, maxBytes } = await resolveSignalSendContext({
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
	return attachChannelToResult("signal", await send(ctx.to, formatted.text, {
		cfg: ctx.cfg,
		mediaUrl: ctx.mediaUrl,
		mediaLocalRoots: ctx.mediaLocalRoots,
		...ctx.mediaReadFile ? { mediaReadFile: ctx.mediaReadFile } : {},
		maxBytes,
		accountId: ctx.accountId ?? void 0,
		textMode: "plain",
		textStyles: formatted.styles
	}));
}
const signalPlugin = createChatChannelPlugin({
	base: {
		...createSignalPluginBase({
			setupWizard: signalSetupWizard,
			setup: signalSetupAdapter
		}),
		actions: signalMessageActions,
		approvalCapability: signalApprovalAuth,
		allowlist: buildDmGroupAccountAllowlistAdapter({
			channelId: "signal",
			resolveAccount: resolveSignalAccount,
			normalize: ({ cfg, accountId, values }) => signalConfigAdapter.formatAllowFrom({
				cfg,
				accountId,
				allowFrom: values
			}),
			resolveDmAllowFrom: (account) => account.config.allowFrom,
			resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
			resolveDmPolicy: (account) => account.config.dmPolicy,
			resolveGroupPolicy: (account) => account.config.groupPolicy
		}),
		agentPrompt: { reactionGuidance: ({ cfg, accountId }) => {
			const level = resolveSignalReactionLevel({
				cfg,
				accountId: accountId ?? void 0
			}).agentReactionGuidance;
			return level ? {
				level,
				channelLabel: "Signal"
			} : void 0;
		} },
		messaging: {
			targetPrefixes: ["signal"],
			normalizeTarget: normalizeSignalMessagingTarget,
			parseExplicitTarget: ({ raw }) => parseSignalExplicitTarget(raw),
			inferTargetChatType: ({ to }) => inferSignalTargetChatType(to),
			resolveOutboundSessionRoute: (params) => resolveSignalOutboundSessionRoute(params),
			targetResolver: {
				looksLikeId: looksLikeSignalTargetId,
				hint: "<E.164|uuid:ID|group:ID|signal:group:ID|signal:+E.164>"
			}
		},
		heartbeat: {
			sendTyping: async ({ cfg, to, accountId }) => {
				await (await loadSignalSendRuntime()).sendTypingSignal(to, {
					cfg,
					...accountId ? { accountId } : {}
				});
			},
			clearTyping: async ({ cfg, to, accountId }) => {
				await (await loadSignalSendRuntime()).sendTypingSignal(to, {
					cfg,
					...accountId ? { accountId } : {},
					stop: true
				});
			}
		},
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("signal", accounts),
			buildChannelSummary: ({ snapshot }) => buildBaseChannelStatusSummary(snapshot, {
				baseUrl: snapshot.baseUrl ?? null,
				probe: snapshot.probe,
				lastProbeAt: snapshot.lastProbeAt ?? null
			}),
			probeAccount: async ({ account, timeoutMs }) => {
				const baseUrl = account.baseUrl;
				const { probeSignal } = await loadSignalProbeModule();
				return await probeSignal(baseUrl, timeoutMs, { apiMode: account.config?.apiMode ?? "auto" });
			},
			formatCapabilitiesProbe: ({ probe }) => probe?.version ? [{ text: `Signal daemon: ${probe.version}` }] : [],
			resolveAccountSnapshot: ({ account }) => ({
				accountId: account.accountId,
				name: account.name,
				enabled: account.enabled,
				configured: account.configured,
				extra: { baseUrl: account.baseUrl }
			})
		}),
		gateway: { startAccount: async (ctx) => {
			const account = ctx.account;
			ctx.setStatus({
				accountId: account.accountId,
				baseUrl: account.baseUrl
			});
			ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
			const { monitorSignalProvider } = await loadSignalMonitorModule();
			return await monitorSignalProvider({
				accountId: account.accountId,
				config: ctx.cfg,
				runtime: ctx.runtime,
				abortSignal: ctx.abortSignal,
				mediaMaxMb: account.config.mediaMaxMb
			});
		} },
		message: signalMessageAdapter
	},
	pairing: { text: {
		idLabel: "signalNumber",
		message: PAIRING_APPROVED_MESSAGE,
		normalizeAllowEntry: createPairingPrefixStripper(/^signal:/i),
		notify: async ({ cfg, id, message }) => {
			await (await loadSignalSendRuntime()).sendMessageSignal(id, message, { cfg });
		}
	} },
	security: signalSecurityAdapter,
	outbound: {
		base: {
			deliveryMode: "direct",
			chunker: chunkText,
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
			sendFormattedMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, mediaReadFile, accountId, deps, abortSignal }) => await sendFormattedSignalMedia({
				cfg,
				to,
				text,
				mediaUrl,
				mediaLocalRoots,
				mediaReadFile,
				accountId,
				deps,
				abortSignal
			})
		},
		attachedResults: {
			channel: "signal",
			sendText: async ({ cfg, to, text, accountId, deps }) => await sendSignalOutbound({
				cfg,
				to,
				text,
				accountId: accountId ?? void 0,
				deps
			}),
			sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, mediaReadFile, accountId, deps }) => await sendSignalOutbound({
				cfg,
				to,
				text,
				mediaUrl,
				mediaLocalRoots,
				mediaReadFile,
				accountId: accountId ?? void 0,
				deps
			})
		}
	}
});
//#endregion
export { resolveSignalOutboundTarget as i, createSignalPluginBase as n, signalSetupWizard as r, signalPlugin as t };
