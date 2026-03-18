import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import "./theme-CL08MjAq.js";
import "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-BiUV1eIQ.js";
import "./links-DPi3kBux.js";
import { Gf as recordPendingHistoryEntryIfEnabled, Hf as buildPendingHistoryContextFromMap, Nf as createReplyPrefixOptions, Qn as resolveMentionGatingWithBypass, Uf as clearHistoryEntriesIfEnabled, bp as KeyedAsyncQueue, cf as createScopedPairingAccess, jf as createTypingCallbacks, of as issuePairingChallenge } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import { $t as resolveOpenProviderRuntimeGroupPolicy, Jt as resolveSenderScopedGroupPolicy, Qt as resolveDefaultGroupPolicy, Ut as evaluateGroupRouteAccessForPolicy, en as warnMissingProviderGroupPolicyFallbackOnce } from "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import { a as resolveDmGroupAccessWithLists, t as DM_GROUP_ACCESS_REASON } from "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import { _ as sendMediaWithLeadingCaption, b as resolveSenderCommandAuthorization, g as resolveOutboundMediaUrls } from "./compat-aC6dpiEb.js";
import "./inbound-envelope-aY_xfQcC.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-qouO4mvQ.js";
import "./device-pairing-D3SsXoQX.js";
import { i as mergeAllowlist, o as summarizeMapping } from "./resolve-utils-P7inlndK.js";
import "./json-bigint-D8mycCTK.js";
import "./safe-buffer-C7LiycEn.js";
import { A as getZalouserRuntime, C as listZaloGroups, D as startZaloListener, E as resolveZaloGroupContext, a as sendTypingZalouser, b as listZaloFriends, d as isZalouserGroupEntryAllowed, i as sendSeenZalouser, l as buildZalouserGroupCandidates, n as sendMessageZalouser, o as formatZalouserMessageSidFull, s as resolveZalouserMessageSid, t as sendDeliveredZalouser, u as findZalouserGroupEntry } from "./send-BuWJ270B.js";
import "./form_data-DbzDrG24.js";
//#region extensions/shared/deferred.ts
function createDeferred() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
}
//#endregion
//#region extensions/zalouser/src/monitor.ts
const ZALOUSER_TEXT_LIMIT = 2e3;
function normalizeZalouserEntry(entry) {
	return entry.replace(/^(zalouser|zlu):/i, "").trim();
}
function buildNameIndex(items, nameFn) {
	const index = /* @__PURE__ */ new Map();
	for (const item of items) {
		const name = nameFn(item)?.trim().toLowerCase();
		if (!name) continue;
		const list = index.get(name) ?? [];
		list.push(item);
		index.set(name, list);
	}
	return index;
}
function resolveUserAllowlistEntries(entries, byName) {
	const additions = [];
	const mapping = [];
	const unresolved = [];
	for (const entry of entries) {
		if (/^\d+$/.test(entry)) {
			additions.push(entry);
			continue;
		}
		const match = (byName.get(entry.toLowerCase()) ?? [])[0];
		const id = match?.userId ? String(match.userId) : void 0;
		if (id) {
			additions.push(id);
			mapping.push(`${entry}->${id}`);
		} else unresolved.push(entry);
	}
	return {
		additions,
		mapping,
		unresolved
	};
}
function resolveInboundQueueKey(message) {
	const threadId = message.threadId?.trim() || "unknown";
	if (message.isGroup) return `group:${threadId}`;
	return `direct:${message.senderId?.trim() || threadId}`;
}
function resolveZalouserDmSessionScope(config) {
	const configured = config.session?.dmScope;
	return configured === "main" || !configured ? "per-channel-peer" : configured;
}
function resolveZalouserInboundSessionKey(params) {
	if (params.isGroup) return params.route.sessionKey;
	const directSessionKey = params.core.channel.routing.buildAgentSessionKey({
		agentId: params.route.agentId,
		channel: "zalouser",
		accountId: params.route.accountId,
		peer: {
			kind: "direct",
			id: params.senderId
		},
		dmScope: resolveZalouserDmSessionScope(params.config),
		identityLinks: params.config.session?.identityLinks
	}).toLowerCase();
	const legacySessionKey = params.core.channel.routing.buildAgentSessionKey({
		agentId: params.route.agentId,
		channel: "zalouser",
		accountId: params.route.accountId,
		peer: {
			kind: "group",
			id: params.senderId
		}
	}).toLowerCase();
	const hasDirectSession = params.core.channel.session.readSessionUpdatedAt({
		storePath: params.storePath,
		sessionKey: directSessionKey
	}) !== void 0;
	return params.core.channel.session.readSessionUpdatedAt({
		storePath: params.storePath,
		sessionKey: legacySessionKey
	}) !== void 0 && !hasDirectSession ? legacySessionKey : directSessionKey;
}
function logVerbose(core, runtime, message) {
	if (core.logging.shouldLogVerbose()) runtime.log(`[zalouser] ${message}`);
}
function isSenderAllowed(senderId, allowFrom) {
	if (allowFrom.includes("*")) return true;
	const normalizedSenderId = senderId?.trim().toLowerCase();
	if (!normalizedSenderId) return false;
	return allowFrom.some((entry) => {
		return entry.toLowerCase().replace(/^(zalouser|zlu):/i, "") === normalizedSenderId;
	});
}
function resolveGroupRequireMention(params) {
	const entry = findZalouserGroupEntry(params.groups ?? {}, buildZalouserGroupCandidates({
		groupId: params.groupId,
		groupName: params.groupName,
		includeGroupIdAlias: true,
		includeWildcard: true,
		allowNameMatching: params.allowNameMatching
	}));
	if (typeof entry?.requireMention === "boolean") return entry.requireMention;
	return true;
}
async function sendZalouserDeliveryAcks(params) {
	await sendDeliveredZalouser({
		profile: params.profile,
		isGroup: params.isGroup,
		message: params.message,
		isSeen: true
	});
	await sendSeenZalouser({
		profile: params.profile,
		isGroup: params.isGroup,
		message: params.message
	});
}
async function processMessage(message, account, config, core, runtime, historyState, statusSink) {
	const pairing = createScopedPairingAccess({
		core,
		channel: "zalouser",
		accountId: account.accountId
	});
	const rawBody = message.content?.trim();
	if (!rawBody) return;
	const commandBody = message.commandContent?.trim() || rawBody;
	const isGroup = message.isGroup;
	const chatId = message.threadId;
	const senderId = message.senderId?.trim();
	if (!senderId) {
		logVerbose(core, runtime, `zalouser: drop message ${chatId} (missing senderId)`);
		return;
	}
	const senderName = message.senderName ?? "";
	const configuredGroupName = message.groupName?.trim() || "";
	const groupContext = isGroup && !configuredGroupName ? await resolveZaloGroupContext(account.profile, chatId).catch((err) => {
		logVerbose(core, runtime, `zalouser: group context lookup failed for ${chatId}: ${String(err)}`);
		return null;
	}) : null;
	const groupName = configuredGroupName || groupContext?.name?.trim() || "";
	const groupMembers = groupContext?.members?.slice(0, 20).join(", ") || void 0;
	if (message.eventMessage) try {
		await sendZalouserDeliveryAcks({
			profile: account.profile,
			isGroup,
			message: message.eventMessage
		});
	} catch (err) {
		logVerbose(core, runtime, `zalouser: delivery/seen ack failed for ${chatId}: ${String(err)}`);
	}
	const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
	const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: config.channels?.zalouser !== void 0,
		groupPolicy: account.config.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "zalouser",
		accountId: account.accountId,
		log: (entry) => logVerbose(core, runtime, entry)
	});
	const groups = account.config.groups ?? {};
	const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
	if (isGroup) {
		const groupEntry = findZalouserGroupEntry(groups, buildZalouserGroupCandidates({
			groupId: chatId,
			groupName,
			includeGroupIdAlias: true,
			includeWildcard: true,
			allowNameMatching
		}));
		const routeAccess = evaluateGroupRouteAccessForPolicy({
			groupPolicy,
			routeAllowlistConfigured: Object.keys(groups).length > 0,
			routeMatched: Boolean(groupEntry),
			routeEnabled: isZalouserGroupEntryAllowed(groupEntry)
		});
		if (!routeAccess.allowed) {
			if (routeAccess.reason === "disabled") logVerbose(core, runtime, `zalouser: drop group ${chatId} (groupPolicy=disabled)`);
			else if (routeAccess.reason === "empty_allowlist") logVerbose(core, runtime, `zalouser: drop group ${chatId} (groupPolicy=allowlist, no allowlist)`);
			else if (routeAccess.reason === "route_not_allowlisted") logVerbose(core, runtime, `zalouser: drop group ${chatId} (not allowlisted)`);
			else if (routeAccess.reason === "route_disabled") logVerbose(core, runtime, `zalouser: drop group ${chatId} (group disabled)`);
			return;
		}
	}
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
	const configGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((v) => String(v));
	const senderGroupPolicy = resolveSenderScopedGroupPolicy({
		groupPolicy,
		groupAllowFrom: configGroupAllowFrom
	});
	const shouldComputeCommandAuth = core.channel.commands.shouldComputeCommandAuthorized(commandBody, config);
	const storeAllowFrom = !isGroup && dmPolicy !== "allowlist" && (dmPolicy !== "open" || shouldComputeCommandAuth) ? await pairing.readAllowFromStore().catch(() => []) : [];
	const accessDecision = resolveDmGroupAccessWithLists({
		isGroup,
		dmPolicy,
		groupPolicy: senderGroupPolicy,
		allowFrom: configAllowFrom,
		groupAllowFrom: configGroupAllowFrom,
		storeAllowFrom,
		groupAllowFromFallbackToAllowFrom: false,
		isSenderAllowed: (allowFrom) => isSenderAllowed(senderId, allowFrom)
	});
	if (isGroup && accessDecision.decision !== "allow") {
		if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) logVerbose(core, runtime, "Blocked zalouser group message (no group allowlist)");
		else if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) logVerbose(core, runtime, `Blocked zalouser sender ${senderId} (not in groupAllowFrom/allowFrom)`);
		return;
	}
	if (!isGroup && accessDecision.decision !== "allow") {
		if (accessDecision.decision === "pairing") {
			await issuePairingChallenge({
				channel: "zalouser",
				senderId,
				senderIdLine: `Your Zalo user id: ${senderId}`,
				meta: { name: senderName || void 0 },
				upsertPairingRequest: pairing.upsertPairingRequest,
				onCreated: () => {
					logVerbose(core, runtime, `zalouser pairing request sender=${senderId}`);
				},
				sendPairingReply: async (text) => {
					await sendMessageZalouser(chatId, text, { profile: account.profile });
					statusSink?.({ lastOutboundAt: Date.now() });
				},
				onReplyError: (err) => {
					logVerbose(core, runtime, `zalouser pairing reply failed for ${senderId}: ${String(err)}`);
				}
			});
			return;
		}
		if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) logVerbose(core, runtime, `Blocked zalouser DM from ${senderId} (dmPolicy=disabled)`);
		else logVerbose(core, runtime, `Blocked unauthorized zalouser sender ${senderId} (dmPolicy=${dmPolicy})`);
		return;
	}
	const { commandAuthorized } = await resolveSenderCommandAuthorization({
		cfg: config,
		rawBody: commandBody,
		isGroup,
		dmPolicy,
		configuredAllowFrom: configAllowFrom,
		configuredGroupAllowFrom: configGroupAllowFrom,
		senderId,
		isSenderAllowed,
		readAllowFromStore: async () => storeAllowFrom,
		shouldComputeCommandAuthorized: (body, cfg) => core.channel.commands.shouldComputeCommandAuthorized(body, cfg),
		resolveCommandAuthorizedFromAuthorizers: (params) => core.channel.commands.resolveCommandAuthorizedFromAuthorizers(params)
	});
	const hasControlCommand = core.channel.commands.isControlCommandMessage(commandBody, config);
	if (isGroup && hasControlCommand && commandAuthorized !== true) {
		logVerbose(core, runtime, `zalouser: drop control command from unauthorized sender ${senderId}`);
		return;
	}
	const peer = isGroup ? {
		kind: "group",
		id: chatId
	} : {
		kind: "direct",
		id: senderId
	};
	const route = core.channel.routing.resolveAgentRoute({
		cfg: config,
		channel: "zalouser",
		accountId: account.accountId,
		peer: {
			kind: peer.kind,
			id: peer.id
		}
	});
	const historyKey = isGroup ? route.sessionKey : void 0;
	const requireMention = isGroup ? resolveGroupRequireMention({
		groupId: chatId,
		groupName,
		groups,
		allowNameMatching
	}) : false;
	const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
	const explicitMention = {
		hasAnyMention: message.hasAnyMention === true,
		isExplicitlyMentioned: message.wasExplicitlyMentioned === true,
		canResolveExplicit: message.canResolveExplicitMention === true
	};
	const wasMentioned = isGroup ? core.channel.mentions.matchesMentionWithExplicit({
		text: rawBody,
		mentionRegexes,
		explicit: explicitMention
	}) : true;
	const canDetectMention = mentionRegexes.length > 0 || explicitMention.canResolveExplicit;
	const mentionGate = resolveMentionGatingWithBypass({
		isGroup,
		requireMention,
		canDetectMention,
		wasMentioned,
		implicitMention: message.implicitMention === true,
		hasAnyMention: explicitMention.hasAnyMention,
		allowTextCommands: core.channel.commands.shouldHandleTextCommands({
			cfg: config,
			surface: "zalouser"
		}),
		hasControlCommand,
		commandAuthorized: commandAuthorized === true
	});
	if (isGroup && requireMention && !canDetectMention && !mentionGate.effectiveWasMentioned) {
		runtime.error?.(`[${account.accountId}] zalouser mention required but detection unavailable (missing mention regexes and bot self id); dropping group ${chatId}`);
		return;
	}
	if (isGroup && mentionGate.shouldSkip) {
		recordPendingHistoryEntryIfEnabled({
			historyMap: historyState.groupHistories,
			historyKey: historyKey ?? "",
			limit: historyState.historyLimit,
			entry: historyKey && rawBody ? {
				sender: senderName || senderId,
				body: rawBody,
				timestamp: message.timestampMs,
				messageId: resolveZalouserMessageSid({
					msgId: message.msgId,
					cliMsgId: message.cliMsgId,
					fallback: `${message.timestampMs}`
				})
			} : null
		});
		logVerbose(core, runtime, `zalouser: skip group ${chatId} (mention required, not mentioned)`);
		return;
	}
	const fromLabel = isGroup ? groupName || `group:${chatId}` : senderName || `user:${senderId}`;
	const storePath = core.channel.session.resolveStorePath(config.session?.store, { agentId: route.agentId });
	const inboundSessionKey = resolveZalouserInboundSessionKey({
		core,
		config,
		route,
		storePath,
		isGroup,
		senderId
	});
	const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
	const previousTimestamp = core.channel.session.readSessionUpdatedAt({
		storePath,
		sessionKey: inboundSessionKey
	});
	const body = core.channel.reply.formatAgentEnvelope({
		channel: "Zalo Personal",
		from: fromLabel,
		timestamp: message.timestampMs,
		previousTimestamp,
		envelope: envelopeOptions,
		body: rawBody
	});
	const combinedBody = isGroup && historyKey ? buildPendingHistoryContextFromMap({
		historyMap: historyState.groupHistories,
		historyKey,
		limit: historyState.historyLimit,
		currentMessage: body,
		formatEntry: (entry) => core.channel.reply.formatAgentEnvelope({
			channel: "Zalo Personal",
			from: fromLabel,
			timestamp: entry.timestamp,
			envelope: envelopeOptions,
			body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`
		})
	}) : body;
	const inboundHistory = isGroup && historyKey && historyState.historyLimit > 0 ? (historyState.groupHistories.get(historyKey) ?? []).map((entry) => ({
		sender: entry.sender,
		body: entry.body,
		timestamp: entry.timestamp
	})) : void 0;
	const normalizedTo = isGroup ? `zalouser:group:${chatId}` : `zalouser:${chatId}`;
	const ctxPayload = core.channel.reply.finalizeInboundContext({
		Body: combinedBody,
		BodyForAgent: rawBody,
		InboundHistory: inboundHistory,
		RawBody: rawBody,
		CommandBody: commandBody,
		BodyForCommands: commandBody,
		From: isGroup ? `zalouser:group:${chatId}` : `zalouser:${senderId}`,
		To: normalizedTo,
		SessionKey: inboundSessionKey,
		AccountId: route.accountId,
		ChatType: isGroup ? "group" : "direct",
		ConversationLabel: fromLabel,
		GroupSubject: isGroup ? groupName || void 0 : void 0,
		GroupChannel: isGroup ? groupName || void 0 : void 0,
		GroupMembers: isGroup ? groupMembers : void 0,
		SenderName: senderName || void 0,
		SenderId: senderId,
		WasMentioned: isGroup ? mentionGate.effectiveWasMentioned : void 0,
		CommandAuthorized: commandAuthorized,
		Provider: "zalouser",
		Surface: "zalouser",
		MessageSid: resolveZalouserMessageSid({
			msgId: message.msgId,
			cliMsgId: message.cliMsgId,
			fallback: `${message.timestampMs}`
		}),
		MessageSidFull: formatZalouserMessageSidFull({
			msgId: message.msgId,
			cliMsgId: message.cliMsgId
		}),
		OriginatingChannel: "zalouser",
		OriginatingTo: normalizedTo
	});
	await core.channel.session.recordInboundSession({
		storePath,
		sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
		ctx: ctxPayload,
		onRecordError: (err) => {
			runtime.error?.(`zalouser: failed updating session meta: ${String(err)}`);
		}
	});
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg: config,
		agentId: route.agentId,
		channel: "zalouser",
		accountId: account.accountId
	});
	const typingCallbacks = createTypingCallbacks({
		start: async () => {
			await sendTypingZalouser(chatId, {
				profile: account.profile,
				isGroup
			});
		},
		onStartError: (err) => {
			runtime.error?.(`[${account.accountId}] zalouser typing start failed for ${chatId}: ${String(err)}`);
			logVerbose(core, runtime, `zalouser typing failed for ${chatId}: ${String(err)}`);
		}
	});
	await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
		ctx: ctxPayload,
		cfg: config,
		dispatcherOptions: {
			...prefixOptions,
			typingCallbacks,
			deliver: async (payload) => {
				await deliverZalouserReply({
					payload,
					profile: account.profile,
					chatId,
					isGroup,
					runtime,
					core,
					config,
					accountId: account.accountId,
					statusSink,
					tableMode: core.channel.text.resolveMarkdownTableMode({
						cfg: config,
						channel: "zalouser",
						accountId: account.accountId
					})
				});
			},
			onError: (err, info) => {
				runtime.error(`[${account.accountId}] Zalouser ${info.kind} reply failed: ${String(err)}`);
			}
		},
		replyOptions: { onModelSelected }
	});
	if (isGroup && historyKey) clearHistoryEntriesIfEnabled({
		historyMap: historyState.groupHistories,
		historyKey,
		limit: historyState.historyLimit
	});
}
async function deliverZalouserReply(params) {
	const { payload, profile, chatId, isGroup, runtime, core, config, accountId, statusSink } = params;
	const tableMode = params.tableMode ?? "code";
	const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
	const chunkMode = core.channel.text.resolveChunkMode(config, "zalouser", accountId);
	const textChunkLimit = core.channel.text.resolveTextChunkLimit(config, "zalouser", accountId, { fallbackLimit: ZALOUSER_TEXT_LIMIT });
	if (await sendMediaWithLeadingCaption({
		mediaUrls: resolveOutboundMediaUrls(payload),
		caption: text,
		send: async ({ mediaUrl, caption }) => {
			logVerbose(core, runtime, `Sending media to ${chatId}`);
			await sendMessageZalouser(chatId, caption ?? "", {
				profile,
				mediaUrl,
				isGroup,
				textMode: "markdown",
				textChunkMode: chunkMode,
				textChunkLimit
			});
			statusSink?.({ lastOutboundAt: Date.now() });
		},
		onError: (error) => {
			runtime.error(`Zalouser media send failed: ${String(error)}`);
		}
	})) return;
	if (text) try {
		await sendMessageZalouser(chatId, text, {
			profile,
			isGroup,
			textMode: "markdown",
			textChunkMode: chunkMode,
			textChunkLimit
		});
		statusSink?.({ lastOutboundAt: Date.now() });
	} catch (err) {
		runtime.error(`Zalouser message send failed: ${String(err)}`);
	}
}
async function monitorZalouserProvider(options) {
	let { account, config } = options;
	const { abortSignal, statusSink, runtime } = options;
	const core = getZalouserRuntime();
	const inboundQueue = new KeyedAsyncQueue();
	const historyLimit = Math.max(0, account.config.historyLimit ?? config.messages?.groupChat?.historyLimit ?? 50);
	const groupHistories = /* @__PURE__ */ new Map();
	try {
		const profile = account.profile;
		const allowFromEntries = (account.config.allowFrom ?? []).map((entry) => normalizeZalouserEntry(String(entry))).filter((entry) => entry && entry !== "*");
		const groupAllowFromEntries = (account.config.groupAllowFrom ?? []).map((entry) => normalizeZalouserEntry(String(entry))).filter((entry) => entry && entry !== "*");
		if (allowFromEntries.length > 0 || groupAllowFromEntries.length > 0) {
			const byName = buildNameIndex(await listZaloFriends(profile), (friend) => friend.displayName);
			if (allowFromEntries.length > 0) {
				const { additions, mapping, unresolved } = resolveUserAllowlistEntries(allowFromEntries, byName);
				const allowFrom = mergeAllowlist({
					existing: account.config.allowFrom,
					additions
				});
				account = {
					...account,
					config: {
						...account.config,
						allowFrom
					}
				};
				summarizeMapping("zalouser users", mapping, unresolved, runtime);
			}
			if (groupAllowFromEntries.length > 0) {
				const { additions, mapping, unresolved } = resolveUserAllowlistEntries(groupAllowFromEntries, byName);
				const groupAllowFrom = mergeAllowlist({
					existing: account.config.groupAllowFrom,
					additions
				});
				account = {
					...account,
					config: {
						...account.config,
						groupAllowFrom
					}
				};
				summarizeMapping("zalouser group users", mapping, unresolved, runtime);
			}
		}
		const groupsConfig = account.config.groups ?? {};
		const groupKeys = Object.keys(groupsConfig).filter((key) => key !== "*");
		if (groupKeys.length > 0) {
			const byName = buildNameIndex(await listZaloGroups(profile), (group) => group.name);
			const mapping = [];
			const unresolved = [];
			const nextGroups = { ...groupsConfig };
			for (const entry of groupKeys) {
				const cleaned = normalizeZalouserEntry(entry);
				if (/^\d+$/.test(cleaned)) {
					if (!nextGroups[cleaned]) nextGroups[cleaned] = groupsConfig[entry];
					mapping.push(`${entry}→${cleaned}`);
					continue;
				}
				const match = (byName.get(cleaned.toLowerCase()) ?? [])[0];
				const id = match?.groupId ? String(match.groupId) : void 0;
				if (id) {
					if (!nextGroups[id]) nextGroups[id] = groupsConfig[entry];
					mapping.push(`${entry}→${id}`);
				} else unresolved.push(entry);
			}
			account = {
				...account,
				config: {
					...account.config,
					groups: nextGroups
				}
			};
			summarizeMapping("zalouser groups", mapping, unresolved, runtime);
		}
	} catch (err) {
		runtime.log?.(`zalouser resolve failed; using config entries. ${String(err)}`);
	}
	let listenerStop = null;
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		listenerStop?.();
		listenerStop = null;
	};
	let settled = false;
	const { promise: waitForExit, resolve: resolveRun, reject: rejectRun } = createDeferred();
	const settleSuccess = () => {
		if (settled) return;
		settled = true;
		stop();
		resolveRun();
	};
	const settleFailure = (error) => {
		if (settled) return;
		settled = true;
		stop();
		rejectRun(error instanceof Error ? error : new Error(String(error)));
	};
	const onAbort = () => {
		settleSuccess();
	};
	abortSignal.addEventListener("abort", onAbort, { once: true });
	let listener;
	try {
		listener = await startZaloListener({
			accountId: account.accountId,
			profile: account.profile,
			abortSignal,
			onMessage: (msg) => {
				if (stopped) return;
				logVerbose(core, runtime, `[${account.accountId}] inbound message`);
				statusSink?.({ lastInboundAt: Date.now() });
				const queueKey = resolveInboundQueueKey(msg);
				inboundQueue.enqueue(queueKey, async () => {
					if (stopped || abortSignal.aborted) return;
					await processMessage(msg, account, config, core, runtime, {
						historyLimit,
						groupHistories
					}, statusSink);
				}).catch((err) => {
					runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
				});
			},
			onError: (err) => {
				if (stopped || abortSignal.aborted) return;
				runtime.error(`[${account.accountId}] Zalo listener error: ${String(err)}`);
				settleFailure(err);
			}
		});
	} catch (error) {
		abortSignal.removeEventListener("abort", onAbort);
		throw error;
	}
	listenerStop = listener.stop;
	if (stopped) {
		listenerStop();
		listenerStop = null;
	}
	if (abortSignal.aborted) settleSuccess();
	try {
		await waitForExit;
	} finally {
		abortSignal.removeEventListener("abort", onAbort);
	}
	return { stop };
}
//#endregion
export { monitorZalouserProvider };
