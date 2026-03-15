import { h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { bn as buildChannelConfigSchema, dn as PAIRING_APPROVED_MESSAGE, m as getChatChannelMeta } from "./resolve-route-BZ4hHpx2.js";
import { r as runPassiveAccountLifecycle, t as createAccountStatusSink } from "./channel-lifecycle-h2DwjEdV.js";
import { Na as resolveChannelMediaMaxBytes, O as collectAllowlistProviderGroupPolicyWarnings, T as buildOpenGroupPolicyConfigureRouteAllowlistWarning, bp as createScopedDmSecurityResolver, ci as extractToolSend, cr as missingTargetError, gp as listDirectoryUserEntriesFromAllowFrom, il as resolveGoogleChatGroupRequireMention, mp as listDirectoryGroupEntriesFromMapKeys, pf as GoogleChatConfigSchema, vp as createScopedAccountConfigAccessors, xt as formatNormalizedAllowFromEntries, yp as createScopedChannelConfigBase, zu as buildComputedAccountStatusSnapshot } from "./auth-profiles-CuJtivJK.js";
import { C as readReactionParams, E as readStringParam, S as readNumberParam, _ as createActionGate, b as jsonResult } from "./external-content-vZzOHxnd.js";
import { _ as googlechatSetupAdapter, a as findGoogleChatDirectMessage, c as sendGoogleChatMessage, f as googlechatSetupWizard, g as resolveGoogleChatAccount, h as resolveDefaultGoogleChatAccountId, m as listGoogleChatAccountIds, o as listGoogleChatReactions, p as listEnabledGoogleChatAccounts, r as deleteGoogleChatReaction, t as createGoogleChatReaction, u as uploadGoogleChatAttachment } from "./api-BCgnLHyI.js";
import { n as buildPassiveProbedChannelStatusSummary } from "./channel-status-summary-C_aBM2lc.js";
import { t as getGoogleChatRuntime } from "./runtime-BiAbcPrx.js";
//#region extensions/googlechat/src/targets.ts
function normalizeGoogleChatTarget(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) {return;}
	const normalized = trimmed.replace(/^(googlechat|google-chat|gchat):/i, "").replace(/^user:(users\/)?/i, "users/").replace(/^space:(spaces\/)?/i, "spaces/");
	if (isGoogleChatUserTarget(normalized)) {
		const suffix = normalized.slice(6);
		return suffix.includes("@") ? `users/${suffix.toLowerCase()}` : normalized;
	}
	if (isGoogleChatSpaceTarget(normalized)) {return normalized;}
	if (normalized.includes("@")) {return `users/${normalized.toLowerCase()}`;}
	return normalized;
}
function isGoogleChatUserTarget(value) {
	return value.toLowerCase().startsWith("users/");
}
function isGoogleChatSpaceTarget(value) {
	return value.toLowerCase().startsWith("spaces/");
}
function stripMessageSuffix(target) {
	const index = target.indexOf("/messages/");
	if (index === -1) {return target;}
	return target.slice(0, index);
}
async function resolveGoogleChatOutboundSpace(params) {
	const normalized = normalizeGoogleChatTarget(params.target);
	if (!normalized) {throw new Error("Missing Google Chat target.");}
	const base = stripMessageSuffix(normalized);
	if (isGoogleChatSpaceTarget(base)) {return base;}
	if (isGoogleChatUserTarget(base)) {
		const dm = await findGoogleChatDirectMessage({
			account: params.account,
			userName: base
		});
		if (!dm?.name) {throw new Error(`No Google Chat DM found for ${base}`);}
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
function isReactionsEnabled(accounts, cfg) {
	for (const account of accounts) {if (createActionGate(account.config.actions ?? (cfg.channels?.["googlechat"])?.actions)("reactions")) return true;}
	return false;
}
function resolveAppUserNames(account) {
	return new Set(["users/app", account.config.botUser?.trim()].filter(Boolean));
}
const googlechatMessageActions = {
	listActions: ({ cfg }) => {
		const accounts = listEnabledAccounts(cfg);
		if (accounts.length === 0) {return [];}
		const actions = /* @__PURE__ */ new Set([]);
		actions.add("send");
		if (isReactionsEnabled(accounts, cfg)) {
			actions.add("react");
			actions.add("reactions");
		}
		return Array.from(actions);
	},
	extractToolSend: ({ args }) => {
		return extractToolSend(args, "sendMessage");
	},
	handleAction: async ({ action, params, cfg, accountId }) => {
		const account = resolveGoogleChatAccount({
			cfg,
			accountId
		});
		if (account.credentialSource === "none") {throw new Error("Google Chat credentials are missing.");}
		if (action === "send") {
			const to = readStringParam(params, "to", { required: true });
			const content = readStringParam(params, "message", {
				required: true,
				allowEmpty: true
			});
			const mediaUrl = readStringParam(params, "media", { trim: false });
			const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
			const space = await resolveGoogleChatOutboundSpace({
				account,
				target: to
			});
			if (mediaUrl) {
				const core = getGoogleChatRuntime();
				const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
				const loaded = await core.channel.media.fetchRemoteMedia({
					url: mediaUrl,
					maxBytes
				});
				const upload = await uploadGoogleChatAttachment({
					account,
					space,
					filename: loaded.fileName ?? "attachment",
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
						contentName: loaded.fileName
					}] : void 0
				});
				return jsonResult({
					ok: true,
					to: space
				});
			}
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
					if (appUsers.size > 0 && !appUsers.has(userName ?? "")) {return false;}
					if (emoji) {return reaction.emoji?.unicode === emoji;}
					return true;
				});
				for (const reaction of toRemove) {
					if (!reaction.name) {continue;}
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
		if (action === "reactions") {return jsonResult({
			ok: true,
			reactions: await listGoogleChatReactions({
				account,
				messageName: readStringParam(params, "messageId", { required: true }),
				limit: readNumberParam(params, "limit", { integer: true }) ?? void 0
			})
		});}
		throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
	}
};
//#endregion
//#region extensions/googlechat/src/channel.ts
const meta = getChatChannelMeta("googlechat");
async function loadGoogleChatChannelRuntime() {
	return await import("./channel.runtime-DnxkIJ6A.js");
}
const formatAllowFromEntry = (entry) => entry.trim().replace(/^(googlechat|google-chat|gchat):/i, "").replace(/^user:/i, "").replace(/^users\//i, "").toLowerCase();
const googleChatConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveGoogleChatAccount({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.config.dm?.allowFrom,
	formatAllowFrom: (allowFrom) => formatNormalizedAllowFromEntries({
		allowFrom,
		normalizeEntry: formatAllowFromEntry
	}),
	resolveDefaultTo: (account) => account.config.defaultTo
});
const googleChatConfigBase = createScopedChannelConfigBase({
	sectionKey: "googlechat",
	listAccountIds: listGoogleChatAccountIds,
	resolveAccount: (cfg, accountId) => resolveGoogleChatAccount({
		cfg,
		accountId
	}),
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
	]
});
const resolveGoogleChatDmPolicy = createScopedDmSecurityResolver({
	channelKey: "googlechat",
	resolvePolicy: (account) => account.config.dm?.policy,
	resolveAllowFrom: (account) => account.config.dm?.allowFrom,
	allowFromPathSuffix: "dm.",
	normalizeEntry: (raw) => formatAllowFromEntry(raw)
});
const googlechatActions = {
	listActions: (ctx) => googlechatMessageActions.listActions?.(ctx) ?? [],
	extractToolSend: (ctx) => googlechatMessageActions.extractToolSend?.(ctx) ?? null,
	handleAction: async (ctx) => {
		if (!googlechatMessageActions.handleAction) {throw new Error("Google Chat actions are not available.");}
		return await googlechatMessageActions.handleAction(ctx);
	}
};
const googlechatPlugin = {
	id: "googlechat",
	meta: { ...meta },
	setup: googlechatSetupAdapter,
	setupWizard: googlechatSetupWizard,
	pairing: {
		idLabel: "googlechatUserId",
		normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
		notifyApproval: async ({ cfg, id }) => {
			const account = resolveGoogleChatAccount({ cfg });
			if (account.credentialSource === "none") {return;}
			const user = normalizeGoogleChatTarget(id) ?? id;
			const space = await resolveGoogleChatOutboundSpace({
				account,
				target: isGoogleChatUserTarget(user) ? user : `users/${user}`
			});
			const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime();
			await sendGoogleChatMessage({
				account,
				space,
				text: PAIRING_APPROVED_MESSAGE
			});
		}
	},
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
		...googleChatConfigBase,
		isConfigured: (account) => account.credentialSource !== "none",
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: account.credentialSource !== "none",
			credentialSource: account.credentialSource
		}),
		...googleChatConfigAccessors
	},
	security: {
		resolveDmPolicy: resolveGoogleChatDmPolicy,
		collectWarnings: ({ account, cfg }) => {
			const warnings = collectAllowlistProviderGroupPolicyWarnings({
				cfg,
				providerConfigPresent: cfg.channels?.googlechat !== void 0,
				configuredGroupPolicy: account.config.groupPolicy,
				collect: (groupPolicy) => groupPolicy === "open" ? [buildOpenGroupPolicyConfigureRouteAllowlistWarning({
					surface: "Google Chat spaces",
					openScope: "any space",
					groupPolicyPath: "channels.googlechat.groupPolicy",
					routeAllowlistPath: "channels.googlechat.groups"
				})] : []
			});
			if (account.config.dm?.policy === "open") {warnings.push(`- Google Chat DMs are open to anyone. Set channels.googlechat.dm.policy="pairing" or "allowlist".`);}
			return warnings;
		}
	},
	groups: { resolveRequireMention: resolveGoogleChatGroupRequireMention },
	threading: { resolveReplyToMode: ({ cfg }) => cfg.channels?.["googlechat"]?.replyToMode ?? "off" },
	messaging: {
		normalizeTarget: normalizeGoogleChatTarget,
		targetResolver: {
			looksLikeId: (raw, normalized) => {
				const value = normalized ?? raw.trim();
				return isGoogleChatSpaceTarget(value) || isGoogleChatUserTarget(value);
			},
			hint: "<spaces/{space}|users/{user}>"
		}
	},
	directory: {
		self: async () => null,
		listPeers: async ({ cfg, accountId, query, limit }) => {
			return listDirectoryUserEntriesFromAllowFrom({
				allowFrom: resolveGoogleChatAccount({
					cfg,
					accountId
				}).config.dm?.allowFrom,
				query,
				limit,
				normalizeId: (entry) => normalizeGoogleChatTarget(entry) ?? entry
			});
		},
		listGroups: async ({ cfg, accountId, query, limit }) => {
			return listDirectoryGroupEntriesFromMapKeys({
				groups: resolveGoogleChatAccount({
					cfg,
					accountId
				}).config.groups,
				query,
				limit
			});
		}
	},
	resolver: { resolveTargets: async ({ inputs, kind }) => {
		return inputs.map((input) => {
			const normalized = normalizeGoogleChatTarget(input);
			if (!normalized) {return {
				input,
				resolved: false,
				note: "empty target"
			};}
			if (kind === "user" && isGoogleChatUserTarget(normalized)) {return {
				input,
				resolved: true,
				id: normalized
			};}
			if (kind === "group" && isGoogleChatSpaceTarget(normalized)) {return {
				input,
				resolved: true,
				id: normalized
			};}
			return {
				input,
				resolved: false,
				note: "use spaces/{space} or users/{user}"
			};
		});
	} },
	actions: googlechatActions,
	outbound: {
		deliveryMode: "direct",
		chunker: (text, limit) => getGoogleChatRuntime().channel.text.chunkMarkdownText(text, limit),
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		resolveTarget: ({ to }) => {
			const trimmed = to?.trim() ?? "";
			if (trimmed) {
				const normalized = normalizeGoogleChatTarget(trimmed);
				if (!normalized) {return {
					ok: false,
					error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>")
				};}
				return {
					ok: true,
					to: normalized
				};
			}
			return {
				ok: false,
				error: missingTargetError("Google Chat", "<spaces/{space}|users/{user}>")
			};
		},
		sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
			const account = resolveGoogleChatAccount({
				cfg,
				accountId
			});
			const space = await resolveGoogleChatOutboundSpace({
				account,
				target: to
			});
			const thread = threadId ?? replyToId ?? void 0;
			const { sendGoogleChatMessage } = await loadGoogleChatChannelRuntime();
			return {
				channel: "googlechat",
				messageId: (await sendGoogleChatMessage({
					account,
					space,
					text,
					thread
				}))?.messageName ?? "",
				chatId: space
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, replyToId, threadId }) => {
			if (!mediaUrl) {throw new Error("Google Chat mediaUrl is required.");}
			const account = resolveGoogleChatAccount({
				cfg,
				accountId
			});
			const space = await resolveGoogleChatOutboundSpace({
				account,
				target: to
			});
			const thread = threadId ?? replyToId ?? void 0;
			const runtime = getGoogleChatRuntime();
			const effectiveMaxBytes = resolveChannelMediaMaxBytes({
				cfg,
				resolveChannelLimitMb: ({ cfg, accountId }) => (cfg.channels?.["googlechat"])?.accounts?.[accountId]?.mediaMaxMb ?? (cfg.channels?.["googlechat"])?.mediaMaxMb,
				accountId
			}) ?? (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
			const loaded = /^https?:\/\//i.test(mediaUrl) ? await runtime.channel.media.fetchRemoteMedia({
				url: mediaUrl,
				maxBytes: effectiveMaxBytes
			}) : await runtime.media.loadWebMedia(mediaUrl, {
				maxBytes: effectiveMaxBytes,
				localRoots: mediaLocalRoots?.length ? mediaLocalRoots : void 0
			});
			const { sendGoogleChatMessage, uploadGoogleChatAttachment } = await loadGoogleChatChannelRuntime();
			const upload = await uploadGoogleChatAttachment({
				account,
				space,
				filename: loaded.fileName ?? "attachment",
				buffer: loaded.buffer,
				contentType: loaded.contentType
			});
			return {
				channel: "googlechat",
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
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null
		},
		collectStatusIssues: (accounts) => accounts.flatMap((entry) => {
			const accountId = String(entry.accountId ?? "default");
			const enabled = entry.enabled !== false;
			const configured = entry.configured === true;
			if (!enabled || !configured) {return [];}
			const issues = [];
			if (!entry.audience) {issues.push({
				channel: "googlechat",
				accountId,
				kind: "config",
				message: "Google Chat audience is missing (set channels.googlechat.audience).",
				fix: "Set channels.googlechat.audienceType and channels.googlechat.audience."
			});}
			if (!entry.audienceType) {issues.push({
				channel: "googlechat",
				accountId,
				kind: "config",
				message: "Google Chat audienceType is missing (app-url or project-number).",
				fix: "Set channels.googlechat.audienceType and channels.googlechat.audience."
			});}
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
		buildAccountSnapshot: ({ account, runtime, probe }) => {
			return {
				...buildComputedAccountStatusSnapshot({
					accountId: account.accountId,
					name: account.name,
					enabled: account.enabled,
					configured: account.credentialSource !== "none",
					runtime,
					probe
				}),
				credentialSource: account.credentialSource,
				audienceType: account.config.audienceType,
				audience: account.config.audience,
				webhookPath: account.config.webhookPath,
				webhookUrl: account.config.webhookUrl,
				dmPolicy: account.config.dm?.policy ?? "pairing"
			};
		}
	},
	gateway: { startAccount: async (ctx) => {
		const account = ctx.account;
		const statusSink = createAccountStatusSink({
			accountId: account.accountId,
			setStatus: ctx.setStatus
		});
		ctx.log?.info(`[${account.accountId}] starting Google Chat webhook`);
		const { resolveGoogleChatWebhookPath, startGoogleChatMonitor } = await loadGoogleChatChannelRuntime();
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
	} }
};
//#endregion
export { googlechatPlugin as t };
