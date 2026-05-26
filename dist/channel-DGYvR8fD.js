import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { l as normalizeMessagePresentation } from "./payload-BDV15CYA.js";
import { i as createLazyRuntimeNamedExport } from "./lazy-runtime-D-7_JraP.js";
import { u as createTopLevelChannelConfigAdapter } from "./channel-config-helpers-xZ4-bv2H.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as describeAccountSnapshot } from "./account-helpers-BEXOONiv.js";
import { d as stripTargetKindPrefix, i as createChatChannelPlugin, t as buildChannelOutboundSessionRoute, u as stripChannelTargetPrefix } from "./core-kXuNbs5U.js";
import "./channel-core-CV-k5W6W.js";
import { t as formatAllowFromLowercase } from "./allow-from-CvE3rvhy.js";
import { D as projectConfigWarningCollector, g as createAllowlistProviderGroupPolicyWarningCollector, n as createDangerousNameMatchingMutableAllowlistWarningCollector } from "./channel-policy-pv8ZpZxj.js";
import { t as createChannelDirectoryAdapter } from "./directory-runtime-wFQhDUBI.js";
import { a as listDirectoryEntriesFromSources } from "./directory-config-helpers-DoW5C2Kp.js";
import { n as createRuntimeOutboundDelegates, t as createRuntimeDirectoryLiveAdapter } from "./runtime-forwarders-CJHIfxll.js";
import { t as resolveApprovalApprovers } from "./approval-approvers-BaAy3FfF.js";
import { t as createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers-dxinAe5Y.js";
import "./outbound-runtime-CGgaScW3.js";
import { t as chunkTextForOutbound } from "./text-chunking-C154U6-i.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./pairing-message-C9w9gv4K.js";
import { d as createDefaultChannelRuntimeState, i as buildProbeChannelStatusSummary, u as createComputedAccountStatusAdapter } from "./status-helpers-CnvYAK73.js";
import { k as createChannelMessageAdapterFromOutbound } from "./channel-message-DMGbyII_.js";
import { i as createPairingPrefixStripper } from "./channel-pairing-N4dBc-K-.js";
import "./runtime-api-DN6i5eom.js";
import { h as resolveMSTeamsCredentials } from "./graph-users-_25MXF-j.js";
import { a as parseMSTeamsTeamChannelInput, c as resolveMSTeamsUserAllowlist, i as parseMSTeamsConversationId, n as normalizeMSTeamsMessagingTarget, r as normalizeMSTeamsUserInput, s as resolveMSTeamsChannelAllowlist, t as looksLikeMSTeamsTargetId } from "./resolve-allowlist-RCWaHejE.js";
import { t as MSTeamsChannelConfigSchema } from "./config-schema-CyQz82zA.js";
import { n as resolveMSTeamsGroupToolPolicy } from "./policy-B0_tmat6.js";
import { n as buildMSTeamsPresentationCard, t as MSTEAMS_PRESENTATION_CAPABILITIES } from "./presentation-BkGTmNW7.js";
import { i as msteamsSetupAdapter, t as msteamsSetupWizard } from "./setup-surface-DXnHSLfW.js";
import { Type } from "typebox";
//#region extensions/msteams/src/approval-auth.ts
const MSTEAMS_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeMSTeamsApproverId(value) {
	const normalized = normalizeMSTeamsMessagingTarget(String(value));
	if (!normalized?.startsWith("user:")) return;
	const id = normalizeOptionalLowercaseString(normalized.slice(5));
	if (!id) return;
	return MSTEAMS_ID_RE.test(id) ? id : void 0;
}
function resolveMSTeamsChannelConfig$1(cfg) {
	return cfg.channels?.msteams;
}
const msTeamsApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "Microsoft Teams",
	resolveApprovers: ({ cfg }) => {
		const channel = resolveMSTeamsChannelConfig$1(cfg);
		return resolveApprovalApprovers({
			allowFrom: channel?.allowFrom,
			defaultTo: channel?.defaultTo,
			normalizeApprover: normalizeMSTeamsApproverId
		});
	},
	normalizeSenderId: (value) => {
		const trimmed = normalizeOptionalLowercaseString(value);
		if (!trimmed) return;
		return MSTEAMS_ID_RE.test(trimmed) ? trimmed : void 0;
	}
});
//#endregion
//#region extensions/msteams/src/doctor.ts
function isMSTeamsMutableAllowEntry(raw) {
	const text = raw.trim();
	if (!text || text === "*") return false;
	const withoutPrefix = text.replace(/^(msteams|user):/i, "").trim();
	return /\s/.test(withoutPrefix) || withoutPrefix.includes("@");
}
const collectMSTeamsMutableAllowlistWarnings = createDangerousNameMatchingMutableAllowlistWarningCollector({
	channel: "msteams",
	detector: isMSTeamsMutableAllowEntry,
	collectLists: (scope) => [{
		pathLabel: `${scope.prefix}.allowFrom`,
		list: scope.account.allowFrom
	}, {
		pathLabel: `${scope.prefix}.groupAllowFrom`,
		list: scope.account.groupAllowFrom
	}]
});
//#endregion
//#region extensions/msteams/src/session-route.ts
function resolveMSTeamsOutboundSessionRoute(params) {
	let trimmed = stripChannelTargetPrefix(params.target, "msteams", "teams");
	if (!trimmed) return null;
	const isUser = normalizeLowercaseStringOrEmpty(trimmed).startsWith("user:");
	const rawId = stripTargetKindPrefix(trimmed);
	if (!rawId) return null;
	const conversationId = rawId.split(";")[0] ?? rawId;
	const isChannel = !isUser && /@thread\.tacv2/i.test(conversationId);
	return buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "msteams",
		accountId: params.accountId,
		peer: {
			kind: isUser ? "direct" : isChannel ? "channel" : "group",
			id: conversationId
		},
		chatType: isUser ? "direct" : isChannel ? "channel" : "group",
		from: isUser ? `msteams:${conversationId}` : isChannel ? `msteams:channel:${conversationId}` : `msteams:group:${conversationId}`,
		to: isUser ? `user:${conversationId}` : `conversation:${conversationId}`
	});
}
//#endregion
//#region extensions/msteams/src/channel.ts
const meta = {
	id: "msteams",
	label: "Microsoft Teams",
	selectionLabel: "Microsoft Teams (Bot Framework)",
	docsPath: "/channels/msteams",
	docsLabel: "msteams",
	blurb: "Teams SDK; enterprise support.",
	aliases: ["teams"],
	order: 60
};
const TEAMS_GRAPH_PERMISSION_HINTS = {
	"ChannelMessage.Read.All": "channel history",
	"Chat.Read.All": "chat history",
	"Channel.ReadBasic.All": "channel list",
	"Team.ReadBasic.All": "team list",
	"TeamsActivity.Read.All": "teams activity",
	"Sites.Read.All": "files (SharePoint)",
	"Files.Read.All": "files (OneDrive)"
};
const collectMSTeamsSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector({
	providerConfigPresent: (cfg) => cfg.channels?.msteams !== void 0,
	resolveGroupPolicy: ({ cfg }) => cfg.channels?.msteams?.groupPolicy,
	collect: ({ groupPolicy }) => groupPolicy === "open" ? ["- MS Teams groups: groupPolicy=\"open\" allows any member to trigger (mention-gated). Set channels.msteams.groupPolicy=\"allowlist\" + channels.msteams.groupAllowFrom to restrict senders."] : []
});
const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(() => import("./channel.runtime-DhDlIoi-.js"), "msTeamsChannelRuntime");
const resolveMSTeamsChannelConfig = (cfg) => ({
	allowFrom: cfg.channels?.msteams?.allowFrom,
	defaultTo: cfg.channels?.msteams?.defaultTo
});
const msteamsConfigAdapter = createTopLevelChannelConfigAdapter({
	sectionKey: "msteams",
	resolveAccount: (cfg) => ({
		accountId: DEFAULT_ACCOUNT_ID,
		enabled: cfg.channels?.msteams?.enabled !== false,
		configured: Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams))
	}),
	resolveAccessorAccount: ({ cfg }) => resolveMSTeamsChannelConfig(cfg),
	resolveAllowFrom: (account) => account.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
	resolveDefaultTo: (account) => account.defaultTo
});
function jsonActionResult(data) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(data)
		}],
		details: data
	};
}
function jsonMSTeamsActionResult(action, data = {}) {
	return jsonActionResult({
		channel: "msteams",
		action,
		...data
	});
}
function jsonMSTeamsOkActionResult(action, data = {}) {
	return jsonActionResult({
		ok: true,
		channel: "msteams",
		action,
		...data
	});
}
function jsonMSTeamsConversationResult(conversationId) {
	return jsonActionResultWithDetails({
		ok: true,
		channel: "msteams",
		conversationId
	}, {
		ok: true,
		channel: "msteams"
	});
}
function jsonActionResultWithDetails(contentData, details) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(contentData)
		}],
		details
	};
}
const MSTEAMS_REACTION_TYPES = [
	"like",
	"heart",
	"laugh",
	"surprised",
	"sad",
	"angry"
];
function actionError(message) {
	return {
		isError: true,
		content: [{
			type: "text",
			text: message
		}],
		details: { error: message }
	};
}
function resolveActionTarget(params, currentChannelId) {
	return typeof params.to === "string" ? params.to.trim() : typeof params.target === "string" ? params.target.trim() : currentChannelId?.trim() ?? "";
}
function resolveGraphActionTarget(params, currentChannelId, currentGraphChannelId) {
	return resolveActionTarget(params, currentGraphChannelId ?? currentChannelId);
}
function resolveActionMessageId(params) {
	return normalizeOptionalString(params.messageId) ?? "";
}
function resolveActionPinnedMessageId(params) {
	return typeof params.pinnedMessageId === "string" ? params.pinnedMessageId.trim() : typeof params.messageId === "string" ? params.messageId.trim() : "";
}
function resolveActionQuery(params) {
	return normalizeOptionalString(params.query) ?? "";
}
function resolveActionContent(params) {
	return typeof params.text === "string" ? params.text : typeof params.content === "string" ? params.content : typeof params.message === "string" ? params.message : "";
}
function readOptionalTrimmedString(params, key) {
	return typeof params[key] === "string" ? params[key].trim() || void 0 : void 0;
}
function resolveActionUploadFilePath(params) {
	for (const key of [
		"filePath",
		"path",
		"media"
	]) if (typeof params[key] === "string") {
		const value = params[key];
		if (value.trim()) return value;
	}
}
function resolveRequiredActionTarget(params) {
	const to = params.graphOnly ? resolveGraphActionTarget(params.toolParams, params.currentChannelId, params.currentGraphChannelId) : resolveActionTarget(params.toolParams, params.currentChannelId);
	if (!to) return actionError(`${params.actionLabel} requires a target (to).`);
	return to;
}
function resolveRequiredActionMessageTarget(params) {
	const to = params.graphOnly ? resolveGraphActionTarget(params.toolParams, params.currentChannelId, params.currentGraphChannelId) : resolveActionTarget(params.toolParams, params.currentChannelId);
	const messageId = resolveActionMessageId(params.toolParams);
	if (!to || !messageId) return actionError(`${params.actionLabel} requires a target (to) and messageId.`);
	return {
		to,
		messageId
	};
}
function resolveRequiredActionPinnedMessageTarget(params) {
	const to = params.graphOnly ? resolveGraphActionTarget(params.toolParams, params.currentChannelId, params.currentGraphChannelId) : resolveActionTarget(params.toolParams, params.currentChannelId);
	const pinnedMessageId = resolveActionPinnedMessageId(params.toolParams);
	if (!to || !pinnedMessageId) return actionError(`${params.actionLabel} requires a target (to) and pinnedMessageId.`);
	return {
		to,
		pinnedMessageId
	};
}
async function runWithRequiredActionTarget(params) {
	const to = resolveRequiredActionTarget({
		actionLabel: params.actionLabel,
		toolParams: params.toolParams,
		currentChannelId: params.currentChannelId,
		currentGraphChannelId: params.currentGraphChannelId,
		graphOnly: params.graphOnly
	});
	if (typeof to !== "string") return to;
	return await params.run(to);
}
async function runWithRequiredActionMessageTarget(params) {
	const target = resolveRequiredActionMessageTarget({
		actionLabel: params.actionLabel,
		toolParams: params.toolParams,
		currentChannelId: params.currentChannelId,
		currentGraphChannelId: params.currentGraphChannelId,
		graphOnly: params.graphOnly
	});
	if ("isError" in target) return target;
	return await params.run(target);
}
async function runWithRequiredActionPinnedMessageTarget(params) {
	const target = resolveRequiredActionPinnedMessageTarget({
		actionLabel: params.actionLabel,
		toolParams: params.toolParams,
		currentChannelId: params.currentChannelId,
		currentGraphChannelId: params.currentGraphChannelId,
		graphOnly: params.graphOnly
	});
	if ("isError" in target) return target;
	return await params.run(target);
}
function describeMSTeamsMessageTool({ cfg }) {
	const enabled = cfg.channels?.msteams?.enabled !== false && Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams));
	return {
		actions: enabled ? [
			"upload-file",
			"poll",
			"edit",
			"delete",
			"pin",
			"unpin",
			"list-pins",
			"read",
			"react",
			"reactions",
			"search",
			"member-info",
			"channel-list",
			"channel-info",
			"addParticipant",
			"removeParticipant",
			"renameGroup"
		] : [],
		capabilities: enabled ? ["presentation"] : [],
		schema: enabled ? {
			actions: ["unpin"],
			properties: { pinnedMessageId: Type.Optional(Type.String({ description: "Pinned message resource ID for unpin (from pin or list-pins, not the chat message ID)." })) }
		} : null
	};
}
const msteamsChannelOutbound = {
	deliveryMode: "direct",
	chunker: chunkTextForOutbound,
	chunkerMode: "markdown",
	textChunkLimit: 4e3,
	pollMaxOptions: 12,
	deliveryCapabilities: { durableFinal: {
		text: true,
		media: true,
		payload: true,
		messageSendingHooks: true
	} },
	presentationCapabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
	...createRuntimeOutboundDelegates({
		getRuntime: loadMSTeamsChannelRuntime,
		renderPresentation: { resolve: (runtime) => runtime.msteamsOutbound.renderPresentation },
		sendPayload: { resolve: (runtime) => runtime.msteamsOutbound.sendPayload },
		sendText: { resolve: (runtime) => runtime.msteamsOutbound.sendText },
		sendMedia: { resolve: (runtime) => runtime.msteamsOutbound.sendMedia },
		sendPoll: { resolve: (runtime) => runtime.msteamsOutbound.sendPoll }
	})
};
const msteamsMessageAdapter = createChannelMessageAdapterFromOutbound({
	id: "msteams",
	outbound: msteamsChannelOutbound,
	live: {
		capabilities: {
			draftPreview: true,
			previewFinalization: true,
			progressUpdates: true,
			nativeStreaming: true
		},
		finalizer: { capabilities: {
			finalEdit: true,
			normalFallback: true,
			previewReceipt: true
		} }
	}
});
const msteamsPlugin = createChatChannelPlugin({
	base: {
		id: "msteams",
		meta: {
			...meta,
			aliases: [...meta.aliases]
		},
		setupWizard: msteamsSetupWizard,
		capabilities: {
			chatTypes: [
				"direct",
				"channel",
				"thread"
			],
			polls: true,
			threads: true,
			media: true
		},
		streaming: { blockStreamingCoalesceDefaults: {
			minChars: 1500,
			idleMs: 1e3
		} },
		agentPrompt: { messageToolHints: () => ["- Adaptive Cards supported. Use `action=send` with `card={type,version,body}` to send rich cards.", "- MSTeams targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:ID` or `user:Display Name` (requires Graph API) for DMs, `conversation:19:...@thread.tacv2` for groups/channels. Prefer IDs over display names for speed."] },
		groups: { resolveToolPolicy: resolveMSTeamsGroupToolPolicy },
		reload: { configPrefixes: ["channels.msteams"] },
		configSchema: MSTeamsChannelConfigSchema,
		config: {
			...msteamsConfigAdapter,
			isConfigured: (_account, cfg) => Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
			describeAccount: (account) => describeAccountSnapshot({
				account,
				configured: account.configured
			})
		},
		approvalCapability: msTeamsApprovalAuth,
		doctor: {
			dmAllowFromMode: "topOnly",
			groupModel: "hybrid",
			groupAllowFromFallbackToAllowFrom: true,
			warnOnEmptyGroupSenderAllowlist: true,
			collectMutableAllowlistWarnings: collectMSTeamsMutableAllowlistWarnings
		},
		setup: msteamsSetupAdapter,
		messaging: {
			targetPrefixes: ["msteams", "teams"],
			normalizeTarget: normalizeMSTeamsMessagingTarget,
			resolveOutboundSessionRoute: (params) => resolveMSTeamsOutboundSessionRoute(params),
			targetResolver: {
				looksLikeId: (raw) => looksLikeMSTeamsTargetId(raw),
				hint: "<conversationId|user:ID|conversation:ID>"
			}
		},
		message: msteamsMessageAdapter,
		directory: createChannelDirectoryAdapter({
			self: async ({ cfg }) => {
				const creds = resolveMSTeamsCredentials(cfg.channels?.msteams);
				if (!creds) return null;
				return {
					kind: "user",
					id: creds.appId,
					name: creds.appId
				};
			},
			listPeers: async ({ cfg, query, limit }) => listDirectoryEntriesFromSources({
				kind: "user",
				sources: [cfg.channels?.msteams?.allowFrom ?? [], Object.keys(cfg.channels?.msteams?.dms ?? {})],
				query,
				limit,
				normalizeId: (raw) => {
					const normalized = normalizeMSTeamsMessagingTarget(raw) ?? raw;
					const lowered = normalized.toLowerCase();
					if (lowered.startsWith("user:") || lowered.startsWith("conversation:")) return normalized;
					return `user:${normalized}`;
				}
			}),
			listGroups: async ({ cfg, query, limit }) => listDirectoryEntriesFromSources({
				kind: "group",
				sources: [Object.values(cfg.channels?.msteams?.teams ?? {}).flatMap((team) => Object.keys(team.channels ?? {}))],
				query,
				limit,
				normalizeId: (raw) => `conversation:${raw.replace(/^conversation:/i, "").trim()}`
			}),
			...createRuntimeDirectoryLiveAdapter({
				getRuntime: loadMSTeamsChannelRuntime,
				listPeersLive: (runtime) => runtime.listMSTeamsDirectoryPeersLive,
				listGroupsLive: (runtime) => runtime.listMSTeamsDirectoryGroupsLive
			})
		}),
		resolver: { resolveTargets: async ({ cfg, inputs, kind, runtime }) => {
			const results = inputs.map((input) => ({
				input,
				resolved: false,
				id: void 0,
				name: void 0,
				note: void 0
			}));
			const stripPrefix = (value) => normalizeMSTeamsUserInput(value);
			const markPendingLookupFailed = (pending) => {
				pending.forEach(({ index }) => {
					const entry = results[index];
					if (entry) entry.note = "lookup failed";
				});
			};
			const resolvePending = async (pending, resolveEntries, applyResolvedEntry) => {
				if (pending.length === 0) return;
				try {
					(await resolveEntries(pending.map((entry) => entry.query))).forEach((entry, idx) => {
						const target = results[pending[idx]?.index ?? -1];
						if (!target) return;
						applyResolvedEntry(target, entry);
					});
				} catch (err) {
					runtime.error?.(`msteams resolve failed: ${String(err)}`);
					markPendingLookupFailed(pending);
				}
			};
			if (kind === "user") {
				const pending = [];
				results.forEach((entry, index) => {
					const trimmed = entry.input.trim();
					if (!trimmed) {
						entry.note = "empty input";
						return;
					}
					const cleaned = stripPrefix(trimmed);
					if (/^[0-9a-fA-F-]{16,}$/.test(cleaned) || cleaned.includes("@")) {
						entry.resolved = true;
						entry.id = cleaned;
						return;
					}
					pending.push({
						input: entry.input,
						query: cleaned,
						index
					});
				});
				await resolvePending(pending, (entries) => resolveMSTeamsUserAllowlist({
					cfg,
					entries
				}), (target, entry) => {
					target.resolved = entry.resolved;
					target.id = entry.id;
					target.name = entry.name;
					target.note = entry.note;
				});
				return results;
			}
			const pending = [];
			results.forEach((entry, index) => {
				const trimmed = entry.input.trim();
				if (!trimmed) {
					entry.note = "empty input";
					return;
				}
				const conversationId = parseMSTeamsConversationId(trimmed);
				if (conversationId !== null) {
					entry.resolved = Boolean(conversationId);
					entry.id = conversationId || void 0;
					entry.note = conversationId ? "conversation id" : "empty conversation id";
					return;
				}
				const parsed = parseMSTeamsTeamChannelInput(trimmed);
				if (!parsed.team) {
					entry.note = "missing team";
					return;
				}
				const query = parsed.channel ? `${parsed.team}/${parsed.channel}` : parsed.team;
				pending.push({
					input: entry.input,
					query,
					index
				});
			});
			await resolvePending(pending, (entries) => resolveMSTeamsChannelAllowlist({
				cfg,
				entries
			}), (target, entry) => {
				if (!entry.resolved || !entry.teamId) {
					target.resolved = false;
					target.note = entry.note;
					return;
				}
				target.resolved = true;
				if (entry.channelId) {
					target.id = `${entry.teamId}/${entry.channelId}`;
					target.name = entry.channelName && entry.teamName ? `${entry.teamName}/${entry.channelName}` : entry.channelName ?? entry.teamName;
				} else {
					target.id = entry.teamId;
					target.name = entry.teamName;
					target.note = "team id";
				}
				if (entry.note) target.note = entry.note;
			});
			return results;
		} },
		actions: {
			describeMessageTool: describeMSTeamsMessageTool,
			handleAction: async (ctx) => {
				const presentation = ctx.action === "send" ? normalizeMessagePresentation(ctx.params.presentation) : void 0;
				if (ctx.action === "send" && presentation) {
					const card = buildMSTeamsPresentationCard({
						presentation,
						text: resolveActionContent(ctx.params)
					});
					return await runWithRequiredActionTarget({
						actionLabel: "Card send",
						toolParams: ctx.params,
						run: async (to) => {
							const { sendAdaptiveCardMSTeams } = await loadMSTeamsChannelRuntime();
							const result = await sendAdaptiveCardMSTeams({
								cfg: ctx.cfg,
								to,
								card
							});
							return jsonActionResultWithDetails({
								ok: true,
								channel: "msteams",
								messageId: result.messageId,
								conversationId: result.conversationId
							}, {
								ok: true,
								channel: "msteams",
								messageId: result.messageId
							});
						}
					});
				}
				if (ctx.action === "upload-file") {
					const mediaUrl = resolveActionUploadFilePath(ctx.params);
					if (!mediaUrl) return actionError("Upload-file requires media, filePath, or path.");
					return await runWithRequiredActionTarget({
						actionLabel: "Upload-file",
						toolParams: ctx.params,
						currentChannelId: ctx.toolContext?.currentChannelId,
						run: async (to) => {
							const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
							const result = await sendMessageMSTeams({
								cfg: ctx.cfg,
								to,
								text: resolveActionContent(ctx.params),
								mediaUrl,
								filename: readOptionalTrimmedString(ctx.params, "filename") ?? readOptionalTrimmedString(ctx.params, "title"),
								mediaLocalRoots: ctx.mediaLocalRoots,
								mediaReadFile: ctx.mediaReadFile
							});
							return jsonActionResultWithDetails({
								ok: true,
								channel: "msteams",
								action: "upload-file",
								messageId: result.messageId,
								conversationId: result.conversationId,
								...result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}
							}, {
								ok: true,
								channel: "msteams",
								messageId: result.messageId,
								...result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}
							});
						}
					});
				}
				if (ctx.action === "edit") {
					const content = resolveActionContent(ctx.params);
					if (!content) return actionError("Edit requires content.");
					return await runWithRequiredActionMessageTarget({
						actionLabel: "Edit",
						toolParams: ctx.params,
						currentChannelId: ctx.toolContext?.currentChannelId,
						run: async (target) => {
							const { editMessageMSTeams } = await loadMSTeamsChannelRuntime();
							return jsonMSTeamsConversationResult((await editMessageMSTeams({
								cfg: ctx.cfg,
								to: target.to,
								activityId: target.messageId,
								text: content
							})).conversationId);
						}
					});
				}
				if (ctx.action === "delete") return await runWithRequiredActionMessageTarget({
					actionLabel: "Delete",
					toolParams: ctx.params,
					currentChannelId: ctx.toolContext?.currentChannelId,
					run: async (target) => {
						const { deleteMessageMSTeams } = await loadMSTeamsChannelRuntime();
						return jsonMSTeamsConversationResult((await deleteMessageMSTeams({
							cfg: ctx.cfg,
							to: target.to,
							activityId: target.messageId
						})).conversationId);
					}
				});
				if (ctx.action === "read") return await runWithRequiredActionMessageTarget({
					actionLabel: "Read",
					toolParams: ctx.params,
					currentChannelId: ctx.toolContext?.currentChannelId,
					currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
					graphOnly: true,
					run: async (target) => {
						const { getMessageMSTeams } = await loadMSTeamsChannelRuntime();
						return jsonMSTeamsOkActionResult("read", { message: await getMessageMSTeams({
							cfg: ctx.cfg,
							to: target.to,
							messageId: target.messageId
						}) });
					}
				});
				if (ctx.action === "pin") return await runWithRequiredActionMessageTarget({
					actionLabel: "Pin",
					toolParams: ctx.params,
					currentChannelId: ctx.toolContext?.currentChannelId,
					currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
					graphOnly: true,
					run: async (target) => {
						const { pinMessageMSTeams } = await loadMSTeamsChannelRuntime();
						return jsonMSTeamsActionResult("pin", await pinMessageMSTeams({
							cfg: ctx.cfg,
							to: target.to,
							messageId: target.messageId
						}));
					}
				});
				if (ctx.action === "unpin") return await runWithRequiredActionPinnedMessageTarget({
					actionLabel: "Unpin",
					toolParams: ctx.params,
					currentChannelId: ctx.toolContext?.currentChannelId,
					currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
					graphOnly: true,
					run: async (target) => {
						const { unpinMessageMSTeams } = await loadMSTeamsChannelRuntime();
						return jsonMSTeamsActionResult("unpin", await unpinMessageMSTeams({
							cfg: ctx.cfg,
							to: target.to,
							pinnedMessageId: target.pinnedMessageId
						}));
					}
				});
				if (ctx.action === "list-pins") return await runWithRequiredActionTarget({
					actionLabel: "List-pins",
					toolParams: ctx.params,
					currentChannelId: ctx.toolContext?.currentChannelId,
					currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
					graphOnly: true,
					run: async (to) => {
						const { listPinsMSTeams } = await loadMSTeamsChannelRuntime();
						return jsonMSTeamsOkActionResult("list-pins", await listPinsMSTeams({
							cfg: ctx.cfg,
							to
						}));
					}
				});
				if (ctx.action === "react") return await runWithRequiredActionMessageTarget({
					actionLabel: "React",
					toolParams: ctx.params,
					currentChannelId: ctx.toolContext?.currentChannelId,
					currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
					graphOnly: true,
					run: async (target) => {
						const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
						const remove = typeof ctx.params.remove === "boolean" ? ctx.params.remove : false;
						if (!emoji) return {
							isError: true,
							content: [{
								type: "text",
								text: `React requires an emoji (reaction type). Valid types: ${MSTEAMS_REACTION_TYPES.join(", ")}.`
							}],
							details: {
								error: "React requires an emoji (reaction type).",
								validTypes: [...MSTEAMS_REACTION_TYPES]
							}
						};
						if (remove) {
							const { unreactMessageMSTeams } = await loadMSTeamsChannelRuntime();
							return jsonMSTeamsActionResult("react", {
								removed: true,
								reactionType: emoji,
								...await unreactMessageMSTeams({
									cfg: ctx.cfg,
									to: target.to,
									messageId: target.messageId,
									reactionType: emoji
								})
							});
						}
						const { reactMessageMSTeams } = await loadMSTeamsChannelRuntime();
						return jsonMSTeamsActionResult("react", {
							reactionType: emoji,
							...await reactMessageMSTeams({
								cfg: ctx.cfg,
								to: target.to,
								messageId: target.messageId,
								reactionType: emoji
							})
						});
					}
				});
				if (ctx.action === "reactions") return await runWithRequiredActionMessageTarget({
					actionLabel: "Reactions",
					toolParams: ctx.params,
					currentChannelId: ctx.toolContext?.currentChannelId,
					currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
					graphOnly: true,
					run: async (target) => {
						const { listReactionsMSTeams } = await loadMSTeamsChannelRuntime();
						return jsonMSTeamsOkActionResult("reactions", await listReactionsMSTeams({
							cfg: ctx.cfg,
							to: target.to,
							messageId: target.messageId
						}));
					}
				});
				if (ctx.action === "search") return await runWithRequiredActionTarget({
					actionLabel: "Search",
					toolParams: ctx.params,
					currentChannelId: ctx.toolContext?.currentChannelId,
					currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
					graphOnly: true,
					run: async (to) => {
						const query = resolveActionQuery(ctx.params);
						if (!query) return actionError("Search requires a target (to) and query.");
						const limit = typeof ctx.params.limit === "number" ? ctx.params.limit : void 0;
						const from = typeof ctx.params.from === "string" ? ctx.params.from.trim() : void 0;
						const { searchMessagesMSTeams } = await loadMSTeamsChannelRuntime();
						return jsonMSTeamsOkActionResult("search", await searchMessagesMSTeams({
							cfg: ctx.cfg,
							to,
							query,
							from: from || void 0,
							limit
						}));
					}
				});
				if (ctx.action === "member-info") {
					const userId = normalizeOptionalString(ctx.params.userId) ?? "";
					if (!userId) return actionError("member-info requires a userId.");
					const { getMemberInfoMSTeams } = await loadMSTeamsChannelRuntime();
					return jsonMSTeamsOkActionResult("member-info", await getMemberInfoMSTeams({
						cfg: ctx.cfg,
						userId
					}));
				}
				if (ctx.action === "channel-list") {
					const teamId = normalizeOptionalString(ctx.params.teamId) ?? "";
					if (!teamId) return actionError("channel-list requires a teamId.");
					const { listChannelsMSTeams } = await loadMSTeamsChannelRuntime();
					return jsonMSTeamsOkActionResult("channel-list", await listChannelsMSTeams({
						cfg: ctx.cfg,
						teamId
					}));
				}
				if (ctx.action === "channel-info") {
					const teamId = normalizeOptionalString(ctx.params.teamId) ?? "";
					const channelId = normalizeOptionalString(ctx.params.channelId) ?? "";
					if (!teamId || !channelId) return actionError("channel-info requires teamId and channelId.");
					const { getChannelInfoMSTeams } = await loadMSTeamsChannelRuntime();
					return jsonMSTeamsOkActionResult("channel-info", { channelInfo: (await getChannelInfoMSTeams({
						cfg: ctx.cfg,
						teamId,
						channelId
					})).channel });
				}
				if (ctx.action === "addParticipant") {
					const userId = typeof ctx.params.userId === "string" ? ctx.params.userId.trim() : "";
					if (!userId) return actionError("addParticipant requires a userId.");
					return await runWithRequiredActionTarget({
						actionLabel: "addParticipant",
						toolParams: ctx.params,
						currentChannelId: ctx.toolContext?.currentChannelId,
						run: async (to) => {
							const role = readOptionalTrimmedString(ctx.params, "role");
							const { addParticipantMSTeams } = await loadMSTeamsChannelRuntime();
							return jsonMSTeamsOkActionResult("addParticipant", await addParticipantMSTeams({
								cfg: ctx.cfg,
								to,
								userId,
								role
							}));
						}
					});
				}
				if (ctx.action === "removeParticipant") {
					const userId = typeof ctx.params.userId === "string" ? ctx.params.userId.trim() : "";
					if (!userId) return actionError("removeParticipant requires a userId.");
					return await runWithRequiredActionTarget({
						actionLabel: "removeParticipant",
						toolParams: ctx.params,
						currentChannelId: ctx.toolContext?.currentChannelId,
						run: async (to) => {
							const { removeParticipantMSTeams } = await loadMSTeamsChannelRuntime();
							return jsonMSTeamsOkActionResult("removeParticipant", await removeParticipantMSTeams({
								cfg: ctx.cfg,
								to,
								userId
							}));
						}
					});
				}
				if (ctx.action === "renameGroup") {
					const name = typeof ctx.params.name === "string" ? ctx.params.name.trim() : "";
					if (!name) return actionError("renameGroup requires a name.");
					return await runWithRequiredActionTarget({
						actionLabel: "renameGroup",
						toolParams: ctx.params,
						currentChannelId: ctx.toolContext?.currentChannelId,
						run: async (to) => {
							const { renameGroupMSTeams } = await loadMSTeamsChannelRuntime();
							return jsonMSTeamsOkActionResult("renameGroup", await renameGroupMSTeams({
								cfg: ctx.cfg,
								to,
								name
							}));
						}
					});
				}
				return null;
			}
		},
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
			buildChannelSummary: ({ snapshot }) => buildProbeChannelStatusSummary(snapshot, { port: snapshot.port ?? null }),
			probeAccount: async ({ cfg }) => await (await loadMSTeamsChannelRuntime()).probeMSTeams(cfg.channels?.msteams),
			formatCapabilitiesProbe: ({ probe }) => {
				const teamsProbe = probe;
				const lines = [];
				const appId = typeof teamsProbe?.appId === "string" ? teamsProbe.appId.trim() : "";
				if (appId) lines.push({ text: `App: ${appId}` });
				const graph = teamsProbe?.graph;
				if (graph) {
					const roles = Array.isArray(graph.roles) ? graph.roles.map((role) => role.trim()).filter(Boolean) : [];
					const scopes = Array.isArray(graph.scopes) ? graph.scopes.map((scope) => scope.trim()).filter(Boolean) : [];
					const formatPermission = (permission) => {
						const hint = TEAMS_GRAPH_PERMISSION_HINTS[permission];
						return hint ? `${permission} (${hint})` : permission;
					};
					if (!graph.ok) lines.push({
						text: `Graph: ${graph.error ?? "failed"}`,
						tone: "error"
					});
					else if (roles.length > 0 || scopes.length > 0) {
						if (roles.length > 0) lines.push({ text: `Graph roles: ${roles.map(formatPermission).join(", ")}` });
						if (scopes.length > 0) lines.push({ text: `Graph scopes: ${scopes.map(formatPermission).join(", ")}` });
					} else if (graph.ok) lines.push({ text: "Graph: ok" });
				}
				return lines;
			},
			resolveAccountSnapshot: ({ account, runtime }) => ({
				accountId: account.accountId,
				enabled: account.enabled,
				configured: account.configured,
				extra: { port: runtime?.port ?? null }
			})
		}),
		gateway: { startAccount: async (ctx) => {
			const { monitorMSTeamsProvider } = await import("./src-aV3MRqqx.js");
			const port = ctx.cfg.channels?.msteams?.webhook?.port ?? 3978;
			ctx.setStatus({
				accountId: ctx.accountId,
				port
			});
			ctx.log?.info(`starting provider (port ${port})`);
			return monitorMSTeamsProvider({
				cfg: ctx.cfg,
				runtime: ctx.runtime,
				abortSignal: ctx.abortSignal
			});
		} }
	},
	security: { collectWarnings: projectConfigWarningCollector(collectMSTeamsSecurityWarnings) },
	pairing: { text: {
		idLabel: "msteamsUserId",
		message: PAIRING_APPROVED_MESSAGE,
		normalizeAllowEntry: createPairingPrefixStripper(/^(msteams|user):/i),
		notify: async ({ cfg, id, message }) => {
			const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
			await sendMessageMSTeams({
				cfg,
				to: id,
				text: message
			});
		}
	} },
	threading: { buildToolContext: ({ context, hasRepliedRef }) => {
		const nativeChannelId = context.NativeChannelId?.trim();
		const hasChannelRoute = Boolean(nativeChannelId && nativeChannelId.includes("/"));
		return {
			currentChannelId: normalizeOptionalString(context.To),
			currentGraphChannelId: hasChannelRoute ? nativeChannelId : void 0,
			currentThreadTs: context.ReplyToId,
			hasRepliedRef
		};
	} },
	outbound: msteamsChannelOutbound
});
//#endregion
export { msteamsPlugin as t };
