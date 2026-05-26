import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-CwBWagLE.js";
import { r as GoogleChatConfigSchema } from "./zod-schema.providers-whatsapp-BElo3xB4.js";
import { r as buildChannelConfigSchema } from "./config-schema-DftNRjDz.js";
import { i as createLazyRuntimeNamedExport } from "./lazy-runtime-Dh47Iq4d.js";
import { r as fetchRemoteMedia } from "./fetch-zuIYqxzf.js";
import { n as resolveChannelGroupRequireMention } from "./group-policy-DONyxmU9.js";
import { n as missingTargetError } from "./target-errors-CmqeSC1U.js";
import { t as sanitizeForPlainText } from "./sanitize-text-QuMt6r4k.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-C-liHImJ.js";
import { s as createScopedChannelConfigAdapter, t as adaptScopedAccountAccessor } from "./channel-config-helpers-Dzal6cfS.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { n as describeAccountSnapshot } from "./account-helpers-Ba4hZbOH.js";
import { i as createChatChannelPlugin } from "./core-BPnS_bab.js";
import "./channel-core-BoAjH-Jl.js";
import { i as runPassiveAccountLifecycle, t as createAccountStatusSink } from "./channel-lifecycle.core-2s7owtO-.js";
import { n as formatNormalizedAllowFromEntries } from "./allow-from-CFKhmZbv.js";
import { _ as createAllowlistProviderOpenWarningCollector, m as composeAccountWarningCollectors, n as createDangerousNameMatchingMutableAllowlistWarningCollector } from "./channel-policy-DorgJeIC.js";
import { t as createChannelDirectoryAdapter } from "./directory-runtime-zNq6TUqB.js";
import { f as listResolvedDirectoryGroupEntriesFromMapKeys, p as listResolvedDirectoryUserEntriesFromAllowFrom } from "./directory-config-helpers-DE5wfd2q.js";
import { t as resolveApprovalApprovers } from "./approval-approvers-CU1TPzr2.js";
import { t as createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers-7oBaTEgH.js";
import { t as loadOutboundMediaFromUrl } from "./outbound-media-BTsScThx.js";
import "./outbound-runtime-HTtq1b9m.js";
import { a as resolveChannelMediaMaxBytes } from "./media-runtime-DWh6m_8p.js";
import { t as chunkTextForOutbound } from "./text-chunking-3_9rfiI8.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./pairing-message-C5_Dm1pD.js";
import { d as createDefaultChannelRuntimeState, u as createComputedAccountStatusAdapter } from "./status-helpers-Dk-3BT6p.js";
import { n as buildPassiveProbedChannelStatusSummary } from "./extension-shared-BznPIa-o.js";
import "./channel-lifecycle-BrKB268B.js";
import { r as defineChannelMessageAdapter } from "./channel-message-CmG6T1ry.js";
import { t as extractToolSend } from "./tool-send-BuLLZYYU.js";
import { a as resolveGoogleChatConfigAccessorAccount, i as resolveGoogleChatAccount, n as listGoogleChatAccountIds, r as resolveDefaultGoogleChatAccountId } from "./accounts-BXtoSQY_.js";
import "./runtime-api-Dm__ZuhP.js";
import { i as resolveGoogleChatOutboundSpace, n as isGoogleChatUserTarget, r as normalizeGoogleChatTarget, t as isGoogleChatSpaceTarget } from "./targets-DlrVhQZe.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "./doctor-contract-DsirpgUS.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "./secret-contract-fr7k4Bly.js";
import { n as googlechatSetupAdapter, t as googlechatSetupWizard } from "./setup-surface-D_1WIwcf.js";
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
const loadGoogleChatChannelRuntime$2 = createLazyRuntimeNamedExport(() => import("./channel.runtime-BPrPyRl7.js"), "googleChatChannelRuntime");
function createGoogleChatSendReceipt(params) {
	const messageId = params.messageId?.trim();
	return createMessageReceiptFromOutboundResults({
		results: messageId ? [{
			channel: "googlechat",
			messageId,
			chatId: params.chatId,
			conversationId: params.chatId
		}] : [],
		threadId: params.chatId,
		kind: params.kind
	});
}
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
			const messageId = (await sendGoogleChatMessage({
				account,
				space,
				text,
				thread
			}))?.messageName ?? "";
			return {
				messageId,
				chatId: space,
				receipt: createGoogleChatSendReceipt({
					messageId,
					chatId: space,
					kind: "text"
				})
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
			const messageId = (await sendGoogleChatMessage({
				account,
				space,
				text,
				thread,
				attachments: upload.attachmentUploadToken ? [{
					attachmentUploadToken: upload.attachmentUploadToken,
					contentName: loaded.fileName
				}] : void 0
			}))?.messageName ?? "";
			return {
				messageId,
				chatId: space,
				receipt: createGoogleChatSendReceipt({
					messageId,
					chatId: space,
					kind: "media"
				})
			};
		}
	}
};
const googlechatMessageAdapter = defineChannelMessageAdapter({
	id: "googlechat",
	durableFinal: { capabilities: {
		text: true,
		media: true,
		thread: true,
		messageSendingHooks: true
	} },
	send: {
		text: googlechatOutboundAdapter.attachedResults.sendText,
		media: googlechatOutboundAdapter.attachedResults.sendMedia
	}
});
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
const loadGoogleChatChannelRuntime$1 = createLazyRuntimeNamedExport(() => import("./channel.runtime-BPrPyRl7.js"), "googleChatChannelRuntime");
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
const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(() => import("./channel.runtime-BPrPyRl7.js"), "googleChatChannelRuntime");
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
	describeMessageTool: ({ cfg, accountId }) => {
		const accounts = accountId ? [resolveGoogleChatAccount({
			cfg,
			accountId
		})].filter((account) => account.enabled && account.credentialSource !== "none") : listGoogleChatAccountIds(cfg).map((id) => resolveGoogleChatAccount({
			cfg,
			accountId: id
		})).filter((account) => account.enabled && account.credentialSource !== "none");
		if (accounts.length === 0) return null;
		const actions = new Set(["send", "upload-file"]);
		if (accounts.some((account) => account.config.actions?.reactions !== false)) {
			actions.add("react");
			actions.add("reactions");
		}
		return { actions: Array.from(actions) };
	},
	extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
	handleAction: async (ctx) => {
		const { googlechatMessageActions } = await import("./actions-CknyQ3PP.js");
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
		message: googlechatMessageAdapter,
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
