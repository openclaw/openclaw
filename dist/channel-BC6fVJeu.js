import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { b as sendPayloadWithChunkedTextAndMedia, l as isNumericTargetId } from "./reply-payload-DMPQsrQC.js";
import { r as createLazyRuntimeModule } from "./lazy-runtime-D-7_JraP.js";
import { l as createScopedDmSecurityResolver } from "./channel-config-helpers-xZ4-bv2H.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as createStaticReplyToModeResolver } from "./threading-helpers-JSVFlQzA.js";
import { i as createChatChannelPlugin } from "./core-kXuNbs5U.js";
import "./channel-core-CV-k5W6W.js";
import { t as createAccountStatusSink } from "./channel-lifecycle.core-CDt0hRZR.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-jjAiM0PK.js";
import "./conversation-runtime-guwDSNIo.js";
import { t as chunkTextForOutbound } from "./text-chunking-C154U6-i.js";
import { d as createDefaultChannelRuntimeState, l as createAsyncComputedAccountStatusAdapter } from "./status-helpers-CnvYAK73.js";
import { a as coerceStatusIssueAccountId, d as readStatusIssueFields, n as buildPassiveProbedChannelStatusSummary } from "./extension-shared-DSIp8QS_.js";
import "./channel-lifecycle-B7VOl7bW.js";
import { r as defineChannelMessageAdapter } from "./channel-message-DMGbyII_.js";
import { i as createPairingPrefixStripper } from "./channel-pairing-N4dBc-K-.js";
import { a as createEmptyChannelResult, o as createRawChannelSendResultAdapter } from "./channel-send-result-swFdRKhg.js";
import { a as resolveZalouserAccountSync, i as resolveDefaultZalouserAccountId, r as listZalouserAccountIds, t as checkZcaAuthenticated } from "./accounts-BM0qCh20.js";
import { t as createZalouserPluginBase } from "./shared-D7bv1QJU.js";
import { a as resolveZalouserReactionMessageIds, o as buildZalouserGroupCandidates, s as findZalouserGroupEntry, t as getZalouserRuntime } from "./runtime-lnIj-JW9.js";
import { n as zalouserSetupAdapter, r as writeQrDataUrlToTempFile, t as createZalouserSetupWizardProxy } from "./setup-core-SEVjHNaY.js";
import { i as resolveZalouserOutboundSessionRoute, n as parseZalouserDirectoryGroupId, r as parseZalouserOutboundTarget, t as normalizeZalouserTarget } from "./session-route-DAeVMQTr.js";
//#region extensions/zalouser/src/channel.adapters.ts
const loadZalouserChannelRuntime$1 = createLazyRuntimeModule(() => import("./channel.runtime-COAIVDmZ.js"));
const ZALOUSER_TEXT_CHUNK_LIMIT = 2e3;
function resolveZalouserQrProfile(accountId) {
	const normalized = normalizeAccountId(accountId);
	if (!normalized || normalized === "default") return process.env.ZALOUSER_PROFILE?.trim() || process.env.ZCA_PROFILE?.trim() || "default";
	return normalized;
}
function resolveZalouserOutboundChunkMode(cfg, accountId) {
	return getZalouserRuntime().channel.text.resolveChunkMode(cfg, "zalouser", accountId);
}
function resolveZalouserOutboundTextChunkLimit(cfg, accountId) {
	return getZalouserRuntime().channel.text.resolveTextChunkLimit(cfg, "zalouser", accountId, { fallbackLimit: ZALOUSER_TEXT_CHUNK_LIMIT });
}
function resolveZalouserGroupPolicyEntry(params) {
	const account = resolveZalouserAccountSync({
		cfg: params.cfg,
		accountId: params.accountId ?? void 0
	});
	return findZalouserGroupEntry(account.config.groups ?? {}, buildZalouserGroupCandidates({
		groupId: params.groupId,
		groupChannel: params.groupChannel,
		includeWildcard: true,
		allowNameMatching: isDangerousNameMatchingEnabled(account.config)
	}));
}
function resolveZalouserGroupToolPolicy(params) {
	return resolveZalouserGroupPolicyEntry(params)?.tools;
}
function resolveZalouserRequireMention(params) {
	const entry = resolveZalouserGroupPolicyEntry(params);
	if (typeof entry?.requireMention === "boolean") return entry.requireMention;
	return true;
}
async function sendZalouserTextFromContext({ to, text, accountId, cfg }) {
	const { sendMessageZalouser } = await loadZalouserChannelRuntime$1();
	const account = resolveZalouserAccountSync({
		cfg,
		accountId
	});
	const target = parseZalouserOutboundTarget(to);
	return await sendMessageZalouser(target.threadId, text, {
		profile: account.profile,
		isGroup: target.isGroup,
		textMode: "markdown",
		textChunkMode: resolveZalouserOutboundChunkMode(cfg, account.accountId),
		textChunkLimit: resolveZalouserOutboundTextChunkLimit(cfg, account.accountId)
	});
}
async function sendZalouserMediaFromContext({ to, text, mediaUrl, accountId, cfg, mediaLocalRoots, mediaReadFile }) {
	const { sendMessageZalouser } = await loadZalouserChannelRuntime$1();
	const account = resolveZalouserAccountSync({
		cfg,
		accountId
	});
	const target = parseZalouserOutboundTarget(to);
	return await sendMessageZalouser(target.threadId, text, {
		profile: account.profile,
		isGroup: target.isGroup,
		mediaUrl,
		mediaLocalRoots,
		mediaReadFile,
		textMode: "markdown",
		textChunkMode: resolveZalouserOutboundChunkMode(cfg, account.accountId),
		textChunkLimit: resolveZalouserOutboundTextChunkLimit(cfg, account.accountId)
	});
}
const zalouserRawSendResultAdapter = createRawChannelSendResultAdapter({
	channel: "zalouser",
	sendText: sendZalouserTextFromContext,
	sendMedia: sendZalouserMediaFromContext
});
const zalouserMessageAdapter = defineChannelMessageAdapter({
	id: "zalouser",
	durableFinal: { capabilities: {
		text: true,
		media: true,
		messageSendingHooks: true
	} },
	send: {
		text: sendZalouserTextFromContext,
		media: sendZalouserMediaFromContext
	}
});
const resolveZalouserDmPolicy = createScopedDmSecurityResolver({
	channelKey: "zalouser",
	resolvePolicy: (account) => account.config.dmPolicy,
	resolveAllowFrom: (account) => account.config.allowFrom,
	policyPathSuffix: "dmPolicy",
	normalizeEntry: (raw) => raw.trim().replace(/^(zalouser|zlu):/i, "")
});
const zalouserGroupsAdapter = {
	resolveRequireMention: resolveZalouserRequireMention,
	resolveToolPolicy: resolveZalouserGroupToolPolicy
};
const zalouserMessageActions = {
	describeMessageTool: ({ cfg, accountId }) => {
		if ((accountId ? [resolveZalouserAccountSync({
			cfg,
			accountId
		})].filter((account) => account.enabled) : listZalouserAccountIds(cfg).map((resolvedAccountId) => resolveZalouserAccountSync({
			cfg,
			accountId: resolvedAccountId
		})).filter((account) => account.enabled)).length === 0) return null;
		return { actions: ["react"] };
	},
	supportsAction: ({ action }) => action === "react",
	handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
		if (action !== "react") throw new Error(`Zalouser action ${action} not supported`);
		const { sendReactionZalouser } = await loadZalouserChannelRuntime$1();
		const account = resolveZalouserAccountSync({
			cfg,
			accountId
		});
		const threadId = (typeof params.threadId === "string" ? params.threadId.trim() : "") || (typeof params.to === "string" ? params.to.trim() : "") || (typeof params.chatId === "string" ? params.chatId.trim() : "") || (toolContext?.currentChannelId?.trim() ?? "");
		if (!threadId) throw new Error("Zalouser react requires threadId (or to/chatId).");
		const emoji = typeof params.emoji === "string" ? params.emoji.trim() : "";
		if (!emoji) throw new Error("Zalouser react requires emoji.");
		const ids = resolveZalouserReactionMessageIds({
			messageId: typeof params.messageId === "string" ? params.messageId : void 0,
			cliMsgId: typeof params.cliMsgId === "string" ? params.cliMsgId : void 0,
			currentMessageId: toolContext?.currentMessageId
		});
		if (!ids) throw new Error("Zalouser react requires messageId + cliMsgId (or a current message context id).");
		const result = await sendReactionZalouser({
			profile: account.profile,
			threadId,
			isGroup: params.isGroup === true,
			msgId: ids.msgId,
			cliMsgId: ids.cliMsgId,
			emoji,
			remove: params.remove === true
		});
		if (!result.ok) throw new Error(result.error || "Failed to react on Zalo message");
		return {
			content: [{
				type: "text",
				text: params.remove === true ? `Removed reaction ${emoji} from ${ids.msgId}` : `Reacted ${emoji} on ${ids.msgId}`
			}],
			details: {
				messageId: ids.msgId,
				cliMsgId: ids.cliMsgId,
				threadId
			}
		};
	}
};
const zalouserResolverAdapter = { resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) => {
	const results = [];
	for (const input of inputs) {
		const trimmed = input.trim();
		if (!trimmed) {
			results.push({
				input,
				resolved: false,
				note: "empty input"
			});
			continue;
		}
		if (/^\d+$/.test(trimmed)) {
			results.push({
				input,
				resolved: true,
				id: trimmed
			});
			continue;
		}
		try {
			const runtimeModule = await loadZalouserChannelRuntime$1();
			const account = resolveZalouserAccountSync({
				cfg,
				accountId: accountId ?? resolveDefaultZalouserAccountId(cfg)
			});
			if (kind === "user") {
				const friends = await runtimeModule.listZaloFriendsMatching(account.profile, trimmed);
				const best = friends[0];
				results.push({
					input,
					resolved: Boolean(best?.userId),
					id: best?.userId,
					name: best?.displayName,
					note: friends.length > 1 ? "multiple matches; chose first" : void 0
				});
			} else {
				const groups = await runtimeModule.listZaloGroupsMatching(account.profile, trimmed);
				const best = groups.find((group) => normalizeLowercaseStringOrEmpty(group.name) === normalizeLowercaseStringOrEmpty(trimmed)) ?? groups[0];
				results.push({
					input,
					resolved: Boolean(best?.groupId),
					id: best?.groupId,
					name: best?.name,
					note: groups.length > 1 ? "multiple matches; chose first" : void 0
				});
			}
		} catch (err) {
			runtime.error?.(`zalouser resolve failed: ${String(err)}`);
			results.push({
				input,
				resolved: false,
				note: "lookup failed"
			});
		}
	}
	return results;
} };
const zalouserAuthAdapter = { login: async ({ cfg, accountId, runtime }) => {
	const { startZaloQrLogin, waitForZaloQrLogin } = await loadZalouserChannelRuntime$1();
	const account = resolveZalouserAccountSync({
		cfg,
		accountId: accountId ?? resolveDefaultZalouserAccountId(cfg)
	});
	runtime.log(`Generating QR login for Zalo Personal (account: ${account.accountId}, profile: ${account.profile})...`);
	const started = await startZaloQrLogin({
		profile: account.profile,
		timeoutMs: 35e3
	});
	if (!started.qrDataUrl) throw new Error(started.message || "Failed to start QR login");
	const qrPath = await writeQrDataUrlToTempFile(started.qrDataUrl, account.profile);
	if (qrPath) runtime.log(`Scan QR image: ${qrPath}`);
	else runtime.log("QR generated but could not be written to a temp file.");
	const waited = await waitForZaloQrLogin({
		profile: account.profile,
		timeoutMs: 18e4
	});
	if (!waited.connected) throw new Error(waited.message || "Zalouser login failed");
	runtime.log(waited.message);
} };
const zalouserSecurityAdapter = {
	resolveDmPolicy: resolveZalouserDmPolicy,
	collectAuditFindings: async (params) => (await loadZalouserChannelRuntime$1()).collectZalouserSecurityAuditFindings(params)
};
const zalouserThreadingAdapter = { resolveReplyToMode: createStaticReplyToModeResolver("off") };
const zalouserPairingTextAdapter = {
	idLabel: "zalouserUserId",
	message: "Your pairing request has been approved.",
	normalizeAllowEntry: createPairingPrefixStripper(/^(zalouser|zlu):/i),
	notify: async ({ cfg, id, message }) => {
		const { sendMessageZalouser } = await loadZalouserChannelRuntime$1();
		const account = resolveZalouserAccountSync({ cfg });
		if (!await checkZcaAuthenticated(account.profile)) throw new Error("Zalouser not authenticated");
		await sendMessageZalouser(id, message, { profile: account.profile });
	}
};
const zalouserOutboundAdapter = {
	deliveryMode: "direct",
	chunker: chunkTextForOutbound,
	chunkerMode: "markdown",
	sendPayload: async (ctx) => await sendPayloadWithChunkedTextAndMedia({
		ctx,
		sendText: (nextCtx) => zalouserRawSendResultAdapter.sendText(nextCtx),
		sendMedia: (nextCtx) => zalouserRawSendResultAdapter.sendMedia(nextCtx),
		emptyResult: createEmptyChannelResult("zalouser")
	}),
	...zalouserRawSendResultAdapter
};
const zalouserMessagingAdapter = {
	targetPrefixes: ["zalouser", "zlu"],
	normalizeTarget: (raw) => normalizeZalouserTarget(raw),
	resolveOutboundSessionRoute: (params) => resolveZalouserOutboundSessionRoute(params),
	targetResolver: {
		looksLikeId: (raw) => {
			const normalized = normalizeZalouserTarget(raw);
			if (!normalized) return false;
			if (/^group:[^\s]+$/i.test(normalized) || /^user:[^\s]+$/i.test(normalized)) return true;
			return isNumericTargetId(normalized);
		},
		hint: "<user:id|group:id>"
	}
};
//#endregion
//#region extensions/zalouser/src/directory.ts
function mapUser$1(params) {
	return {
		kind: "user",
		id: params.id,
		name: params.name ?? void 0,
		avatarUrl: params.avatarUrl ?? void 0,
		raw: params.raw
	};
}
async function listZalouserDirectoryGroupMembers(params, deps) {
	const account = resolveZalouserAccountSync({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const normalizedGroupId = parseZalouserDirectoryGroupId(params.groupId);
	const rows = (await deps.listZaloGroupMembers(account.profile, normalizedGroupId)).map((member) => mapUser$1({
		id: member.userId,
		name: member.displayName,
		avatarUrl: member.avatar ?? null,
		raw: member
	}));
	return typeof params.limit === "number" && params.limit > 0 ? rows.slice(0, params.limit) : rows;
}
//#endregion
//#region extensions/zalouser/src/status-issues.ts
const ZALOUSER_STATUS_FIELDS = [
	"accountId",
	"enabled",
	"configured",
	"dmPolicy",
	"lastError"
];
function collectZalouserStatusIssues(accounts) {
	const issues = [];
	for (const entry of accounts) {
		const account = readStatusIssueFields(entry, ZALOUSER_STATUS_FIELDS);
		if (!account) continue;
		const accountId = coerceStatusIssueAccountId(account.accountId) ?? "default";
		if (!(account.enabled !== false)) continue;
		if (!(account.configured === true)) {
			issues.push({
				channel: "zalouser",
				accountId,
				kind: "auth",
				message: "Not authenticated (no saved Zalo session).",
				fix: "Run: openclaw channels login --channel zalouser"
			});
			continue;
		}
		if (account.dmPolicy === "open") issues.push({
			channel: "zalouser",
			accountId,
			kind: "config",
			message: "Zalo Personal dmPolicy is \"open\", allowing any user to message the bot without pairing.",
			fix: "Set channels.zalouser.dmPolicy to \"pairing\" or \"allowlist\" to restrict access."
		});
	}
	return issues;
}
//#endregion
//#region extensions/zalouser/src/channel.ts
const loadZalouserChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime-COAIVDmZ.js"));
const zalouserSetupWizardProxy = createZalouserSetupWizardProxy(async () => (await import("./setup-surface-CWxVZno0.js")).zalouserSetupWizard);
function mapUser(params) {
	return {
		kind: "user",
		id: params.id,
		name: params.name ?? void 0,
		avatarUrl: params.avatarUrl ?? void 0,
		raw: params.raw
	};
}
function mapGroup(params) {
	return {
		kind: "group",
		id: params.id,
		name: params.name ?? void 0,
		raw: params.raw
	};
}
const zalouserPlugin = createChatChannelPlugin({
	base: {
		...createZalouserPluginBase({
			setupWizard: zalouserSetupWizardProxy,
			setup: zalouserSetupAdapter
		}),
		groups: zalouserGroupsAdapter,
		actions: zalouserMessageActions,
		messaging: zalouserMessagingAdapter,
		directory: {
			self: async ({ cfg, accountId }) => {
				const { getZaloUserInfo } = await loadZalouserChannelRuntime();
				const parsed = await getZaloUserInfo(resolveZalouserAccountSync({
					cfg,
					accountId
				}).profile);
				if (!parsed?.userId) return null;
				return mapUser({
					id: parsed.userId,
					name: parsed.displayName ?? null,
					avatarUrl: parsed.avatar ?? null,
					raw: parsed
				});
			},
			listPeers: async ({ cfg, accountId, query, limit }) => {
				const { listZaloFriendsMatching } = await loadZalouserChannelRuntime();
				const rows = (await listZaloFriendsMatching(resolveZalouserAccountSync({
					cfg,
					accountId
				}).profile, query)).map((friend) => mapUser({
					id: friend.userId,
					name: friend.displayName ?? null,
					avatarUrl: friend.avatar ?? null,
					raw: friend
				}));
				return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
			},
			listGroups: async ({ cfg, accountId, query, limit }) => {
				const { listZaloGroupsMatching } = await loadZalouserChannelRuntime();
				const rows = (await listZaloGroupsMatching(resolveZalouserAccountSync({
					cfg,
					accountId
				}).profile, query)).map((group) => mapGroup({
					id: `group:${group.groupId}`,
					name: group.name ?? null,
					raw: group
				}));
				return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
			},
			listGroupMembers: async ({ cfg, accountId, groupId, limit }) => {
				const { listZaloGroupMembers } = await loadZalouserChannelRuntime();
				return await listZalouserDirectoryGroupMembers({
					cfg,
					accountId: accountId ?? void 0,
					groupId,
					limit: limit ?? void 0
				}, { listZaloGroupMembers });
			}
		},
		resolver: zalouserResolverAdapter,
		auth: zalouserAuthAdapter,
		message: zalouserMessageAdapter,
		status: createAsyncComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			collectStatusIssues: collectZalouserStatusIssues,
			buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot),
			probeAccount: async ({ account, timeoutMs }) => (await loadZalouserChannelRuntime()).probeZalouser(account.profile, timeoutMs),
			resolveAccountSnapshot: async ({ account, runtime }) => {
				const configured = await checkZcaAuthenticated(account.profile);
				return {
					accountId: account.accountId,
					name: account.name,
					enabled: account.enabled,
					configured,
					extra: {
						dmPolicy: account.config.dmPolicy ?? "pairing",
						lastError: configured ? runtime?.lastError ?? null : runtime?.lastError ?? "not authenticated"
					}
				};
			}
		}),
		gateway: {
			startAccount: async (ctx) => {
				const { getZaloUserInfo } = await loadZalouserChannelRuntime();
				const account = ctx.account;
				let userLabel = "";
				try {
					const userInfo = await getZaloUserInfo(account.profile);
					if (userInfo?.displayName) userLabel = ` (${userInfo.displayName})`;
					ctx.setStatus({
						accountId: account.accountId,
						profile: userInfo
					});
				} catch {}
				const statusSink = createAccountStatusSink({
					accountId: ctx.accountId,
					setStatus: ctx.setStatus
				});
				ctx.log?.info(`[${account.accountId}] starting zalouser provider${userLabel}`);
				const { monitorZalouserProvider } = await import("./monitor-Dv-BaoJn.js");
				return monitorZalouserProvider({
					account,
					config: ctx.cfg,
					runtime: ctx.runtime,
					abortSignal: ctx.abortSignal,
					statusSink
				});
			},
			loginWithQrStart: async (params) => {
				const { startZaloQrLogin } = await loadZalouserChannelRuntime();
				return await startZaloQrLogin({
					profile: resolveZalouserQrProfile(params.accountId),
					force: params.force,
					timeoutMs: params.timeoutMs
				});
			},
			loginWithQrWait: async (params) => {
				const { waitForZaloQrLogin } = await loadZalouserChannelRuntime();
				return await waitForZaloQrLogin({
					profile: resolveZalouserQrProfile(params.accountId),
					timeoutMs: params.timeoutMs
				});
			},
			logoutAccount: async (ctx) => await (await loadZalouserChannelRuntime()).logoutZaloProfile(ctx.account.profile || resolveZalouserQrProfile(ctx.accountId))
		}
	},
	security: zalouserSecurityAdapter,
	threading: zalouserThreadingAdapter,
	pairing: { text: zalouserPairingTextAdapter },
	outbound: zalouserOutboundAdapter
});
//#endregion
export { zalouserPlugin as t };
