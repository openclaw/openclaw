import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "../../string-coerce-Bje8XVt9.js";
import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-Bj7l9NI7.js";
import { r as GoogleChatConfigSchema } from "../../zod-schema.providers-whatsapp-Dp8HfAry.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BmvPUIYK.js";
import { i as createLazyRuntimeNamedExport } from "../../lazy-runtime-YKrYYvwu.js";
import { a as createActionGate, f as readNumberParam, g as readStringParam, l as jsonResult, p as readReactionParams } from "../../common-Cf8ajZVR.js";
import { r as fetchRemoteMedia } from "../../fetch-CEEU7owc.js";
import { n as resolveChannelGroupRequireMention } from "../../group-policy-D12HbfWW.js";
import { n as missingTargetError } from "../../target-errors-CuzVTOOh.js";
import { t as sanitizeForPlainText } from "../../sanitize-text-DSqg642W.js";
import { s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "../../channel-config-helpers-DA-YZSMa.js";
import "../../text-runtime-DCigKjjg.js";
import { n as describeAccountSnapshot } from "../../account-helpers-C00UoYHr.js";
import { i as createChatChannelPlugin } from "../../core-DYAvmXJF.js";
import "../../channel-core-CUMQ1-YM.js";
import { i as runPassiveAccountLifecycle, t as createAccountStatusSink } from "../../channel-lifecycle.core-d_WL59u9.js";
import { n as formatNormalizedAllowFromEntries } from "../../allow-from-CR_qvB6d.js";
import { _ as createAllowlistProviderOpenWarningCollector, m as composeAccountWarningCollectors, n as createDangerousNameMatchingMutableAllowlistWarningCollector } from "../../channel-policy-5FBdjNP7.js";
import { t as createChannelDirectoryAdapter } from "../../directory-runtime-BUJApKvT.js";
import { f as listResolvedDirectoryGroupEntriesFromMapKeys, p as listResolvedDirectoryUserEntriesFromAllowFrom } from "../../directory-config-helpers-CFlHFCFn.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-8sVS2ssI.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C0n2CCnm.js";
import { d as createDefaultChannelRuntimeState, u as createComputedAccountStatusAdapter } from "../../status-helpers-BpxzCz5l.js";
import { t as extractToolSend } from "../../tool-send-C4EWZ7qQ.js";
import { t as resolveApprovalApprovers } from "../../approval-approvers-DKeVe9y-.js";
import { t as createResolvedApproverActionAuthAdapter } from "../../approval-auth-helpers-Qsa2ZWpM.js";
import { t as loadOutboundMediaFromUrl } from "../../outbound-media-ggFx4c0j.js";
import "../../outbound-runtime-B-qjGd38.js";
import { t as chunkTextForOutbound } from "../../text-chunking-uHaxHBm6.js";
import { n as buildPassiveProbedChannelStatusSummary } from "../../extension-shared-COLeQjXE.js";
import "../../channel-actions-eIOtDEsn.js";
import "../../channel-lifecycle-D27EMvrw.js";
import { a as resolveDefaultGoogleChatAccountId, i as listGoogleChatAccountIds, n as googlechatSetupAdapter, o as resolveGoogleChatAccount, r as listEnabledGoogleChatAccounts, s as resolveGoogleChatConfigAccessorAccount, t as googlechatSetupWizard } from "./setup-surface-DkbYAiTR.js";
import { t as getGoogleChatRuntime } from "./runtime-api-BDmbi6yd.js";
import { a as findGoogleChatDirectMessage, c as sendGoogleChatMessage, o as listGoogleChatReactions, r as deleteGoogleChatReaction, t as createGoogleChatReaction, u as uploadGoogleChatAttachment } from "./api-Byc34Qsr.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "./doctor-contract-a1dmky3A.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "./secret-contract-CmOpHuaE.js";
//#region extensions/googlechat/src/targets.ts
function normalizeGoogleChatTarget(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return;
	const normalized = trimmed.replace(/^(googlechat|google-chat|gchat):/i, "").replace(/^user:(users\/)?/i, "users/").replace(/^space:(spaces\/)?/i, "spaces/");
	if (isGoogleChatUserTarget(normalized)) {
		const suffix = normalized.slice(6);
		return suffix.includes("@") ? `users/${normalizeLowercaseStringOrEmpty(suffix)}` : normalized;
	}
	if (isGoogleChatSpaceTarget(normalized)) return normalized;
	if (normalized.includes("@")) return `users/${normalizeLowercaseStringOrEmpty(normalized)}`;
	return normalized;
}
function isGoogleChatUserTarget(value) {
	return normalizeLowercaseStringOrEmpty(value).startsWith("users/");
}
function isGoogleChatSpaceTarget(value) {
	return normalizeLowercaseStringOrEmpty(value).startsWith("spaces/");
}
function stripMessageSuffix(target) {
	const index = target.indexOf("/messages/");
	if (index === -1) return target;
	return target.slice(0, index);
}
async function resolveGoogleChatOutboundSpace(params) {
	const normalized = normalizeGoogleChatTarget(params.target);
	if (!normalized) throw new Error("Missing Google Chat target.");
	const base = stripMessageSuffix(normalized);
	if (isGoogleChatSpaceTarget(base)) return base;
	if (isGoogleChatUserTarget(base)) {
		const dm = await findGoogleChatDirectMessage({
			account: params.account,
			userName: base
		});
		if (!dm?.name) throw new Error(`No Google Chat DM found for ${base}`);
		return dm.name;
	}
	return base;
}
//#endregion
//#region extensions/googlechat/src/actions.ts
const providerId = "googlechat";
function listEnabledAccounts(cfg) {
	return listEnabledGoogleChatAccounts(cfg).filter((account) => account.enabled && account.credentialSource !== "none");
}
function isReactionsEnabled(accounts) {
	for (const account of accounts) if (createActionGate(account.config.actions)("reactions")) return true;
	return false;
}
function resolveAppUserNames(account) {
	return new Set(["users/app", account.config.botUser?.trim()].filter(Boolean));
}
async function loadGoogleChatActionMedia(params) {
	const runtime = getGoogleChatRuntime();
	return /^https?:\/\//i.test(params.mediaUrl) ? await runtime.channel.media.fetchRemoteMedia({
		url: params.mediaUrl,
		maxBytes: params.maxBytes
	}) : await loadOutboundMediaFromUrl(params.mediaUrl, {
		maxBytes: params.maxBytes,
		mediaAccess: params.mediaAccess,
		mediaLocalRoots: params.mediaLocalRoots,
		mediaReadFile: params.mediaReadFile
	});
}
const googlechatMessageActions = {
	describeMessageTool: ({ cfg, accountId }) => {
		const accounts = accountId ? [resolveGoogleChatAccount({
			cfg,
			accountId
		})].filter((account) => account.enabled && account.credentialSource !== "none") : listEnabledAccounts(cfg);
		if (accounts.length === 0) return null;
		const actions = /* @__PURE__ */ new Set([]);
		actions.add("send");
		actions.add("upload-file");
		if (isReactionsEnabled(accounts)) {
			actions.add("react");
			actions.add("reactions");
		}
		return { actions: Array.from(actions) };
	},
	extractToolSend: ({ args }) => {
		return extractToolSend(args, "sendMessage");
	},
	handleAction: async ({ action, params, cfg, accountId, mediaAccess, mediaLocalRoots, mediaReadFile }) => {
		const account = resolveGoogleChatAccount({
			cfg,
			accountId
		});
		if (account.credentialSource === "none") throw new Error("Google Chat credentials are missing.");
		if (action === "send" || action === "upload-file") {
			const to = readStringParam(params, "to", { required: true });
			const content = readStringParam(params, "message", {
				required: action === "send",
				allowEmpty: true
			}) ?? readStringParam(params, "initialComment", { allowEmpty: true }) ?? "";
			const mediaUrl = readStringParam(params, "media", { trim: false }) ?? readStringParam(params, "filePath", { trim: false }) ?? readStringParam(params, "path", { trim: false });
			const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
			const space = await resolveGoogleChatOutboundSpace({
				account,
				target: to
			});
			if (mediaUrl) {
				const loaded = await loadGoogleChatActionMedia({
					mediaUrl,
					maxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
					mediaAccess,
					mediaLocalRoots,
					mediaReadFile
				});
				const uploadFileName = readStringParam(params, "filename") ?? readStringParam(params, "title") ?? loaded.fileName ?? "attachment";
				const upload = await uploadGoogleChatAttachment({
					account,
					space,
					filename: uploadFileName,
					buffer: loaded.buffer,
					contentType: loaded.contentType
				});
				await sendGoogleChatMessage({
					account,
					space,
					text: content,
					thread: threadId ?? void 0,
					attachments: upload.attachmentUploadToken ? [{
						attachmentUploadToken: upload.attachmentUploadToken,
						contentName: uploadFileName
					}] : void 0
				});
				return jsonResult({
					ok: true,
					to: space
				});
			}
			if (action === "upload-file") throw new Error("upload-file requires media, filePath, or path");
			await sendGoogleChatMessage({
				account,
				space,
				text: content,
				thread: threadId ?? void 0
			});
			return jsonResult({
				ok: true,
				to: space
			});
		}
		if (action === "react") {
			const messageName = readStringParam(params, "messageId", { required: true });
			const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a Google Chat reaction." });
			if (remove || isEmpty) {
				const reactions = await listGoogleChatReactions({
					account,
					messageName
				});
				const appUsers = resolveAppUserNames(account);
				const toRemove = reactions.filter((reaction) => {
					const userName = reaction.user?.name?.trim();
					if (appUsers.size > 0 && !appUsers.has(userName ?? "")) return false;
					if (emoji) return reaction.emoji?.unicode === emoji;
					return true;
				});
				for (const reaction of toRemove) {
					if (!reaction.name) continue;
					await deleteGoogleChatReaction({
						account,
						reactionName: reaction.name
					});
				}
				return jsonResult({
					ok: true,
					removed: toRemove.length
				});
			}
			return jsonResult({
				ok: true,
				reaction: await createGoogleChatReaction({
					account,
					messageName,
					emoji
				})
			});
		}
		if (action === "reactions") return jsonResult({
			ok: true,
			reactions: await listGoogleChatReactions({
				account,
				messageName: readStringParam(params, "messageId", { required: true }),
				limit: readNumberParam(params, "limit", { integer: true }) ?? void 0
			})
		});
		throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
	}
};
//#endregion
//#region extensions/googlechat/src/approval-auth.ts
function normalizeGoogleChatApproverId(value) {
	const normalized = normalizeGoogleChatTarget(String(value));
	if (!normalized || !isGoogleChatUserTarget(normalized)) return;
	const suffix = normalizeLowercaseStringOrEmpty(normalized.slice(6));
	if (!suffix || suffix.includes("@")) return;
	return `users/${suffix}`;
}
const googleChatApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "Google Chat",
	resolveApprovers: ({ cfg, accountId }) => {
		const account = resolveGoogleChatAccount({
			cfg,
			accountId
		}).config;
		return resolveApprovalApprovers({
			allowFrom: account.dm?.allowFrom,
			defaultTo: account.defaultTo,
			normalizeApprover: normalizeGoogleChatApproverId
		});
	},
	normalizeSenderId: (value) => normalizeGoogleChatApproverId(value)
});
//#endregion
//#region extensions/googlechat/src/group-policy.ts
function resolveGoogleChatGroupRequireMention(params) {
	return resolveChannelGroupRequireMention({
		cfg: params.cfg,
		channel: "googlechat",
		groupId: params.groupId,
		accountId: params.accountId
	});
}
//#endregion
//#region extensions/googlechat/src/channel.adapters.ts
const loadGoogleChatChannelRuntime$2 = createLazyRuntimeNamedExport(() => import("./channel.runtime-D5x9GN3W.js"), "googleChatChannelRuntime");
const formatAllowFromEntry = (entry) => normalizeLowercaseStringOrEmpty(entry.trim().replace(/^(googlechat|google-chat|gchat):/i, "").replace(/^user:/i, "").replace(/^users\//i, ""));
const collectGoogleChatSecurityWarnings = composeAccountWarningCollectors(createAllowlistProviderOpenWarningCollector({
	providerConfigPresent: (cfg) => cfg.channels?.googlechat !== void 0,
	resolveGroupPolicy: (account) => account.config.groupPolicy,
	buildOpenWarning: {
		surface: "Google Chat spaces",
		openBehavior: "allows any space to trigger (mention-gated)",
		remediation: "Set channels.googlechat.groupPolicy=\"allowlist\" and configure channels.googlechat.groups"
	}
}), (account) => account.config.dm?.policy === "open" && "- Google Chat DMs are open to anyone. Set channels.googlechat.dm.policy=\"pairing\" or \"allowlist\".");
const googlechatGroupsAdapter = { resolveRequireMention: resolveGoogleChatGroupRequireMention };
const googlechatDirectoryAdapter = createChannelDirectoryAdapter({
	listPeers: async (params) => listResolvedDirectoryUserEntriesFromAllowFrom({
		...params,
		resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
		resolveAllowFrom: (account) => account.config.dm?.allowFrom,
		normalizeId: (entry) => normalizeGoogleChatTarget(entry) ?? entry
	}),
	listGroups: async (params) => listResolvedDirectoryGroupEntriesFromMapKeys({
		...params,
		resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
		resolveGroups: (account) => account.config.groups
	})
});
const googlechatSecurityAdapter = {
	dm: {
		channelKey: "googlechat",
		resolvePolicy: (account) => account.config.dm?.policy,
		resolveAllowFrom: (account) => account.config.dm?.allowFrom,
		allowFromPathSuffix: "dm.",
		normalizeEntry: (raw) => formatAllowFromEntry(raw)
	},
	collectWarnings: collectGoogleChatSecurityWarnings
};
const googlechatThreadingAdapter = { scopedAccountReplyToMode: {
	resolveAccount: (cfg, accountId) => resolveGoogleChatAccount({
		cfg,
		accountId
	}),
	resolveReplyToMode: (account, _chatType) => account.config.replyToMode,
	fallback: "off"
} };
const googlechatPairingTextAdapter = {
	idLabel: "googlechatUserId",
	message: PAIRING_APPROVED_MESSAGE,
	normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
	notify: async ({ cfg, id, message, accountId }) => {
		const account = resolveGoogleChatAccount({
			cfg,
			accountId
		});
		if (account.credentialSource === "none") return;
		const user = normalizeGoogleChatTarget(id) ?? id;
		const space = await resolveGoogleChatOutboundSpace({
			account,
			target: isGoogleChatUserTarget(user) ? user : `users/${user}`
		});
		const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime$2();
		await sendGoogleChatMessage({
			account,
			space,
			text: message
		});
	}
};
const googlechatOutboundAdapter = {
	base: {
		deliveryMode: "direct",
		chunker: chunkTextForOutbound,
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		sanitizeText: ({ text }) => sanitizeForPlainText(text),
		resolveTarget: ({ to }) => {
			const trimmed = normalizeOptionalString(to) ?? "";
			if (trimmed) {
				const normalized = normalizeGoogleChatTarget(trimmed);
				if (!normalized) return {
					ok: false,
					error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>")
				};
				return {
					ok: true,
					to: normalized
				};
			}
			return {
				ok: false,
				error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>")
			};
		}
	},
	attachedResults: {
		channel: "googlechat",
		sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
			const account = resolveGoogleChatAccount({
				cfg,
				accountId
			});
			const space = await resolveGoogleChatOutboundSpace({
				account,
				target: to
			});
			const thread = typeof threadId === "number" ? String(threadId) : threadId ?? replyToId ?? void 0;
			const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime$2();
			return {
				messageId: (await sendGoogleChatMessage({
					account,
					space,
					text,
					thread
				}))?.messageName ?? "",
				chatId: space
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, mediaAccess, mediaLocalRoots, mediaReadFile, accountId, replyToId, threadId }) => {
			if (!mediaUrl) throw new Error("Google Chat mediaUrl is required.");
			const account = resolveGoogleChatAccount({
				cfg,
				accountId
			});
			const space = await resolveGoogleChatOutboundSpace({
				account,
				target: to
			});
			const thread = typeof threadId === "number" ? String(threadId) : threadId ?? replyToId ?? void 0;
			const effectiveMaxBytes = resolveChannelMediaMaxBytes({
				cfg,
				resolveChannelLimitMb: ({ cfg, accountId }) => (cfg.channels?.googlechat)?.accounts?.[accountId]?.mediaMaxMb ?? (cfg.channels?.googlechat)?.mediaMaxMb,
				accountId
			}) ?? (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
			const loaded = /^https?:\/\//i.test(mediaUrl) ? await fetchRemoteMedia({
				url: mediaUrl,
				maxBytes: effectiveMaxBytes
			}) : await loadOutboundMediaFromUrl(mediaUrl, {
				maxBytes: effectiveMaxBytes,
				mediaAccess,
				mediaLocalRoots,
				mediaReadFile
			});
			const { sendGoogleChatMessage, uploadGoogleChatAttachment } = await loadGoogleChatChannelRuntime$2();
			const upload = await uploadGoogleChatAttachment({
				account,
				space,
				filename: loaded.fileName ?? "attachment",
				buffer: loaded.buffer,
				contentType: loaded.contentType
			});
			return {
				messageId: (await sendGoogleChatMessage({
					account,
					space,
					text,
					thread,
					attachments: upload.attachmentUploadToken ? [{
						attachmentUploadToken: upload.attachmentUploadToken,
						contentName: loaded.fileName
					}] : void 0
				}))?.messageName ?? "",
				chatId: space
			};
		}
	}
};
//#endregion
//#region extensions/googlechat/src/doctor.ts
function asObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function isGoogleChatMutableAllowEntry(raw) {
	const text = raw.trim();
	if (!text || text === "*") return false;
	const withoutPrefix = text.replace(/^(googlechat|google-chat|gchat):/i, "").trim();
	if (!withoutPrefix) return false;
	return withoutPrefix.replace(/^users\//i, "").includes("@");
}
const collectGoogleChatMutableAllowlistWarnings = createDangerousNameMatchingMutableAllowlistWarningCollector({
	channel: "googlechat",
	detector: isGoogleChatMutableAllowEntry,
	collectLists: (scope) => {
		const lists = [{
			pathLabel: `${scope.prefix}.groupAllowFrom`,
			list: scope.account.groupAllowFrom
		}];
		const dm = asObjectRecord(scope.account.dm);
		if (dm) lists.push({
			pathLabel: `${scope.prefix}.dm.allowFrom`,
			list: dm.allowFrom
		});
		const groups = asObjectRecord(scope.account.groups);
		if (groups) for (const [groupKey, groupRaw] of Object.entries(groups)) {
			const group = asObjectRecord(groupRaw);
			if (!group) continue;
			lists.push({
				pathLabel: `${scope.prefix}.groups.${groupKey}.users`,
				list: group.users
			});
		}
		return lists;
	}
});
//#endregion
//#region extensions/googlechat/src/gateway.ts
const loadGoogleChatChannelRuntime$1 = createLazyRuntimeNamedExport(() => import("./channel.runtime-D5x9GN3W.js"), "googleChatChannelRuntime");
async function startGoogleChatGatewayAccount(ctx) {
	const account = ctx.account;
	const statusSink = createAccountStatusSink({
		accountId: account.accountId,
		setStatus: ctx.setStatus
	});
	ctx.log?.info?.(`[${account.accountId}] starting Google Chat webhook`);
	const { resolveGoogleChatWebhookPath, startGoogleChatMonitor } = await loadGoogleChatChannelRuntime$1();
	statusSink({
		running: true,
		lastStartAt: Date.now(),
		webhookPath: resolveGoogleChatWebhookPath({ account }),
		audienceType: account.config.audienceType,
		audience: account.config.audience
	});
	await runPassiveAccountLifecycle({
		abortSignal: ctx.abortSignal,
		start: async () => await startGoogleChatMonitor({
			account,
			config: ctx.cfg,
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			webhookPath: account.config.webhookPath,
			webhookUrl: account.config.webhookUrl,
			statusSink
		}),
		stop: async (unregister) => {
			unregister?.();
		},
		onStop: async () => {
			statusSink({
				running: false,
				lastStopAt: Date.now()
			});
		}
	});
}
//#endregion
//#region extensions/googlechat/src/channel.ts
const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(() => import("./channel.runtime-D5x9GN3W.js"), "googleChatChannelRuntime");
const meta = {
	id: "googlechat",
	label: "Google Chat",
	selectionLabel: "Google Chat (Chat API)",
	docsPath: "/channels/googlechat",
	docsLabel: "googlechat",
	blurb: "Google Workspace Chat app with HTTP webhook.",
	aliases: ["gchat", "google-chat"],
	order: 55,
	detailLabel: "Google Chat",
	systemImage: "message.badge",
	markdownCapable: true
};
const googleChatConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: "googlechat",
	listAccountIds: listGoogleChatAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
	resolveAccessorAccount: resolveGoogleChatConfigAccessorAccount,
	defaultAccountId: resolveDefaultGoogleChatAccountId,
	clearBaseFields: [
		"serviceAccount",
		"serviceAccountFile",
		"audienceType",
		"audience",
		"webhookPath",
		"webhookUrl",
		"botUser",
		"name"
	],
	resolveAllowFrom: (account) => account.config.dm?.allowFrom,
	formatAllowFrom: (allowFrom) => formatNormalizedAllowFromEntries({
		allowFrom,
		normalizeEntry: formatAllowFromEntry
	}),
	resolveDefaultTo: (account) => account.config.defaultTo
});
const googlechatActions = {
	describeMessageTool: (ctx) => googlechatMessageActions.describeMessageTool?.(ctx) ?? null,
	extractToolSend: (ctx) => googlechatMessageActions.extractToolSend?.(ctx) ?? null,
	handleAction: async (ctx) => {
		if (!googlechatMessageActions.handleAction) throw new Error("Google Chat actions are not available.");
		return await googlechatMessageActions.handleAction(ctx);
	}
};
const googlechatPlugin = createChatChannelPlugin({
	base: {
		id: "googlechat",
		meta: { ...meta },
		setup: googlechatSetupAdapter,
		setupWizard: googlechatSetupWizard,
		capabilities: {
			chatTypes: [
				"direct",
				"group",
				"thread"
			],
			reactions: true,
			threads: true,
			media: true,
			nativeCommands: false,
			blockStreaming: true
		},
		streaming: { blockStreamingCoalesceDefaults: {
			minChars: 1500,
			idleMs: 1e3
		} },
		reload: { configPrefixes: ["channels.googlechat"] },
		configSchema: buildChannelConfigSchema(GoogleChatConfigSchema),
		config: {
			...googleChatConfigAdapter,
			isConfigured: (account) => account.credentialSource !== "none",
			describeAccount: (account) => describeAccountSnapshot({
				account,
				configured: account.credentialSource !== "none",
				extra: { credentialSource: account.credentialSource }
			})
		},
		approvalCapability: googleChatApprovalAuth,
		secrets: {
			secretTargetRegistryEntries,
			collectRuntimeConfigAssignments
		},
		groups: googlechatGroupsAdapter,
		messaging: {
			targetPrefixes: [
				"googlechat",
				"google-chat",
				"gchat"
			],
			normalizeTarget: normalizeGoogleChatTarget,
			targetResolver: {
				looksLikeId: (raw, normalized) => {
					const value = normalized ?? raw.trim();
					return isGoogleChatSpaceTarget(value) || isGoogleChatUserTarget(value);
				},
				hint: "<spaces/{space}|users/{user}>"
			}
		},
		directory: googlechatDirectoryAdapter,
		resolver: { resolveTargets: async ({ inputs, kind }) => {
			return inputs.map((input) => {
				const normalized = normalizeGoogleChatTarget(input);
				if (!normalized) return {
					input,
					resolved: false,
					note: "empty target"
				};
				if (kind === "user" && isGoogleChatUserTarget(normalized)) return {
					input,
					resolved: true,
					id: normalized
				};
				if (kind === "group" && isGoogleChatSpaceTarget(normalized)) return {
					input,
					resolved: true,
					id: normalized
				};
				return {
					input,
					resolved: false,
					note: "use spaces/{space} or users/{user}"
				};
			});
		} },
		actions: googlechatActions,
		doctor: {
			dmAllowFromMode: "nestedOnly",
			groupModel: "route",
			groupAllowFromFallbackToAllowFrom: false,
			warnOnEmptyGroupSenderAllowlist: false,
			legacyConfigRules,
			normalizeCompatibilityConfig,
			collectMutableAllowlistWarnings: collectGoogleChatMutableAllowlistWarnings
		},
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			collectStatusIssues: (accounts) => accounts.flatMap((entry) => {
				const accountId = entry.accountId ?? "default";
				const enabled = entry.enabled !== false;
				const configured = entry.configured === true;
				if (!enabled || !configured) return [];
				const issues = [];
				if (!entry.audience) issues.push({
					channel: "googlechat",
					accountId,
					kind: "config",
					message: "Google Chat audience is missing (set channels.googlechat.audience).",
					fix: "Set channels.googlechat.audienceType and channels.googlechat.audience."
				});
				if (!entry.audienceType) issues.push({
					channel: "googlechat",
					accountId,
					kind: "config",
					message: "Google Chat audienceType is missing (app-url or project-number).",
					fix: "Set channels.googlechat.audienceType and channels.googlechat.audience."
				});
				return issues;
			}),
			buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot, {
				credentialSource: snapshot.credentialSource ?? "none",
				audienceType: snapshot.audienceType ?? null,
				audience: snapshot.audience ?? null,
				webhookPath: snapshot.webhookPath ?? null,
				webhookUrl: snapshot.webhookUrl ?? null
			}),
			probeAccount: async ({ account }) => (await loadGoogleChatChannelRuntime()).probeGoogleChat(account),
			resolveAccountSnapshot: ({ account }) => ({
				accountId: account.accountId,
				name: account.name,
				enabled: account.enabled,
				configured: account.credentialSource !== "none",
				extra: {
					credentialSource: account.credentialSource,
					audienceType: account.config.audienceType,
					audience: account.config.audience,
					webhookPath: account.config.webhookPath,
					webhookUrl: account.config.webhookUrl,
					dmPolicy: account.config.dm?.policy ?? "pairing"
				}
			})
		}),
		gateway: { startAccount: startGoogleChatGatewayAccount }
	},
	pairing: { text: googlechatPairingTextAdapter },
	security: googlechatSecurityAdapter,
	threading: googlechatThreadingAdapter,
	outbound: googlechatOutboundAdapter
});
//#endregion
export { googlechatPlugin as t };
