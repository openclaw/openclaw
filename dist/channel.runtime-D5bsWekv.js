import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { _ as resolveRequestClientIp } from "./net-DCUMtgJy.js";
import { i as deliverTextOrMediaReply, m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { c as defineStableChannelIngressIdentity, n as createChannelIngressResolver, t as channelIngressRoutes } from "./runtime-BUVuto5K.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy, t as GROUP_POLICY_BLOCKED_LABEL } from "./runtime-group-policy-CmZDlIwd.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { p as recordChannelBotPairLoopAndCheckSuppression } from "./kernel-BXIm_f4L.js";
import { i as mergePairLoopGuardConfig } from "./pair-loop-guard-runtime-jabAgbOL.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-jjAiM0PK.js";
import "./inbound-reply-dispatch-Bi01ox5N.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope-DF4N8x5q.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { n as createChannelPairingController } from "./channel-pairing-N4dBc-K-.js";
import { a as createFixedWindowRateLimiter, r as WEBHOOK_RATE_LIMIT_DEFAULTS } from "./webhook-ingress-R0qMwT4u.js";
import { a as createWebhookInFlightLimiter, s as readJsonWebhookBodyOrReject } from "./webhook-request-guards-iMi786D5.js";
import { n as resolveWebhookPath, t as normalizeWebhookPath } from "./webhook-path-rjz7yuUD.js";
import { l as withResolvedWebhookRequestPipeline, n as registerWebhookTargetWithPluginRoute, o as resolveWebhookTargetWithAuthOrReject } from "./webhook-targets-gc0zD_lY.js";
import { t as getGoogleChatRuntime } from "./runtime-api-BjlJCGKW.js";
import { c as sendGoogleChatMessage, d as verifyGoogleChatRequest, i as downloadGoogleChatMedia, l as updateGoogleChatMessage, n as deleteGoogleChatMessage, s as probeGoogleChat, u as uploadGoogleChatAttachment } from "./api-DTaSz4ae.js";
//#region extensions/googlechat/src/monitor-access.ts
function normalizeUserId(raw) {
	const trimmed = normalizeOptionalString(raw) ?? "";
	if (!trimmed) return "";
	return normalizeLowercaseStringOrEmpty(trimmed.replace(/^users\//i, ""));
}
const GOOGLECHAT_EMAIL_KIND = "plugin:googlechat-email";
function normalizeEntryValue(raw) {
	return normalizeLowercaseStringOrEmpty(raw ?? "");
}
function normalizeGoogleChatStableEntry(entry) {
	const withoutProvider = normalizeEntryValue(entry).replace(/^(googlechat|google-chat|gchat):/i, "");
	if (!withoutProvider) return null;
	return withoutProvider.startsWith("users/") ? normalizeUserId(withoutProvider) : withoutProvider;
}
function normalizeGoogleChatEmailEntry(entry) {
	if (normalizeEntryValue(entry).replace(/^(googlechat|google-chat|gchat):/i, "").startsWith("users/")) return null;
	const stable = normalizeGoogleChatStableEntry(entry);
	return stable?.includes("@") ? stable : null;
}
const googleChatIngressIdentity = defineStableChannelIngressIdentity({
	key: "sender-id",
	normalizeEntry: normalizeGoogleChatStableEntry,
	normalizeSubject: normalizeUserId,
	aliases: [{
		key: "email",
		kind: GOOGLECHAT_EMAIL_KIND,
		normalizeEntry: normalizeGoogleChatEmailEntry,
		normalizeSubject: normalizeEntryValue,
		dangerous: true
	}],
	isWildcardEntry: (entry) => normalizeEntryValue(entry) === "*",
	resolveEntryId: ({ entryIndex, fieldKey }) => fieldKey === "stableId" ? `entry-${entryIndex + 1}:user` : `entry-${entryIndex + 1}:${fieldKey}`
});
function resolveGroupConfig(params) {
	const { groupId, groupName, groups } = params;
	const entries = groups ?? {};
	const keys = Object.keys(entries);
	if (keys.length === 0) return {
		entry: void 0,
		allowlistConfigured: false,
		deprecatedNameMatch: false
	};
	const entry = entries[groupId];
	const normalizedGroupName = normalizeLowercaseStringOrEmpty(groupName ?? "");
	const deprecatedNameMatch = !entry && Boolean(groupName && keys.some((key) => {
		const trimmed = key.trim();
		if (!trimmed || trimmed === "*" || /^spaces\//i.test(trimmed)) return false;
		return trimmed === groupName || normalizeLowercaseStringOrEmpty(trimmed) === normalizedGroupName;
	}));
	const fallback = entries["*"];
	return {
		entry: deprecatedNameMatch ? void 0 : entry ?? fallback,
		allowlistConfigured: true,
		fallback,
		deprecatedNameMatch
	};
}
function extractMentionInfo(annotations, botUser) {
	const mentionAnnotations = annotations.filter((entry) => entry.type === "USER_MENTION");
	const hasAnyMention = mentionAnnotations.length > 0;
	const botTargets = new Set(["users/app", botUser?.trim()].filter(Boolean));
	return {
		hasAnyMention,
		wasMentioned: mentionAnnotations.some((entry) => {
			const userName = entry.userMention?.user?.name;
			if (!userName) return false;
			if (botTargets.has(userName)) return true;
			return normalizeUserId(userName) === "app";
		})
	};
}
const warnedDeprecatedUsersEmailAllowFrom = /* @__PURE__ */ new Set();
const warnedMutableGroupKeys = /* @__PURE__ */ new Set();
function warnDeprecatedUsersEmailEntries(logVerbose, entries) {
	const deprecated = entries.map((v) => normalizeOptionalString(v)).filter((v) => Boolean(v)).filter((v) => /^users\/.+@.+/i.test(v));
	if (deprecated.length === 0) return;
	const key = deprecated.map((v) => normalizeLowercaseStringOrEmpty(v)).toSorted((a, b) => a.localeCompare(b)).join(",");
	if (warnedDeprecatedUsersEmailAllowFrom.has(key)) return;
	warnedDeprecatedUsersEmailAllowFrom.add(key);
	logVerbose(`Deprecated allowFrom entry detected: "users/<email>" is no longer treated as an email allowlist. Use raw email (alice@example.com) or immutable user id (users/<id>). entries=${deprecated.join(", ")}`);
}
function warnMutableGroupKeysConfigured(logVerbose, groups) {
	const mutableKeys = Object.keys(groups ?? {}).map((key) => key.trim()).filter((key) => key && key !== "*" && !/^spaces\//i.test(key));
	if (mutableKeys.length === 0) return;
	const warningKey = mutableKeys.map((key) => normalizeLowercaseStringOrEmpty(key)).toSorted((a, b) => a.localeCompare(b)).join(",");
	if (warnedMutableGroupKeys.has(warningKey)) return;
	warnedMutableGroupKeys.add(warningKey);
	logVerbose(`Deprecated Google Chat group key detected: group routing now requires stable space ids (spaces/<spaceId>). Update channels.googlechat.groups keys: ${mutableKeys.join(", ")}`);
}
async function applyGoogleChatInboundAccessPolicy(params) {
	const { account, config, core, space, message, isGroup, senderId, senderName, senderEmail, rawBody, statusSink, logVerbose } = params;
	const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
	const spaceId = space.name ?? "";
	const pairing = createChannelPairingController({
		core,
		channel: "googlechat",
		accountId: account.accountId
	});
	const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
	const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
		providerConfigPresent: config.channels?.googlechat !== void 0,
		groupPolicy: account.config.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "googlechat",
		accountId: account.accountId,
		blockedLabel: GROUP_POLICY_BLOCKED_LABEL.space,
		log: logVerbose
	});
	warnMutableGroupKeysConfigured(logVerbose, account.config.groups ?? void 0);
	const groupConfigResolved = resolveGroupConfig({
		groupId: spaceId,
		groupName: space.displayName ?? null,
		groups: account.config.groups ?? void 0
	});
	const groupEntry = groupConfigResolved.entry;
	const groupUsers = groupEntry?.users ?? account.config.groupAllowFrom ?? [];
	let effectiveWasMentioned;
	const dmPolicy = account.config.dm?.policy ?? "pairing";
	const rawConfigAllowFrom = normalizeStringEntries(account.config.dm?.allowFrom);
	const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
	const groupActivation = (() => {
		if (!isGroup) return;
		const requireMention = groupEntry?.requireMention ?? account.config.requireMention ?? true;
		const mentionInfo = extractMentionInfo(message.annotations ?? [], account.config.botUser);
		return {
			requireMention,
			allowTextCommands: core.channel.commands.shouldHandleTextCommands({
				cfg: config,
				surface: "googlechat"
			}),
			hasControlCommand: core.channel.text.hasControlCommand(rawBody, config),
			wasMentioned: mentionInfo.wasMentioned,
			hasAnyMention: mentionInfo.hasAnyMention
		};
	})();
	const command = {
		hasControlCommand: groupActivation?.hasControlCommand ?? shouldComputeAuth,
		groupOwnerAllowFrom: "none"
	};
	const groupAllowFrom = normalizeStringEntries(groupUsers);
	const senderGroupPolicy = groupConfigResolved.allowlistConfigured && groupAllowFrom.length === 0 ? groupPolicy : groupPolicy === "disabled" ? "disabled" : groupAllowFrom.length > 0 ? "allowlist" : "open";
	const route = channelIngressRoutes(isGroup && groupPolicy !== "disabled" && groupEntry?.enabled === false && {
		id: "googlechat:space",
		enabled: false,
		matched: true,
		matchId: "googlechat-space",
		blockReason: "route_disabled"
	}, isGroup && groupPolicy === "allowlist" && groupEntry?.enabled !== false && !groupConfigResolved.allowlistConfigured && {
		id: "googlechat:space",
		allowed: false,
		blockReason: "empty_allowlist"
	}, isGroup && groupPolicy === "allowlist" && groupEntry?.enabled !== false && groupConfigResolved.allowlistConfigured && {
		id: "googlechat:space",
		senderPolicy: "deny-when-empty",
		...groupEntry ? { senderAllowFromSource: "effective-group" } : {},
		allowed: Boolean(groupEntry),
		matchId: "googlechat-space",
		blockReason: groupEntry ? "sender_empty_allowlist" : "route_not_allowlisted"
	});
	const resolvedAccess = await createChannelIngressResolver({
		channelId: "googlechat",
		accountId: account.accountId,
		identity: googleChatIngressIdentity,
		cfg: config,
		readStoreAllowFrom: pairing.readAllowFromStore
	}).message({
		subject: {
			stableId: senderId,
			aliases: { email: senderEmail }
		},
		conversation: {
			kind: isGroup ? "group" : "direct",
			id: spaceId
		},
		route,
		allowFrom: rawConfigAllowFrom,
		groupAllowFrom,
		dmPolicy,
		groupPolicy: senderGroupPolicy,
		policy: {
			groupAllowFromFallbackToAllowFrom: false,
			mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
			...groupActivation ? { activation: {
				requireMention: groupActivation.requireMention,
				allowTextCommands: groupActivation.allowTextCommands
			} } : {}
		},
		...groupActivation == null ? {} : { mentionFacts: {
			canDetectMention: true,
			wasMentioned: groupActivation.wasMentioned,
			hasAnyMention: groupActivation.hasAnyMention,
			implicitMentionKinds: []
		} },
		command
	});
	const senderAccess = resolvedAccess.senderAccess;
	const commandAuthorized = resolvedAccess.commandAccess.requested ? resolvedAccess.commandAccess.authorized : void 0;
	if (isGroup) {
		if (groupConfigResolved.deprecatedNameMatch) {
			logVerbose(`drop group message (deprecated mutable group key matched, space=${spaceId})`);
			return { ok: false };
		}
		const routeBlockReason = resolvedAccess.routeAccess.reason;
		if (routeBlockReason && routeBlockReason !== "sender_empty_allowlist") {
			if (routeBlockReason === "empty_allowlist") logVerbose(`drop group message (groupPolicy=allowlist, no allowlist, space=${spaceId})`);
			else if (routeBlockReason === "route_not_allowlisted") logVerbose(`drop group message (not allowlisted, space=${spaceId})`);
			else if (routeBlockReason === "route_disabled") logVerbose(`drop group message (space disabled, space=${spaceId})`);
			return { ok: false };
		}
		if (senderAccess.effectiveGroupAllowFrom.length > 0 && senderAccess.decision !== "allow") {
			warnDeprecatedUsersEmailEntries(logVerbose, senderAccess.effectiveGroupAllowFrom);
			logVerbose(`drop group message (sender not allowed, ${senderId})`);
			return { ok: false };
		}
	}
	const effectiveAllowFrom = senderAccess.effectiveAllowFrom;
	warnDeprecatedUsersEmailEntries(logVerbose, effectiveAllowFrom);
	if (isGroup && resolvedAccess.activationAccess.ran) {
		effectiveWasMentioned = resolvedAccess.activationAccess.effectiveWasMentioned;
		if (resolvedAccess.activationAccess.shouldSkip) {
			logVerbose(`drop group message (mention required, space=${spaceId})`);
			return { ok: false };
		}
	}
	if (isGroup && senderAccess.decision !== "allow") {
		logVerbose(`drop group message (sender policy blocked, reason=${resolvedAccess.ingress.reasonCode === "route_sender_empty" ? "groupPolicy=allowlist (empty allowlist)" : senderAccess.reasonCode}, space=${spaceId})`);
		return { ok: false };
	}
	if (!isGroup) {
		if (account.config.dm?.enabled === false) {
			logVerbose(`Blocked Google Chat DM from ${senderId} (dmPolicy=disabled)`);
			return { ok: false };
		}
		if (senderAccess.decision !== "allow") {
			if (senderAccess.decision === "pairing") await pairing.issueChallenge({
				senderId,
				senderIdLine: `Your Google Chat user id: ${senderId}`,
				meta: {
					name: senderName || void 0,
					email: senderEmail
				},
				onCreated: () => {
					logVerbose(`googlechat pairing request sender=${senderId}`);
				},
				sendPairingReply: async (text) => {
					await sendGoogleChatMessage({
						account,
						space: spaceId,
						text
					});
					statusSink?.({ lastOutboundAt: Date.now() });
				},
				onReplyError: (err) => {
					logVerbose(`pairing reply failed for ${senderId}: ${String(err)}`);
				}
			});
			else logVerbose(`Blocked unauthorized Google Chat sender ${senderId} (dmPolicy=${dmPolicy})`);
			return { ok: false };
		}
	}
	if (isGroup && core.channel.commands.isControlCommandMessage(rawBody, config) && commandAuthorized !== true) {
		logVerbose(`googlechat: drop control command from ${senderId}`);
		return { ok: false };
	}
	return {
		ok: true,
		commandAuthorized,
		effectiveWasMentioned,
		groupBotLoopProtection: groupEntry?.botLoopProtection,
		groupSystemPrompt: normalizeOptionalString(groupEntry?.systemPrompt)
	};
}
//#endregion
//#region extensions/googlechat/src/monitor-durable.ts
function resolveGoogleChatDurableReplyOptions(params) {
	if (params.infoKind !== "final" || params.typingMessageName) return false;
	const threadId = params.payload.replyToId?.trim() || void 0;
	return {
		to: params.spaceId,
		...threadId ? {
			replyToId: threadId,
			threadId
		} : {}
	};
}
//#endregion
//#region extensions/googlechat/src/monitor-reply-delivery.ts
async function deliverGoogleChatReply(params) {
	const { payload, account, spaceId, runtime, core, config, statusSink } = params;
	let typingMessageName = params.typingMessageName;
	const reply = resolveSendableOutboundReplyParts(payload);
	const mediaCount = reply.mediaCount;
	const hasMedia = reply.hasMedia;
	const text = reply.text;
	let firstTextChunk = true;
	let suppressCaption = false;
	if (hasMedia && typingMessageName) try {
		await deleteGoogleChatMessage({
			account,
			messageName: typingMessageName
		});
		typingMessageName = void 0;
	} catch (err) {
		runtime.error?.(`Google Chat typing cleanup failed: ${String(err)}`);
		if (typingMessageName) {
			const fallbackText = reply.hasText ? text : mediaCount > 1 ? "Sent attachments." : "Sent attachment.";
			try {
				await updateGoogleChatMessage({
					account,
					messageName: typingMessageName,
					text: fallbackText
				});
				suppressCaption = Boolean(text.trim());
			} catch (updateErr) {
				runtime.error?.(`Google Chat typing update failed: ${String(updateErr)}`);
				typingMessageName = void 0;
			}
		}
	}
	const chunkLimit = account.config.textChunkLimit ?? 4e3;
	const chunkMode = core.channel.text.resolveChunkMode(config, "googlechat", account.accountId);
	const sendTextMessage = async (chunk) => {
		await sendGoogleChatMessage({
			account,
			space: spaceId,
			text: chunk,
			thread: payload.replyToId
		});
	};
	await deliverTextOrMediaReply({
		payload,
		text: suppressCaption ? "" : reply.text,
		chunkText: (value) => core.channel.text.chunkMarkdownTextWithMode(value, chunkLimit, chunkMode),
		sendText: async (chunk) => {
			try {
				if (firstTextChunk && typingMessageName) await updateGoogleChatMessage({
					account,
					messageName: typingMessageName,
					text: chunk
				});
				else await sendTextMessage(chunk);
				firstTextChunk = false;
				statusSink?.({ lastOutboundAt: Date.now() });
			} catch (err) {
				runtime.error?.(`Google Chat message send failed: ${String(err)}`);
				if (firstTextChunk && typingMessageName) {
					typingMessageName = void 0;
					try {
						await sendTextMessage(chunk);
						statusSink?.({ lastOutboundAt: Date.now() });
					} catch (fallbackErr) {
						runtime.error?.(`Google Chat message fallback send failed: ${String(fallbackErr)}`);
					} finally {
						firstTextChunk = false;
					}
				}
			}
		},
		sendMedia: async ({ mediaUrl, caption }) => {
			try {
				const loaded = await core.channel.media.readRemoteMediaBuffer({
					url: mediaUrl,
					maxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024
				});
				const upload = await uploadAttachmentForReply({
					account,
					spaceId,
					buffer: loaded.buffer,
					contentType: loaded.contentType,
					filename: loaded.fileName ?? "attachment"
				});
				if (!upload.attachmentUploadToken) throw new Error("missing attachment upload token");
				await sendGoogleChatMessage({
					account,
					space: spaceId,
					text: caption,
					thread: payload.replyToId,
					attachments: [{
						attachmentUploadToken: upload.attachmentUploadToken,
						contentName: loaded.fileName
					}]
				});
				statusSink?.({ lastOutboundAt: Date.now() });
			} catch (err) {
				runtime.error?.(`Google Chat attachment send failed: ${String(err)}`);
			}
		}
	});
}
async function uploadAttachmentForReply(params) {
	const { account, spaceId, buffer, contentType, filename } = params;
	return await uploadGoogleChatAttachment({
		account,
		space: spaceId,
		filename,
		buffer,
		contentType
	});
}
//#endregion
//#region extensions/googlechat/src/monitor-webhook.ts
function extractBearerToken(header) {
	const authHeader = Array.isArray(header) ? typeof header[0] === "string" ? header[0] : "" : typeof header === "string" ? header : "";
	return normalizeLowercaseStringOrEmpty(authHeader).startsWith("bearer ") ? authHeader.slice(7).trim() : "";
}
const ADD_ON_PREAUTH_MAX_BYTES = 16 * 1024;
const ADD_ON_PREAUTH_TIMEOUT_MS = 3e3;
function parseGoogleChatInboundPayload(raw, res) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		res.statusCode = 400;
		res.end("invalid payload");
		return { ok: false };
	}
	let eventPayload = raw;
	let addOnBearerToken = "";
	const rawObj = raw;
	if (rawObj.commonEventObject?.hostApp === "CHAT" && rawObj.chat?.messagePayload) {
		const chat = rawObj.chat;
		const messagePayload = chat.messagePayload;
		eventPayload = {
			type: "MESSAGE",
			space: messagePayload?.space,
			message: messagePayload?.message,
			user: chat.user,
			eventTime: chat.eventTime
		};
		addOnBearerToken = typeof rawObj.authorizationEventObject?.systemIdToken === "string" ? rawObj.authorizationEventObject.systemIdToken.trim() : "";
	}
	const event = eventPayload;
	const eventType = event.type ?? eventPayload.eventType;
	if (typeof eventType !== "string") {
		res.statusCode = 400;
		res.end("invalid payload");
		return { ok: false };
	}
	if (!event.space || typeof event.space !== "object" || Array.isArray(event.space)) {
		res.statusCode = 400;
		res.end("invalid payload");
		return { ok: false };
	}
	if (eventType === "MESSAGE") {
		if (!event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
			res.statusCode = 400;
			res.end("invalid payload");
			return { ok: false };
		}
	}
	return {
		ok: true,
		event,
		addOnBearerToken
	};
}
async function verifyGoogleChatTargetAuth(target, bearer) {
	const verification = await verifyGoogleChatRequest({
		bearer,
		audienceType: target.audienceType,
		audience: target.audience,
		expectedAddOnPrincipal: target.account.config.appPrincipal
	});
	return verification.ok ? { ok: true } : {
		ok: false,
		reason: verification.reason ?? "unknown"
	};
}
function logGoogleChatWebhookAuthRejections(rejections) {
	for (const rejection of rejections) rejection.target.runtime.log?.(`[${rejection.target.account.accountId}] Google Chat webhook auth rejected: ${rejection.reason}`);
}
function logGoogleChatWebhookAuthRejectedForTargets(targets, reason) {
	logGoogleChatWebhookAuthRejections(targets.map((target) => ({
		target,
		reason
	})));
}
async function resolveGoogleChatWebhookTargetWithAuthOrReject(params) {
	const rejections = [];
	let verifiedTargetCount = 0;
	const selectedTarget = await resolveWebhookTargetWithAuthOrReject({
		targets: params.targets,
		res: params.res,
		isMatch: async (target) => {
			const verification = await verifyGoogleChatTargetAuth(target, params.bearer);
			if (verification.ok) {
				verifiedTargetCount += 1;
				return true;
			}
			rejections.push({
				target,
				reason: verification.reason
			});
			return false;
		}
	});
	if (!selectedTarget && verifiedTargetCount === 0) logGoogleChatWebhookAuthRejections(rejections);
	return selectedTarget;
}
function warnAppPrincipalMisconfiguration(params) {
	if (params.audienceType !== "app-url") return;
	const principal = params.appPrincipal?.trim();
	if (!principal) params.log?.(`[${params.accountId}] appPrincipal is missing for audienceType "app-url"; add-on token verification will fail. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.`);
	else if (principal.includes("@")) params.log?.(`[${params.accountId}] appPrincipal "${principal}" looks like an email address. Set appPrincipal to the numeric OAuth 2.0 client ID (uniqueId, 21 digits), not an email.`);
}
function createGoogleChatWebhookRequestHandler(params) {
	return async (req, res) => {
		const path = normalizeWebhookPath(new URL(req.url ?? "/", "http://localhost").pathname);
		const config = params.webhookTargets.get(path)?.[0]?.config;
		const clientIp = resolveRequestClientIp(req, config?.gateway?.trustedProxies, config?.gateway?.allowRealIpFallback === true) ?? "unknown";
		return await withResolvedWebhookRequestPipeline({
			req,
			res,
			targetsByPath: params.webhookTargets,
			allowMethods: ["POST"],
			requireJsonContentType: true,
			rateLimiter: params.webhookRateLimiter,
			rateLimitKey: `${path}:${clientIp}`,
			inFlightLimiter: params.webhookInFlightLimiter,
			handle: async ({ targets }) => {
				const headerBearer = extractBearerToken(req.headers.authorization);
				let selectedTarget = null;
				let parsedEvent = null;
				const readAndParseEvent = async (profile) => {
					const body = await readJsonWebhookBodyOrReject({
						req,
						res,
						profile,
						...profile === "pre-auth" ? {
							maxBytes: ADD_ON_PREAUTH_MAX_BYTES,
							timeoutMs: ADD_ON_PREAUTH_TIMEOUT_MS
						} : {},
						emptyObjectOnEmpty: false,
						invalidJsonMessage: "invalid payload"
					});
					if (!body.ok) return null;
					const parsed = parseGoogleChatInboundPayload(body.value, res);
					return parsed.ok ? parsed : null;
				};
				if (headerBearer) {
					selectedTarget = await resolveGoogleChatWebhookTargetWithAuthOrReject({
						targets,
						res,
						bearer: headerBearer
					});
					if (!selectedTarget) return true;
					const parsed = await readAndParseEvent("post-auth");
					if (!parsed) return true;
					parsedEvent = parsed.event;
				} else {
					const parsed = await readAndParseEvent("pre-auth");
					if (!parsed) return true;
					parsedEvent = parsed.event;
					if (!parsed.addOnBearerToken) {
						logGoogleChatWebhookAuthRejectedForTargets(targets, "missing token");
						res.statusCode = 401;
						res.end("unauthorized");
						return true;
					}
					selectedTarget = await resolveGoogleChatWebhookTargetWithAuthOrReject({
						targets,
						res,
						bearer: parsed.addOnBearerToken
					});
					if (!selectedTarget) return true;
				}
				if (!selectedTarget || !parsedEvent) {
					res.statusCode = 401;
					res.end("unauthorized");
					return true;
				}
				const dispatchTarget = selectedTarget;
				dispatchTarget.statusSink?.({ lastInboundAt: Date.now() });
				params.processEvent(parsedEvent, dispatchTarget).catch((err) => {
					dispatchTarget.runtime.error?.(`[${dispatchTarget.account.accountId}] Google Chat webhook failed: ${String(err)}`);
				});
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end("{}");
				return true;
			}
		});
	};
}
//#endregion
//#region extensions/googlechat/src/monitor-routing.ts
const webhookTargets = /* @__PURE__ */ new Map();
const webhookRateLimiter = createFixedWindowRateLimiter({
	windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
	maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
	maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys
});
const webhookInFlightLimiter = createWebhookInFlightLimiter();
let processGoogleChatEvent$1 = async () => {};
function setGoogleChatWebhookEventProcessor(processEvent) {
	processGoogleChatEvent$1 = processEvent;
}
const googleChatWebhookRequestHandler = createGoogleChatWebhookRequestHandler({
	webhookTargets,
	webhookRateLimiter,
	webhookInFlightLimiter,
	processEvent: async (event, target) => {
		await processGoogleChatEvent$1(event, target);
	}
});
function registerGoogleChatWebhookTarget(target) {
	return registerWebhookTargetWithPluginRoute({
		targetsByPath: webhookTargets,
		target,
		route: {
			auth: "plugin",
			match: "exact",
			pluginId: "googlechat",
			source: "googlechat-webhook",
			accountId: target.account.accountId,
			log: target.runtime.log,
			handler: async (req, res) => {
				if (!await handleGoogleChatWebhookRequest(req, res) && !res.headersSent) {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Not Found");
				}
			}
		}
	}).unregister;
}
async function handleGoogleChatWebhookRequest(req, res) {
	return await googleChatWebhookRequestHandler(req, res);
}
//#endregion
//#region extensions/googlechat/src/monitor.ts
setGoogleChatWebhookEventProcessor(processGoogleChatEvent);
function logVerbose(core, runtime, message) {
	if (core.logging.shouldLogVerbose()) runtime.log?.(`[googlechat] ${message}`);
}
function normalizeAudienceType(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (normalized === "app-url" || normalized === "app_url" || normalized === "app") return "app-url";
	if (normalized === "project-number" || normalized === "project_number" || normalized === "project") return "project-number";
}
function resolveGoogleChatTimestampMs(eventTime) {
	if (!eventTime) return;
	const parsed = Date.parse(eventTime);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function resolveGoogleChatBotLoopProtection(params) {
	if (!params.allowBots || !params.isBotSender || !params.senderId || params.senderId === params.appUserId) return;
	return {
		scopeId: params.accountId,
		conversationId: params.conversationId,
		senderId: params.senderId,
		receiverId: params.appUserId,
		config: params.config,
		defaultsConfig: params.defaultsConfig,
		defaultEnabled: true,
		nowMs: resolveGoogleChatTimestampMs(params.eventTime)
	};
}
function resolveGoogleChatBotLoopProtectionConfig(params) {
	return mergePairLoopGuardConfig(params.accountConfig, params.groupConfig);
}
function shouldSuppressGoogleChatBotLoop(params) {
	if (!params.botLoopProtection) return false;
	if (!recordChannelBotPairLoopAndCheckSuppression(params.botLoopProtection).suppressed) return false;
	logVerbose(params.core, params.runtime, `skip bot-to-bot loop in ${params.botLoopProtection.conversationId}`);
	return true;
}
async function processGoogleChatEvent(event, target) {
	if ((event.type ?? event.eventType) !== "MESSAGE") return;
	if (!event.message || !event.space) return;
	await processMessageWithPipeline({
		event,
		account: target.account,
		config: target.config,
		runtime: target.runtime,
		core: target.core,
		statusSink: target.statusSink,
		mediaMaxMb: target.mediaMaxMb
	});
}
/**
* Resolve bot display name with fallback chain:
* 1. Account config name
* 2. Agent name from config
* 3. "OpenClaw" as generic fallback
*/
function resolveBotDisplayName(params) {
	const { accountName, agentId, config } = params;
	if (accountName?.trim()) return accountName.trim();
	const agent = config.agents?.list?.find((a) => a.id === agentId);
	if (agent?.name?.trim()) return agent.name.trim();
	return "OpenClaw";
}
async function processMessageWithPipeline(params) {
	const { event, account, config, runtime, core, statusSink, mediaMaxMb } = params;
	const space = event.space;
	const message = event.message;
	if (!space || !message) return;
	const spaceId = space.name ?? "";
	if (!spaceId) return;
	const isGroup = (space.type ?? "").toUpperCase() !== "DM";
	const sender = message.sender ?? event.user;
	const senderId = sender?.name ?? "";
	const senderName = sender?.displayName ?? "";
	const senderEmail = sender?.email ?? void 0;
	const isBotSender = sender?.type?.toUpperCase() === "BOT";
	const appUserId = account.config.botUser?.trim() || "users/app";
	const allowBots = account.config.allowBots === true;
	if (!allowBots) {
		if (isBotSender) {
			logVerbose(core, runtime, `skip bot-authored message (${senderId || "unknown"})`);
			return;
		}
		if (senderId === "users/app") {
			logVerbose(core, runtime, "skip app-authored message");
			return;
		}
	}
	const messageText = (message.argumentText ?? message.text ?? "").trim();
	const attachments = message.attachment ?? [];
	const hasMedia = attachments.length > 0;
	const rawBody = messageText || (hasMedia ? "<media:attachment>" : "");
	if (!rawBody) return;
	const access = await applyGoogleChatInboundAccessPolicy({
		account,
		config,
		core,
		space,
		message,
		isGroup,
		senderId,
		senderName,
		senderEmail,
		rawBody,
		statusSink,
		logVerbose: (message) => logVerbose(core, runtime, message)
	});
	if (!access.ok) return;
	const { commandAuthorized, effectiveWasMentioned, groupBotLoopProtection, groupSystemPrompt } = access;
	if (shouldSuppressGoogleChatBotLoop({
		botLoopProtection: resolveGoogleChatBotLoopProtection({
			allowBots,
			isBotSender,
			senderId,
			appUserId,
			accountId: account.accountId,
			conversationId: spaceId,
			config: resolveGoogleChatBotLoopProtectionConfig({
				accountConfig: account.config.botLoopProtection,
				groupConfig: groupBotLoopProtection
			}),
			defaultsConfig: config.channels?.defaults?.botLoopProtection,
			eventTime: event.eventTime
		}),
		core,
		runtime
	})) return;
	const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
		cfg: config,
		channel: "googlechat",
		accountId: account.accountId,
		peer: {
			kind: isGroup ? "group" : "direct",
			id: spaceId
		},
		runtime: core.channel,
		sessionStore: config.session?.store
	});
	let mediaPath;
	let mediaType;
	if (attachments.length > 0) {
		const first = attachments[0];
		const attachmentData = await downloadAttachment(first, account, mediaMaxMb, core);
		if (attachmentData) {
			mediaPath = attachmentData.path;
			mediaType = attachmentData.contentType;
		}
	}
	const fromLabel = isGroup ? space.displayName || `space:${spaceId}` : senderName || `user:${senderId}`;
	const { storePath, body } = buildEnvelope({
		channel: "Google Chat",
		from: fromLabel,
		timestamp: event.eventTime ? Date.parse(event.eventTime) : void 0,
		body: rawBody
	});
	const ctxPayload = core.channel.turn.buildContext({
		channel: "googlechat",
		accountId: route.accountId,
		messageId: message.name,
		messageIdFull: message.name,
		timestamp: event.eventTime ? Date.parse(event.eventTime) : void 0,
		from: `googlechat:${senderId}`,
		sender: {
			id: senderId,
			name: senderName || void 0,
			username: senderEmail
		},
		conversation: {
			kind: isGroup ? "channel" : "direct",
			id: spaceId,
			label: fromLabel,
			routePeer: {
				kind: isGroup ? "group" : "direct",
				id: spaceId
			}
		},
		route: {
			agentId: route.agentId,
			accountId: route.accountId,
			routeSessionKey: route.sessionKey
		},
		reply: {
			to: `googlechat:${spaceId}`,
			originatingTo: `googlechat:${spaceId}`,
			replyToId: message.thread?.name,
			replyToIdFull: message.thread?.name
		},
		message: {
			body,
			bodyForAgent: rawBody,
			rawBody,
			commandBody: rawBody,
			envelopeFrom: fromLabel
		},
		media: mediaPath || mediaType ? [{
			path: mediaPath,
			url: mediaPath,
			contentType: mediaType
		}] : void 0,
		supplemental: { groupSystemPrompt: isGroup ? groupSystemPrompt : void 0 },
		extra: {
			ChatType: isGroup ? "channel" : "direct",
			WasMentioned: isGroup ? effectiveWasMentioned : void 0,
			CommandAuthorized: commandAuthorized,
			GroupSubject: void 0,
			GroupSpace: isGroup ? space.displayName ?? void 0 : void 0
		}
	});
	let typingIndicator = account.config.typingIndicator ?? "message";
	if (typingIndicator === "reaction") {
		runtime.error?.(`[${account.accountId}] typingIndicator="reaction" requires user OAuth (not supported with service account). Falling back to "message" mode.`);
		typingIndicator = "message";
	}
	let typingMessageName;
	if (typingIndicator === "message") try {
		typingMessageName = (await sendGoogleChatMessage({
			account,
			space: spaceId,
			text: `_${resolveBotDisplayName({
				accountName: account.config.name,
				agentId: route.agentId,
				config
			})} is typing..._`,
			thread: message.thread?.name
		}))?.messageName;
	} catch (err) {
		runtime.error?.(`Failed sending typing message: ${String(err)}`);
	}
	await core.channel.turn.run({
		channel: "googlechat",
		accountId: route.accountId,
		raw: message,
		adapter: {
			ingest: () => ({
				id: message.name ?? spaceId,
				timestamp: event.eventTime ? Date.parse(event.eventTime) : void 0,
				rawText: rawBody,
				textForAgent: rawBody,
				textForCommands: rawBody,
				raw: message
			}),
			resolveTurn: () => ({
				cfg: config,
				channel: "googlechat",
				accountId: route.accountId,
				agentId: route.agentId,
				routeSessionKey: route.sessionKey,
				storePath,
				ctxPayload,
				recordInboundSession: core.channel.session.recordInboundSession,
				dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
				delivery: {
					durable: (payload, info) => resolveGoogleChatDurableReplyOptions({
						payload,
						infoKind: info.kind,
						spaceId,
						typingMessageName
					}),
					deliver: async (payload) => {
						await deliverGoogleChatReply({
							payload,
							account,
							spaceId,
							runtime,
							core,
							config,
							statusSink,
							typingMessageName
						});
						typingMessageName = void 0;
					},
					onDelivered: () => {
						statusSink?.({ lastOutboundAt: Date.now() });
					},
					onError: (err, info) => {
						runtime.error?.(`[${account.accountId}] Google Chat ${info.kind} reply failed: ${String(err)}`);
					}
				},
				replyPipeline: {},
				record: { onRecordError: (err) => {
					runtime.error?.(`googlechat: failed updating session meta: ${String(err)}`);
				} }
			})
		}
	});
}
async function downloadAttachment(attachment, account, mediaMaxMb, core) {
	const resourceName = attachment.attachmentDataRef?.resourceName;
	if (!resourceName) return null;
	const maxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
	const downloaded = await downloadGoogleChatMedia({
		account,
		resourceName,
		maxBytes
	});
	const saved = await core.channel.media.saveMediaBuffer(downloaded.buffer, downloaded.contentType ?? attachment.contentType, "inbound", maxBytes, attachment.contentName);
	return {
		path: saved.path,
		contentType: saved.contentType
	};
}
function monitorGoogleChatProvider(options) {
	const core = getGoogleChatRuntime();
	const webhookPath = resolveWebhookPath({
		webhookPath: options.webhookPath,
		webhookUrl: options.webhookUrl,
		defaultPath: "/googlechat"
	});
	if (!webhookPath) {
		options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
		return () => {};
	}
	const audienceType = normalizeAudienceType(options.account.config.audienceType);
	const audience = options.account.config.audience?.trim();
	const mediaMaxMb = options.account.config.mediaMaxMb ?? 20;
	warnAppPrincipalMisconfiguration({
		accountId: options.account.accountId,
		audienceType,
		appPrincipal: options.account.config.appPrincipal,
		log: options.runtime.log
	});
	const unregisterTarget = registerGoogleChatWebhookTarget({
		account: options.account,
		config: options.config,
		runtime: options.runtime,
		core,
		path: webhookPath,
		audienceType,
		audience,
		statusSink: options.statusSink,
		mediaMaxMb
	});
	return () => {
		unregisterTarget();
	};
}
async function startGoogleChatMonitor(params) {
	return monitorGoogleChatProvider(params);
}
function resolveGoogleChatWebhookPath(params) {
	return resolveWebhookPath({
		webhookPath: params.account.config.webhookPath,
		webhookUrl: params.account.config.webhookUrl,
		defaultPath: "/googlechat"
	}) ?? "/googlechat";
}
//#endregion
//#region extensions/googlechat/src/channel.runtime.ts
const googleChatChannelRuntime = {
	probeGoogleChat,
	sendGoogleChatMessage,
	uploadGoogleChatAttachment,
	resolveGoogleChatWebhookPath,
	startGoogleChatMonitor
};
//#endregion
export { googleChatChannelRuntime };
