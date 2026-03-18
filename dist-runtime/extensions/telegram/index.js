import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import { f as resolveThreadSessionKeys, g as DEFAULT_ACCOUNT_ID, v as normalizeAccountId } from "../../session-key-BSZsryCD.js";
import { Hn as PAIRING_APPROVED_MESSAGE, Kn as clearAccountEntryFields, Zn as buildChannelConfigSchema, f as getChatChannelMeta, ft as init_targets, ht as parseTelegramTarget, t as buildAgentSessionKey } from "../../resolve-route-CQsiaDZO.js";
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
import { $r as buildExecApprovalPendingReplyPayload, Aa as normalizeTelegramMessagingTarget, Am as createScopedAccountConfigAccessors, D as collectAllowlistProviderGroupPolicyWarnings, Da as parseTelegramReplyToMessageId, Fa as resolveTelegramAccount, Gr as telegramSetupAdapter, Jd as buildTokenChannelStatusSummary, Jr as isTelegramExecApprovalClientEnabled, Mm as createScopedDmSecurityResolver, Na as listTelegramAccountIds, Oa as parseTelegramThreadId, Pa as resolveDefaultTelegramAccountId, Tp as TelegramConfigSchema, Wp as normalizeMessageChannel, Wr as telegramSetupWizard, Xr as resolveTelegramExecApprovalTarget, Yi as buildTelegramGroupPeerId, cf as projectCredentialSnapshotFields, di as collectTelegramStatusIssues, ds as parseTelegramTopicConversation, du as resolveTelegramGroupRequireMention, fu as resolveTelegramGroupToolPolicy, it as collectTelegramUnmentionedGroupIds, j as collectOpenGroupPolicyRouteAllowlistWarnings, ja as inspectTelegramAccount, ji as sendTypingTelegram, jm as createScopedChannelConfigBase, ka as looksLikeTelegramTargetId, lf as resolveConfiguredFromCredentialStatuses, li as sendTelegramPayloadMessages, rt as auditTelegramGroupMembership, ui as resolveOutboundSendDep, vm as listTelegramDirectoryGroupsFromConfig, wt as formatAllowFromLowercase, y as createPluginRuntimeStore, ym as listTelegramDirectoryPeersFromConfig } from "../../auth-profiles-B70DPAVa.js";
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
import "../../persistent-bindings.route-B997Djeo.js";
import "../../telegram-Dx47icNH.js";
import { o as resolveExecApprovalCommandDisplay } from "../../draft-stream-controls-DuBDAC-Y.js";
import { n as monitorTelegramProvider, r as buildTelegramExecApprovalButtons, t as probeTelegram } from "../../probe-DQVbDnzw.js";
import "../../session-meta-DWPXbWDr.js";
import "../../update-offset-store-D1cd-oPv.js";
//#region extensions/telegram/src/runtime.ts
const { setRuntime: setTelegramRuntime, getRuntime: getTelegramRuntime } = createPluginRuntimeStore("Telegram runtime not initialized");
//#endregion
//#region extensions/telegram/src/channel.ts
init_targets();
const meta = getChatChannelMeta("telegram");
function findTelegramTokenOwnerAccountId(params) {
	const normalizedAccountId = normalizeAccountId(params.accountId);
	const tokenOwners = /* @__PURE__ */ new Map();
	for (const id of listTelegramAccountIds(params.cfg)) {
		const account = inspectTelegramAccount({
			cfg: params.cfg,
			accountId: id
		});
		const token = (account.token ?? "").trim();
		if (!token) continue;
		const ownerAccountId = tokenOwners.get(token);
		if (!ownerAccountId) {
			tokenOwners.set(token, account.accountId);
			continue;
		}
		if (account.accountId === normalizedAccountId) return ownerAccountId;
	}
	return null;
}
function formatDuplicateTelegramTokenReason(params) {
	return `Duplicate Telegram bot token: account "${params.accountId}" shares a token with account "${params.ownerAccountId}". Keep one owner account per bot token.`;
}
function buildTelegramSendOptions(params) {
	return {
		verbose: false,
		cfg: params.cfg,
		...params.mediaUrl ? { mediaUrl: params.mediaUrl } : {},
		...params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {},
		messageThreadId: parseTelegramThreadId(params.threadId),
		replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
		accountId: params.accountId ?? void 0,
		silent: params.silent ?? void 0,
		forceDocument: params.forceDocument ?? void 0
	};
}
async function sendTelegramOutbound(params) {
	return await (resolveOutboundSendDep(params.deps, "telegram") ?? getTelegramRuntime().channel.telegram.sendMessageTelegram)(params.to, params.text, buildTelegramSendOptions({
		cfg: params.cfg,
		mediaUrl: params.mediaUrl,
		mediaLocalRoots: params.mediaLocalRoots,
		accountId: params.accountId,
		replyToId: params.replyToId,
		threadId: params.threadId,
		silent: params.silent
	}));
}
function resolveTelegramAutoThreadId(params) {
	const context = params.toolContext;
	if (!context?.currentThreadTs || !context.currentChannelId) return;
	const parsedTo = parseTelegramTarget(params.to);
	const parsedChannel = parseTelegramTarget(context.currentChannelId);
	if (parsedTo.chatId.toLowerCase() !== parsedChannel.chatId.toLowerCase()) return;
	return context.currentThreadTs;
}
function normalizeTelegramAcpConversationId(conversationId) {
	const parsed = parseTelegramTopicConversation({ conversationId });
	if (!parsed || !parsed.chatId.startsWith("-")) return null;
	return {
		conversationId: parsed.canonicalConversationId,
		parentConversationId: parsed.chatId
	};
}
function matchTelegramAcpConversation(params) {
	const binding = normalizeTelegramAcpConversationId(params.bindingConversationId);
	if (!binding) return null;
	const incoming = parseTelegramTopicConversation({
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	if (!incoming || !incoming.chatId.startsWith("-")) return null;
	if (binding.conversationId !== incoming.canonicalConversationId) return null;
	return {
		conversationId: incoming.canonicalConversationId,
		parentConversationId: incoming.chatId,
		matchPriority: 2
	};
}
function parseTelegramExplicitTarget(raw) {
	const target = parseTelegramTarget(raw);
	return {
		to: target.chatId,
		threadId: target.messageThreadId,
		chatType: target.chatType === "unknown" ? void 0 : target.chatType
	};
}
function normalizeOutboundThreadId(value) {
	if (value == null) return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return;
		return String(Math.trunc(value));
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function buildTelegramBaseSessionKey(params) {
	return buildAgentSessionKey({
		agentId: params.agentId,
		channel: "telegram",
		accountId: params.accountId,
		peer: params.peer,
		dmScope: params.cfg.session?.dmScope ?? "main",
		identityLinks: params.cfg.session?.identityLinks
	});
}
function resolveTelegramOutboundSessionRoute(params) {
	const parsed = parseTelegramTarget(params.target);
	const chatId = parsed.chatId.trim();
	if (!chatId) return null;
	const fallbackThreadId = normalizeOutboundThreadId(params.threadId);
	const resolvedThreadId = parsed.messageThreadId ?? parseTelegramThreadId(fallbackThreadId);
	const isGroup = parsed.chatType === "group" || parsed.chatType === "unknown" && params.resolvedTarget?.kind && params.resolvedTarget.kind !== "user";
	const peerId = isGroup && resolvedThreadId ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : chatId;
	const peer = {
		kind: isGroup ? "group" : "direct",
		id: peerId
	};
	const baseSessionKey = buildTelegramBaseSessionKey({
		cfg: params.cfg,
		agentId: params.agentId,
		accountId: params.accountId,
		peer
	});
	return {
		sessionKey: (resolvedThreadId && !isGroup ? resolveThreadSessionKeys({
			baseSessionKey,
			threadId: String(resolvedThreadId)
		}) : null)?.sessionKey ?? baseSessionKey,
		baseSessionKey,
		peer,
		chatType: isGroup ? "group" : "direct",
		from: isGroup ? `telegram:group:${peerId}` : resolvedThreadId ? `telegram:${chatId}:topic:${resolvedThreadId}` : `telegram:${chatId}`,
		to: `telegram:${chatId}`,
		threadId: resolvedThreadId
	};
}
function hasTelegramExecApprovalDmRoute(cfg) {
	return listTelegramAccountIds(cfg).some((accountId) => {
		if (!isTelegramExecApprovalClientEnabled({
			cfg,
			accountId
		})) return false;
		const target = resolveTelegramExecApprovalTarget({
			cfg,
			accountId
		});
		return target === "dm" || target === "both";
	});
}
const telegramMessageActions = {
	listActions: (ctx) => getTelegramRuntime().channel.telegram.messageActions?.listActions?.(ctx) ?? [],
	getCapabilities: (ctx) => getTelegramRuntime().channel.telegram.messageActions?.getCapabilities?.(ctx) ?? [],
	extractToolSend: (ctx) => getTelegramRuntime().channel.telegram.messageActions?.extractToolSend?.(ctx) ?? null,
	handleAction: async (ctx) => {
		const ma = getTelegramRuntime().channel.telegram.messageActions;
		if (!ma?.handleAction) throw new Error("Telegram message actions not available");
		return ma.handleAction(ctx);
	}
};
const telegramConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveTelegramAccount({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({
		allowFrom,
		stripPrefixRe: /^(telegram|tg):/i
	}),
	resolveDefaultTo: (account) => account.config.defaultTo
});
const telegramConfigBase = createScopedChannelConfigBase({
	sectionKey: "telegram",
	listAccountIds: listTelegramAccountIds,
	resolveAccount: (cfg, accountId) => resolveTelegramAccount({
		cfg,
		accountId
	}),
	inspectAccount: (cfg, accountId) => inspectTelegramAccount({
		cfg,
		accountId
	}),
	defaultAccountId: resolveDefaultTelegramAccountId,
	clearBaseFields: [
		"botToken",
		"tokenFile",
		"name"
	]
});
const resolveTelegramDmPolicy = createScopedDmSecurityResolver({
	channelKey: "telegram",
	resolvePolicy: (account) => account.config.dmPolicy,
	resolveAllowFrom: (account) => account.config.allowFrom,
	policyPathSuffix: "dmPolicy",
	normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, "")
});
function readTelegramAllowlistConfig(account) {
	const groupOverrides = [];
	for (const [groupId, groupCfg] of Object.entries(account.config.groups ?? {})) {
		const entries = (groupCfg?.allowFrom ?? []).map(String).filter(Boolean);
		if (entries.length > 0) groupOverrides.push({
			label: groupId,
			entries
		});
		for (const [topicId, topicCfg] of Object.entries(groupCfg?.topics ?? {})) {
			const topicEntries = (topicCfg?.allowFrom ?? []).map(String).filter(Boolean);
			if (topicEntries.length > 0) groupOverrides.push({
				label: `${groupId} topic ${topicId}`,
				entries: topicEntries
			});
		}
	}
	return {
		dmAllowFrom: (account.config.allowFrom ?? []).map(String),
		groupAllowFrom: (account.config.groupAllowFrom ?? []).map(String),
		dmPolicy: account.config.dmPolicy,
		groupPolicy: account.config.groupPolicy,
		groupOverrides
	};
}
const telegramPlugin = {
	id: "telegram",
	meta: {
		...meta,
		quickstartAllowFrom: true
	},
	setupWizard: telegramSetupWizard,
	pairing: {
		idLabel: "telegramUserId",
		normalizeAllowEntry: (entry) => entry.replace(/^(telegram|tg):/i, ""),
		notifyApproval: async ({ cfg, id }) => {
			const { token } = getTelegramRuntime().channel.telegram.resolveTelegramToken(cfg);
			if (!token) throw new Error("telegram token not configured");
			await getTelegramRuntime().channel.telegram.sendMessageTelegram(id, PAIRING_APPROVED_MESSAGE, { token });
		}
	},
	capabilities: {
		chatTypes: [
			"direct",
			"group",
			"channel",
			"thread"
		],
		reactions: true,
		threads: true,
		media: true,
		polls: true,
		nativeCommands: true,
		blockStreaming: true
	},
	reload: { configPrefixes: ["channels.telegram"] },
	configSchema: buildChannelConfigSchema(TelegramConfigSchema),
	config: {
		...telegramConfigBase,
		isConfigured: (account, cfg) => {
			if (!account.token?.trim()) return false;
			return !findTelegramTokenOwnerAccountId({
				cfg,
				accountId: account.accountId
			});
		},
		unconfiguredReason: (account, cfg) => {
			if (!account.token?.trim()) return "not configured";
			const ownerAccountId = findTelegramTokenOwnerAccountId({
				cfg,
				accountId: account.accountId
			});
			if (!ownerAccountId) return "not configured";
			return formatDuplicateTelegramTokenReason({
				accountId: account.accountId,
				ownerAccountId
			});
		},
		describeAccount: (account, cfg) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.token?.trim()) && !findTelegramTokenOwnerAccountId({
				cfg,
				accountId: account.accountId
			}),
			tokenSource: account.tokenSource
		}),
		...telegramConfigAccessors
	},
	allowlist: {
		supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
		readConfig: ({ cfg, accountId }) => readTelegramAllowlistConfig(resolveTelegramAccount({
			cfg,
			accountId
		})),
		applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
			channelId: "telegram",
			normalize: ({ cfg, accountId, values }) => telegramConfigAccessors.formatAllowFrom({
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
	acpBindings: {
		normalizeConfiguredBindingTarget: ({ conversationId }) => normalizeTelegramAcpConversationId(conversationId),
		matchConfiguredBinding: ({ bindingConversationId, conversationId, parentConversationId }) => matchTelegramAcpConversation({
			bindingConversationId,
			conversationId,
			parentConversationId
		})
	},
	security: {
		resolveDmPolicy: resolveTelegramDmPolicy,
		collectWarnings: ({ account, cfg }) => {
			const groupAllowlistConfigured = account.config.groups && Object.keys(account.config.groups).length > 0;
			return collectAllowlistProviderGroupPolicyWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.telegram !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				collect: (groupPolicy) => collectOpenGroupPolicyRouteAllowlistWarnings({
					groupPolicy,
					routeAllowlistConfigured: Boolean(groupAllowlistConfigured),
					restrictSenders: {
						surface: "Telegram groups",
						openScope: "any member in allowed groups",
						groupPolicyPath: "channels.telegram.groupPolicy",
						groupAllowFromPath: "channels.telegram.groupAllowFrom"
					},
					noRouteAllowlist: {
						surface: "Telegram groups",
						routeAllowlistPath: "channels.telegram.groups",
						routeScope: "group",
						groupPolicyPath: "channels.telegram.groupPolicy",
						groupAllowFromPath: "channels.telegram.groupAllowFrom"
					}
				})
			});
		}
	},
	groups: {
		resolveRequireMention: resolveTelegramGroupRequireMention,
		resolveToolPolicy: resolveTelegramGroupToolPolicy
	},
	threading: {
		resolveReplyToMode: ({ cfg }) => cfg.channels?.telegram?.replyToMode ?? "off",
		resolveAutoThreadId: ({ to, toolContext, replyToId }) => replyToId ? void 0 : resolveTelegramAutoThreadId({
			to,
			toolContext
		})
	},
	messaging: {
		normalizeTarget: normalizeTelegramMessagingTarget,
		parseExplicitTarget: ({ raw }) => parseTelegramExplicitTarget(raw),
		inferTargetChatType: ({ to }) => parseTelegramExplicitTarget(to).chatType,
		resolveOutboundSessionRoute: (params) => resolveTelegramOutboundSessionRoute(params),
		targetResolver: {
			looksLikeId: looksLikeTelegramTargetId,
			hint: "<chatId>"
		}
	},
	lifecycle: {
		onAccountConfigChanged: async ({ prevCfg, nextCfg, accountId }) => {
			if (resolveTelegramAccount({
				cfg: prevCfg,
				accountId
			}).token.trim() !== resolveTelegramAccount({
				cfg: nextCfg,
				accountId
			}).token.trim()) {
				const { deleteTelegramUpdateOffset } = await import("../../update-offset-store-FP5GdOW_.js");
				await deleteTelegramUpdateOffset({ accountId });
			}
		},
		onAccountRemoved: async ({ accountId }) => {
			const { deleteTelegramUpdateOffset } = await import("../../update-offset-store-FP5GdOW_.js");
			await deleteTelegramUpdateOffset({ accountId });
		}
	},
	execApprovals: {
		getInitiatingSurfaceState: ({ cfg, accountId }) => isTelegramExecApprovalClientEnabled({
			cfg,
			accountId
		}) ? { kind: "enabled" } : { kind: "disabled" },
		hasConfiguredDmRoute: ({ cfg }) => hasTelegramExecApprovalDmRoute(cfg),
		shouldSuppressForwardingFallback: ({ cfg, target, request }) => {
			if ((normalizeMessageChannel(target.channel) ?? target.channel) !== "telegram") return false;
			if (normalizeMessageChannel(request.request.turnSourceChannel ?? "") !== "telegram") return false;
			return isTelegramExecApprovalClientEnabled({
				cfg,
				accountId: target.accountId?.trim() || request.request.turnSourceAccountId?.trim()
			});
		},
		buildPendingPayload: ({ request, nowMs }) => {
			const payload = buildExecApprovalPendingReplyPayload({
				approvalId: request.id,
				approvalSlug: request.id.slice(0, 8),
				approvalCommandId: request.id,
				command: resolveExecApprovalCommandDisplay(request.request).commandText,
				cwd: request.request.cwd ?? void 0,
				host: request.request.host === "node" ? "node" : "gateway",
				nodeId: request.request.nodeId ?? void 0,
				expiresAtMs: request.expiresAtMs,
				nowMs
			});
			const buttons = buildTelegramExecApprovalButtons(request.id);
			if (!buttons) return payload;
			return {
				...payload,
				channelData: {
					...payload.channelData,
					telegram: { buttons }
				}
			};
		},
		beforeDeliverPending: async ({ cfg, target, payload }) => {
			if (!(payload.channelData && typeof payload.channelData === "object" && !Array.isArray(payload.channelData) && payload.channelData.execApproval)) return;
			const threadId = typeof target.threadId === "number" ? target.threadId : typeof target.threadId === "string" ? Number.parseInt(target.threadId, 10) : void 0;
			await sendTypingTelegram(target.to, {
				cfg,
				accountId: target.accountId ?? void 0,
				...Number.isFinite(threadId) ? { messageThreadId: threadId } : {}
			}).catch(() => {});
		}
	},
	directory: {
		self: async () => null,
		listPeers: async (params) => listTelegramDirectoryPeersFromConfig(params),
		listGroups: async (params) => listTelegramDirectoryGroupsFromConfig(params)
	},
	actions: telegramMessageActions,
	setup: telegramSetupAdapter,
	outbound: {
		deliveryMode: "direct",
		chunker: (text, limit) => getTelegramRuntime().channel.text.chunkMarkdownText(text, limit),
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		pollMaxOptions: 10,
		shouldSkipPlainTextSanitization: ({ payload }) => Boolean(payload.channelData),
		resolveEffectiveTextChunkLimit: ({ fallbackLimit }) => typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
		sendPayload: async ({ cfg, to, payload, mediaLocalRoots, accountId, deps, replyToId, threadId, silent, forceDocument }) => {
			return {
				channel: "telegram",
				...await sendTelegramPayloadMessages({
					send: resolveOutboundSendDep(deps, "telegram") ?? getTelegramRuntime().channel.telegram.sendMessageTelegram,
					to,
					payload,
					baseOpts: buildTelegramSendOptions({
						cfg,
						mediaLocalRoots,
						accountId,
						replyToId,
						threadId,
						silent,
						forceDocument
					})
				})
			};
		},
		sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, silent }) => {
			return {
				channel: "telegram",
				...await sendTelegramOutbound({
					cfg,
					to,
					text,
					accountId,
					deps,
					replyToId,
					threadId,
					silent
				})
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, replyToId, threadId, silent }) => {
			return {
				channel: "telegram",
				...await sendTelegramOutbound({
					cfg,
					to,
					text,
					mediaUrl,
					mediaLocalRoots,
					accountId,
					deps,
					replyToId,
					threadId,
					silent
				})
			};
		},
		sendPoll: async ({ cfg, to, poll, accountId, threadId, silent, isAnonymous }) => await getTelegramRuntime().channel.telegram.sendPollTelegram(to, poll, {
			cfg,
			accountId: accountId ?? void 0,
			messageThreadId: parseTelegramThreadId(threadId),
			silent: silent ?? void 0,
			isAnonymous: isAnonymous ?? void 0
		})
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null
		},
		collectStatusIssues: collectTelegramStatusIssues,
		buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
		probeAccount: async ({ account, timeoutMs }) => probeTelegram(account.token, timeoutMs, {
			accountId: account.accountId,
			proxyUrl: account.config.proxy,
			network: account.config.network
		}),
		formatCapabilitiesProbe: ({ probe }) => {
			const lines = [];
			if (probe?.bot?.username) {
				const botId = probe.bot.id ? ` (${probe.bot.id})` : "";
				lines.push({ text: `Bot: @${probe.bot.username}${botId}` });
			}
			const flags = [];
			if (typeof probe?.bot?.canJoinGroups === "boolean") flags.push(`joinGroups=${probe.bot.canJoinGroups}`);
			if (typeof probe?.bot?.canReadAllGroupMessages === "boolean") flags.push(`readAllGroupMessages=${probe.bot.canReadAllGroupMessages}`);
			if (typeof probe?.bot?.supportsInlineQueries === "boolean") flags.push(`inlineQueries=${probe.bot.supportsInlineQueries}`);
			if (flags.length > 0) lines.push({ text: `Flags: ${flags.join(" ")}` });
			if (probe?.webhook?.url !== void 0) lines.push({ text: `Webhook: ${probe.webhook.url || "none"}` });
			return lines;
		},
		auditAccount: async ({ account, timeoutMs, probe, cfg }) => {
			const { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups } = collectTelegramUnmentionedGroupIds(cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ?? cfg.channels?.telegram?.groups);
			if (!groupIds.length && unresolvedGroups === 0 && !hasWildcardUnmentionedGroups) return;
			const botId = probe?.ok && probe.bot?.id != null ? probe.bot.id : null;
			if (!botId) return {
				ok: unresolvedGroups === 0 && !hasWildcardUnmentionedGroups,
				checkedGroups: 0,
				unresolvedGroups,
				hasWildcardUnmentionedGroups,
				groups: [],
				elapsedMs: 0
			};
			return {
				...await auditTelegramGroupMembership({
					token: account.token,
					botId,
					groupIds,
					proxyUrl: account.config.proxy,
					network: account.config.network,
					timeoutMs
				}),
				unresolvedGroups,
				hasWildcardUnmentionedGroups
			};
		},
		buildAccountSnapshot: ({ account, cfg, runtime, probe, audit }) => {
			const configuredFromStatus = resolveConfiguredFromCredentialStatuses(account);
			const ownerAccountId = findTelegramTokenOwnerAccountId({
				cfg,
				accountId: account.accountId
			});
			const duplicateTokenReason = ownerAccountId ? formatDuplicateTelegramTokenReason({
				accountId: account.accountId,
				ownerAccountId
			}) : null;
			const configured = (configuredFromStatus ?? Boolean(account.token?.trim())) && !ownerAccountId;
			const groups = cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ?? cfg.channels?.telegram?.groups;
			const allowUnmentionedGroups = groups?.["*"]?.requireMention === false || Object.entries(groups ?? {}).some(([key, value]) => key !== "*" && value?.requireMention === false);
			return {
				accountId: account.accountId,
				name: account.name,
				enabled: account.enabled,
				configured,
				...projectCredentialSnapshotFields(account),
				running: runtime?.running ?? false,
				lastStartAt: runtime?.lastStartAt ?? null,
				lastStopAt: runtime?.lastStopAt ?? null,
				lastError: runtime?.lastError ?? duplicateTokenReason,
				mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
				probe,
				audit,
				allowUnmentionedGroups,
				lastInboundAt: runtime?.lastInboundAt ?? null,
				lastOutboundAt: runtime?.lastOutboundAt ?? null
			};
		}
	},
	gateway: {
		startAccount: async (ctx) => {
			const account = ctx.account;
			const ownerAccountId = findTelegramTokenOwnerAccountId({
				cfg: ctx.cfg,
				accountId: account.accountId
			});
			if (ownerAccountId) {
				const reason = formatDuplicateTelegramTokenReason({
					accountId: account.accountId,
					ownerAccountId
				});
				ctx.log?.error?.(`[${account.accountId}] ${reason}`);
				throw new Error(reason);
			}
			const token = (account.token ?? "").trim();
			let telegramBotLabel = "";
			try {
				const probe = await probeTelegram(token, 2500, {
					accountId: account.accountId,
					proxyUrl: account.config.proxy,
					network: account.config.network
				});
				const username = probe.ok ? probe.bot?.username?.trim() : null;
				if (username) telegramBotLabel = ` (@${username})`;
			} catch (err) {
				if (getTelegramRuntime().logging.shouldLogVerbose()) ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
			}
			ctx.log?.info(`[${account.accountId}] starting provider${telegramBotLabel}`);
			return monitorTelegramProvider({
				token,
				accountId: account.accountId,
				config: ctx.cfg,
				runtime: ctx.runtime,
				abortSignal: ctx.abortSignal,
				useWebhook: Boolean(account.config.webhookUrl),
				webhookUrl: account.config.webhookUrl,
				webhookSecret: account.config.webhookSecret,
				webhookPath: account.config.webhookPath,
				webhookHost: account.config.webhookHost,
				webhookPort: account.config.webhookPort,
				webhookCertPath: account.config.webhookCertPath
			});
		},
		logoutAccount: async ({ accountId, cfg }) => {
			const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
			const nextCfg = { ...cfg };
			const nextTelegram = cfg.channels?.telegram ? { ...cfg.channels.telegram } : void 0;
			let cleared = false;
			let changed = false;
			if (nextTelegram) {
				if (accountId === "default" && nextTelegram.botToken) {
					delete nextTelegram.botToken;
					cleared = true;
					changed = true;
				}
				const accountCleanup = clearAccountEntryFields({
					accounts: nextTelegram.accounts,
					accountId,
					fields: ["botToken"]
				});
				if (accountCleanup.changed) {
					changed = true;
					if (accountCleanup.cleared) cleared = true;
					if (accountCleanup.nextAccounts) nextTelegram.accounts = accountCleanup.nextAccounts;
					else delete nextTelegram.accounts;
				}
			}
			if (changed) if (nextTelegram && Object.keys(nextTelegram).length > 0) nextCfg.channels = {
				...nextCfg.channels,
				telegram: nextTelegram
			};
			else {
				const nextChannels = { ...nextCfg.channels };
				delete nextChannels.telegram;
				if (Object.keys(nextChannels).length > 0) nextCfg.channels = nextChannels;
				else delete nextCfg.channels;
			}
			const loggedOut = resolveTelegramAccount({
				cfg: changed ? nextCfg : cfg,
				accountId
			}).tokenSource === "none";
			if (changed) await getTelegramRuntime().config.writeConfigFile(nextCfg);
			return {
				cleared,
				envToken: Boolean(envToken),
				loggedOut
			};
		}
	}
};
//#endregion
//#region extensions/telegram/index.ts
const plugin = {
	id: "telegram",
	name: "Telegram",
	description: "Telegram channel plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setTelegramRuntime(api.runtime);
		api.registerChannel({ plugin: telegramPlugin });
	}
};
//#endregion
export { plugin as default };
