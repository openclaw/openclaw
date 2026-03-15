import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { En as DmPolicySchema, Fn as MarkdownConfigSchema, _n as setAccountEnabledInConfigSection, bn as buildChannelConfigSchema, fn as buildAccountScopedDmSecurityPolicy, gn as deleteAccountFromConfigSection, kn as GroupPolicySchema, vn as AllowFromListSchema, yn as buildCatchallMultiAccountChannelSchema } from "./resolve-route-BZ4hHpx2.js";
import { t as createAccountStatusSink } from "./channel-lifecycle-h2DwjEdV.js";
import { Cp as mapAllowFromEntries, Lu as buildBaseAccountStatusSnapshot, Sf as ToolPolicySchema, bt as formatAllowFromLowercase } from "./auth-profiles-CuJtivJK.js";
import { _ as buildChannelSendResult, f as sendPayloadWithChunkedTextAndMedia, l as isNumericTargetId } from "./compat-DDXNEdAm.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-CHxlFG8H.js";
import { n as buildPassiveProbedChannelStatusSummary } from "./channel-status-summary-C_aBM2lc.js";
import { n as readStatusIssueFields, t as coerceStatusIssueAccountId } from "./status-issues-DNlG8ziq.js";
import { A as startZaloQrLogin, C as listZaloFriendsMatching, D as logoutZaloProfile, E as listZaloGroupsMatching, M as getZalouserRuntime, P as zalouserSetupAdapter, _ as listZalouserAccountIds, a as sendReactionZalouser, b as checkZaloAuthenticated, d as buildZalouserGroupCandidates, f as findZalouserGroupEntry, g as getZcaUserInfo, h as writeQrDataUrlToTempFile, i as sendMessageZalouser, j as waitForZaloQrLogin, m as zalouserSetupWizard, u as resolveZalouserReactionMessageIds, v as resolveDefaultZalouserAccountId, w as listZaloGroupMembers, x as getZaloUserInfo, y as resolveZalouserAccountSync } from "./send-BhRqDvr62.js";
import { z } from "zod";
//#region extensions/zalouser/src/config-schema.ts
const groupConfigSchema = z.object({
	allow: z.boolean().optional(),
	enabled: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema
});
const ZalouserConfigSchema = buildCatchallMultiAccountChannelSchema(z.object({
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	profile: z.string().optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: AllowFromListSchema,
	historyLimit: z.number().int().min(0).optional(),
	groupAllowFrom: AllowFromListSchema,
	groupPolicy: GroupPolicySchema.optional(),
	groups: z.object({}).catchall(groupConfigSchema).optional(),
	messagePrefix: z.string().optional(),
	responsePrefix: z.string().optional()
}));
//#endregion
//#region extensions/zalouser/src/probe.ts
async function probeZalouser(profile, timeoutMs) {
	try {
		const user = timeoutMs ? await Promise.race([getZaloUserInfo(profile), new Promise((resolve) => setTimeout(() => resolve(null), Math.max(timeoutMs, 1e3)))]) : await getZaloUserInfo(profile);
		if (!user) {return {
			ok: false,
			error: "Not authenticated"
		};}
		return {
			ok: true,
			user
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
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
		if (!account) {continue;}
		const accountId = coerceStatusIssueAccountId(account.accountId) ?? "default";
		if (!(account.enabled !== false)) {continue;}
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
		if (account.dmPolicy === "open") {issues.push({
			channel: "zalouser",
			accountId,
			kind: "config",
			message: "Zalo Personal dmPolicy is \"open\", allowing any user to message the bot without pairing.",
			fix: "Set channels.zalouser.dmPolicy to \"pairing\" or \"allowlist\" to restrict access."
		});}
	}
	return issues;
}
//#endregion
//#region extensions/zalouser/src/channel.ts
const meta = {
	id: "zalouser",
	label: "Zalo Personal",
	selectionLabel: "Zalo (Personal Account)",
	docsPath: "/channels/zalouser",
	docsLabel: "zalouser",
	blurb: "Zalo personal account via QR code login.",
	aliases: ["zlu"],
	order: 85,
	quickstartAllowFrom: true
};
const ZALOUSER_TEXT_CHUNK_LIMIT = 2e3;
function stripZalouserTargetPrefix(raw) {
	return raw.trim().replace(/^(zalouser|zlu):/i, "").trim();
}
function normalizePrefixedTarget(raw) {
	const trimmed = stripZalouserTargetPrefix(raw);
	if (!trimmed) {return;}
	const lower = trimmed.toLowerCase();
	if (lower.startsWith("group:")) {
		const id = trimmed.slice(6).trim();
		return id ? `group:${id}` : void 0;
	}
	if (lower.startsWith("g:")) {
		const id = trimmed.slice(2).trim();
		return id ? `group:${id}` : void 0;
	}
	if (lower.startsWith("user:")) {
		const id = trimmed.slice(5).trim();
		return id ? `user:${id}` : void 0;
	}
	if (lower.startsWith("dm:")) {
		const id = trimmed.slice(3).trim();
		return id ? `user:${id}` : void 0;
	}
	if (lower.startsWith("u:")) {
		const id = trimmed.slice(2).trim();
		return id ? `user:${id}` : void 0;
	}
	if (/^g-\S+$/i.test(trimmed)) {return `group:${trimmed}`;}
	if (/^u-\S+$/i.test(trimmed)) {return `user:${trimmed}`;}
	return trimmed;
}
function parseZalouserOutboundTarget(raw) {
	const normalized = normalizePrefixedTarget(raw);
	if (!normalized) {throw new Error("Zalouser target is required");}
	const lowered = normalized.toLowerCase();
	if (lowered.startsWith("group:")) {
		const threadId = normalized.slice(6).trim();
		if (!threadId) {throw new Error("Zalouser group target is missing group id");}
		return {
			threadId,
			isGroup: true
		};
	}
	if (lowered.startsWith("user:")) {
		const threadId = normalized.slice(5).trim();
		if (!threadId) {throw new Error("Zalouser user target is missing user id");}
		return {
			threadId,
			isGroup: false
		};
	}
	return {
		threadId: normalized,
		isGroup: false
	};
}
function parseZalouserDirectoryGroupId(raw) {
	const normalized = normalizePrefixedTarget(raw);
	if (!normalized) {throw new Error("Zalouser group target is required");}
	const lowered = normalized.toLowerCase();
	if (lowered.startsWith("group:")) {
		const groupId = normalized.slice(6).trim();
		if (!groupId) {throw new Error("Zalouser group target is missing group id");}
		return groupId;
	}
	if (lowered.startsWith("user:")) {throw new Error("Zalouser group members lookup requires a group target (group:<id>)");}
	return normalized;
}
function resolveZalouserQrProfile(accountId) {
	const normalized = normalizeAccountId(accountId);
	if (!normalized || normalized === "default") {return process.env.ZALOUSER_PROFILE?.trim() || process.env.ZCA_PROFILE?.trim() || "default";}
	return normalized;
}
function resolveZalouserOutboundChunkMode(cfg, accountId) {
	return getZalouserRuntime().channel.text.resolveChunkMode(cfg, "zalouser", accountId);
}
function resolveZalouserOutboundTextChunkLimit(cfg, accountId) {
	return getZalouserRuntime().channel.text.resolveTextChunkLimit(cfg, "zalouser", accountId, { fallbackLimit: ZALOUSER_TEXT_CHUNK_LIMIT });
}
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
	if (typeof entry?.requireMention === "boolean") {return entry.requireMention;}
	return true;
}
const zalouserPlugin = {
	id: "zalouser",
	meta,
	setup: zalouserSetupAdapter,
	setupWizard: zalouserSetupWizard,
	capabilities: {
		chatTypes: ["direct", "group"],
		media: true,
		reactions: true,
		threads: false,
		polls: false,
		nativeCommands: false,
		blockStreaming: true
	},
	reload: { configPrefixes: ["channels.zalouser"] },
	configSchema: buildChannelConfigSchema(ZalouserConfigSchema),
	config: {
		listAccountIds: (cfg) => listZalouserAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveZalouserAccountSync({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultZalouserAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
			cfg,
			sectionKey: "zalouser",
			accountId,
			enabled,
			allowTopLevel: true
		}),
		deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
			cfg,
			sectionKey: "zalouser",
			accountId,
			clearBaseFields: [
				"profile",
				"name",
				"dmPolicy",
				"allowFrom",
				"historyLimit",
				"groupAllowFrom",
				"groupPolicy",
				"groups",
				"messagePrefix"
			]
		}),
		isConfigured: async (account) => await checkZaloAuthenticated(account.profile),
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: void 0
		}),
		resolveAllowFrom: ({ cfg, accountId }) => mapAllowFromEntries(resolveZalouserAccountSync({
			cfg,
			accountId
		}).config.allowFrom),
		formatAllowFrom: ({ allowFrom }) => formatAllowFromLowercase({
			allowFrom,
			stripPrefixRe: /^(zalouser|zlu):/i
		})
	},
	security: { resolveDmPolicy: ({ cfg, accountId, account }) => {
		return buildAccountScopedDmSecurityPolicy({
			cfg,
			channelKey: "zalouser",
			accountId,
			fallbackAccountId: account.accountId ?? "default",
			policy: account.config.dmPolicy,
			allowFrom: account.config.allowFrom ?? [],
			policyPathSuffix: "dmPolicy",
			normalizeEntry: (raw) => raw.replace(/^(zalouser|zlu):/i, "")
		});
	} },
	groups: {
		resolveRequireMention: resolveZalouserRequireMention,
		resolveToolPolicy: resolveZalouserGroupToolPolicy
	},
	threading: { resolveReplyToMode: () => "off" },
	actions: {
		listActions: ({ cfg }) => {
			if (listZalouserAccountIds(cfg).map((accountId) => resolveZalouserAccountSync({
				cfg,
				accountId
			})).filter((account) => account.enabled).length === 0) {return [];}
			return ["react"];
		},
		supportsAction: ({ action }) => action === "react",
		handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
			if (action !== "react") {throw new Error(`Zalouser action ${action} not supported`);}
			const account = resolveZalouserAccountSync({
				cfg,
				accountId
			});
			const threadId = (typeof params.threadId === "string" ? params.threadId.trim() : "") || (typeof params.to === "string" ? params.to.trim() : "") || (typeof params.chatId === "string" ? params.chatId.trim() : "") || (toolContext?.currentChannelId?.trim() ?? "");
			if (!threadId) {throw new Error("Zalouser react requires threadId (or to/chatId).");}
			const emoji = typeof params.emoji === "string" ? params.emoji.trim() : "";
			if (!emoji) {throw new Error("Zalouser react requires emoji.");}
			const ids = resolveZalouserReactionMessageIds({
				messageId: typeof params.messageId === "string" ? params.messageId : void 0,
				cliMsgId: typeof params.cliMsgId === "string" ? params.cliMsgId : void 0,
				currentMessageId: toolContext?.currentMessageId
			});
			if (!ids) {throw new Error("Zalouser react requires messageId + cliMsgId (or a current message context id).");}
			const result = await sendReactionZalouser({
				profile: account.profile,
				threadId,
				isGroup: params.isGroup === true,
				msgId: ids.msgId,
				cliMsgId: ids.cliMsgId,
				emoji,
				remove: params.remove === true
			});
			if (!result.ok) {throw new Error(result.error || "Failed to react on Zalo message");}
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
	},
	messaging: {
		normalizeTarget: (raw) => normalizePrefixedTarget(raw),
		targetResolver: {
			looksLikeId: (raw) => {
				const normalized = normalizePrefixedTarget(raw);
				if (!normalized) {return false;}
				if (/^group:[^\s]+$/i.test(normalized) || /^user:[^\s]+$/i.test(normalized)) {return true;}
				return isNumericTargetId(normalized);
			},
			hint: "<user:id|group:id>"
		}
	},
	directory: {
		self: async ({ cfg, accountId }) => {
			const parsed = await getZaloUserInfo(resolveZalouserAccountSync({
				cfg,
				accountId
			}).profile);
			if (!parsed?.userId) {return null;}
			return mapUser({
				id: String(parsed.userId),
				name: parsed.displayName ?? null,
				avatarUrl: parsed.avatar ?? null,
				raw: parsed
			});
		},
		listPeers: async ({ cfg, accountId, query, limit }) => {
			const rows = (await listZaloFriendsMatching(resolveZalouserAccountSync({
				cfg,
				accountId
			}).profile, query)).map((friend) => mapUser({
				id: String(friend.userId),
				name: friend.displayName ?? null,
				avatarUrl: friend.avatar ?? null,
				raw: friend
			}));
			return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
		},
		listGroups: async ({ cfg, accountId, query, limit }) => {
			const rows = (await listZaloGroupsMatching(resolveZalouserAccountSync({
				cfg,
				accountId
			}).profile, query)).map((group) => mapGroup({
				id: `group:${String(group.groupId)}`,
				name: group.name ?? null,
				raw: group
			}));
			return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
		},
		listGroupMembers: async ({ cfg, accountId, groupId, limit }) => {
			const account = resolveZalouserAccountSync({
				cfg,
				accountId
			});
			const normalizedGroupId = parseZalouserDirectoryGroupId(groupId);
			const rows = (await listZaloGroupMembers(account.profile, normalizedGroupId)).map((member) => mapUser({
				id: member.userId,
				name: member.displayName,
				avatarUrl: member.avatar ?? null,
				raw: member
			}));
			return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
		}
	},
	resolver: { resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) => {
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
				const account = resolveZalouserAccountSync({
					cfg,
					accountId: accountId ?? "default"
				});
				if (kind === "user") {
					const friends = await listZaloFriendsMatching(account.profile, trimmed);
					const best = friends[0];
					results.push({
						input,
						resolved: Boolean(best?.userId),
						id: best?.userId,
						name: best?.displayName,
						note: friends.length > 1 ? "multiple matches; chose first" : void 0
					});
				} else {
					const groups = await listZaloGroupsMatching(account.profile, trimmed);
					const best = groups.find((group) => group.name.toLowerCase() === trimmed.toLowerCase()) ?? groups[0];
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
	} },
	pairing: {
		idLabel: "zalouserUserId",
		normalizeAllowEntry: (entry) => entry.replace(/^(zalouser|zlu):/i, ""),
		notifyApproval: async ({ cfg, id }) => {
			const account = resolveZalouserAccountSync({ cfg });
			if (!await checkZaloAuthenticated(account.profile)) {throw new Error("Zalouser not authenticated");}
			await sendMessageZalouser(id, "Your pairing request has been approved.", { profile: account.profile });
		}
	},
	auth: { login: async ({ cfg, accountId, runtime }) => {
		const account = resolveZalouserAccountSync({
			cfg,
			accountId: accountId ?? "default"
		});
		runtime.log(`Generating QR login for Zalo Personal (account: ${account.accountId}, profile: ${account.profile})...`);
		const started = await startZaloQrLogin({
			profile: account.profile,
			timeoutMs: 35e3
		});
		if (!started.qrDataUrl) {throw new Error(started.message || "Failed to start QR login");}
		const qrPath = await writeQrDataUrlToTempFile(started.qrDataUrl, account.profile);
		if (qrPath) {runtime.log(`Scan QR image: ${qrPath}`);}
		else {runtime.log("QR generated but could not be written to a temp file.");}
		const waited = await waitForZaloQrLogin({
			profile: account.profile,
			timeoutMs: 18e4
		});
		if (!waited.connected) {throw new Error(waited.message || "Zalouser login failed");}
		runtime.log(waited.message);
	} },
	outbound: {
		deliveryMode: "direct",
		chunker: (text, limit) => getZalouserRuntime().channel.text.chunkMarkdownText(text, limit),
		chunkerMode: "markdown",
		sendPayload: async (ctx) => await sendPayloadWithChunkedTextAndMedia({
			ctx,
			sendText: (nextCtx) => zalouserPlugin.outbound.sendText(nextCtx),
			sendMedia: (nextCtx) => zalouserPlugin.outbound.sendMedia(nextCtx),
			emptyResult: {
				channel: "zalouser",
				messageId: ""
			}
		}),
		sendText: async ({ to, text, accountId, cfg }) => {
			const account = resolveZalouserAccountSync({
				cfg,
				accountId
			});
			const target = parseZalouserOutboundTarget(to);
			return buildChannelSendResult("zalouser", await sendMessageZalouser(target.threadId, text, {
				profile: account.profile,
				isGroup: target.isGroup,
				textMode: "markdown",
				textChunkMode: resolveZalouserOutboundChunkMode(cfg, account.accountId),
				textChunkLimit: resolveZalouserOutboundTextChunkLimit(cfg, account.accountId)
			}));
		},
		sendMedia: async ({ to, text, mediaUrl, accountId, cfg, mediaLocalRoots }) => {
			const account = resolveZalouserAccountSync({
				cfg,
				accountId
			});
			const target = parseZalouserOutboundTarget(to);
			return buildChannelSendResult("zalouser", await sendMessageZalouser(target.threadId, text, {
				profile: account.profile,
				isGroup: target.isGroup,
				mediaUrl,
				mediaLocalRoots,
				textMode: "markdown",
				textChunkMode: resolveZalouserOutboundChunkMode(cfg, account.accountId),
				textChunkLimit: resolveZalouserOutboundTextChunkLimit(cfg, account.accountId)
			}));
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
		collectStatusIssues: collectZalouserStatusIssues,
		buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot),
		probeAccount: async ({ account, timeoutMs }) => probeZalouser(account.profile, timeoutMs),
		buildAccountSnapshot: async ({ account, runtime }) => {
			const configured = await checkZaloAuthenticated(account.profile);
			const configError = "not authenticated";
			return {
				...buildBaseAccountStatusSnapshot({
					account: {
						accountId: account.accountId,
						name: account.name,
						enabled: account.enabled,
						configured
					},
					runtime: configured ? runtime : {
						...runtime,
						lastError: runtime?.lastError ?? configError
					}
				}),
				dmPolicy: account.config.dmPolicy ?? "pairing"
			};
		}
	},
	gateway: {
		startAccount: async (ctx) => {
			const account = ctx.account;
			let userLabel = "";
			try {
				const userInfo = await getZcaUserInfo(account.profile);
				if (userInfo?.displayName) {userLabel = ` (${userInfo.displayName})`;}
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
			const { monitorZalouserProvider } = await import("./monitor-C8pI4jws.js");
			return monitorZalouserProvider({
				account,
				config: ctx.cfg,
				runtime: ctx.runtime,
				abortSignal: ctx.abortSignal,
				statusSink
			});
		},
		loginWithQrStart: async (params) => {
			return await startZaloQrLogin({
				profile: resolveZalouserQrProfile(params.accountId),
				force: params.force,
				timeoutMs: params.timeoutMs
			});
		},
		loginWithQrWait: async (params) => {
			return await waitForZaloQrLogin({
				profile: resolveZalouserQrProfile(params.accountId),
				timeoutMs: params.timeoutMs
			});
		},
		logoutAccount: async (ctx) => await logoutZaloProfile(ctx.account.profile || resolveZalouserQrProfile(ctx.accountId))
	}
};
//#endregion
export { zalouserPlugin as t };
