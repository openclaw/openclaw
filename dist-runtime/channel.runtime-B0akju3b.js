import "./provider-env-vars-BfZUtZAn.js";
import { $t as warnMissingProviderGroupPolicyFallbackOnce, Ht as evaluateGroupRouteAccessForPolicy, Jt as GROUP_POLICY_BLOCKED_LABEL, Xt as resolveAllowlistProviderRuntimeGroupPolicy, Zt as resolveDefaultGroupPolicy, qt as resolveSenderScopedGroupPolicy } from "./resolve-route-CQsiaDZO.js";
import "./logger-BOdgfoqz.js";
import "./tmp-openclaw-dir-DgEKZnX6.js";
import "./paths-CbmqEZIn.js";
import "./subsystem-CsPxmH8p.js";
import "./utils-CMc9mmF8.js";
import "./fetch-BgkAjqxB.js";
import "./retry-CgLvWye-.js";
import "./agent-scope-CM8plEdu.js";
import "./exec-CWMR162-.js";
import "./logger-C833gw0R.js";
import "./paths-DAoqckDF.js";
import { $o as createReplyPrefixOptions, Eo as createScopedPairingAccess, Pt as resolveDmGroupAccessWithLists, ho as readJsonWebhookBodyOrReject, mo as createWebhookInFlightLimiter, wo as issuePairingChallenge, zt as resolveMentionGatingWithBypass } from "./auth-profiles-B70DPAVa.js";
import "./profiles-BC4VpDll.js";
import "./fetch-BX2RRCzB.js";
import "./external-content-CxoN_TKD.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-gVOHvGnm.js";
import "./pairing-token-Do-E3rL5.js";
import "./query-expansion-Do6vyPvH.js";
import "./redact-BZcL_gJG.js";
import "./mime-33LCeGh-.js";
import "./resolve-utils-D6VN4BvH.js";
import "./typebox-B4kR5eyM.js";
import "./web-search-plugin-factory-CeUlA68v.js";
import "./compat-CwB8x8Tr.js";
import { c as resolveWebhookPath, i as resolveWebhookTargetWithAuthOrReject, o as withResolvedWebhookRequestPipeline, r as registerWebhookTargetWithPluginRoute, t as resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope-DsYY1Vpm.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-DBR9vEe-.js";
import "./run-command-B9zmAfEF.js";
import "./device-pairing-CsJif6Rb.js";
import "./line-DvbTO_h3.js";
import "./upsert-with-lock-BkGBN4WL.js";
import "./self-hosted-provider-setup-Bgv4n1Xv.js";
import "./ollama-setup-CXkNt6CA.js";
import { c as sendGoogleChatMessage, d as verifyGoogleChatRequest, i as downloadGoogleChatMedia, l as updateGoogleChatMessage, n as deleteGoogleChatMessage, s as probeGoogleChat, u as uploadGoogleChatAttachment } from "./api--cNHXYkU.js";
import "./json-bigint-DeX5rJv1.js";
import "./safe-buffer-jOKScm-I.js";
import "./jws-DWmhrxlV.js";
import { t as getGoogleChatRuntime } from "./runtime-BReMht0B.js";
//#region extensions/googlechat/src/monitor-access.ts
function normalizeUserId(raw) {
	const trimmed = raw?.trim() ?? "";
	if (!trimmed) return "";
	return trimmed.replace(/^users\//i, "").toLowerCase();
}
function isEmailLike(value) {
	return value.includes("@");
}
function isSenderAllowed(senderId, senderEmail, allowFrom, allowNameMatching = false) {
	if (allowFrom.includes("*")) return true;
	const normalizedSenderId = normalizeUserId(senderId);
	const normalizedEmail = senderEmail?.trim().toLowerCase() ?? "";
	return allowFrom.some((entry) => {
		const normalized = String(entry).trim().toLowerCase();
		if (!normalized) return false;
		const withoutPrefix = normalized.replace(/^(googlechat|google-chat|gchat):/i, "");
		if (withoutPrefix.startsWith("users/")) return normalizeUserId(withoutPrefix) === normalizedSenderId;
		if (allowNameMatching && normalizedEmail && isEmailLike(withoutPrefix)) return withoutPrefix === normalizedEmail;
		return withoutPrefix.replace(/^users\//i, "") === normalizedSenderId;
	});
}
function resolveGroupConfig(params) {
	const { groupId, groupName, groups } = params;
	const entries = groups ?? {};
	if (Object.keys(entries).length === 0) return {
		entry: void 0,
		allowlistConfigured: false
	};
	const normalizedName = groupName?.trim().toLowerCase();
	let entry = [
		groupId,
		groupName ?? "",
		normalizedName ?? ""
	].filter(Boolean).map((candidate) => entries[candidate]).find(Boolean);
	if (!entry && normalizedName) entry = entries[normalizedName];
	const fallback = entries["*"];
	return {
		entry: entry ?? fallback,
		allowlistConfigured: true,
		fallback
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
function warnDeprecatedUsersEmailEntries(logVerbose, entries) {
	const deprecated = entries.map((v) => String(v).trim()).filter((v) => /^users\/.+@.+/i.test(v));
	if (deprecated.length === 0) return;
	const key = deprecated.map((v) => v.toLowerCase()).sort().join(",");
	if (warnedDeprecatedUsersEmailAllowFrom.has(key)) return;
	warnedDeprecatedUsersEmailAllowFrom.add(key);
	logVerbose(`Deprecated allowFrom entry detected: "users/<email>" is no longer treated as an email allowlist. Use raw email (alice@example.com) or immutable user id (users/<id>). entries=${deprecated.join(", ")}`);
}
async function applyGoogleChatInboundAccessPolicy(params) {
	const { account, config, core, space, message, isGroup, senderId, senderName, senderEmail, rawBody, statusSink, logVerbose } = params;
	const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
	const spaceId = space.name ?? "";
	const pairing = createScopedPairingAccess({
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
	const groupConfigResolved = resolveGroupConfig({
		groupId: spaceId,
		groupName: space.displayName ?? null,
		groups: account.config.groups ?? void 0
	});
	const groupEntry = groupConfigResolved.entry;
	const groupUsers = groupEntry?.users ?? account.config.groupAllowFrom ?? [];
	let effectiveWasMentioned;
	if (isGroup) {
		const groupAllowlistConfigured = groupConfigResolved.allowlistConfigured;
		const routeAccess = evaluateGroupRouteAccessForPolicy({
			groupPolicy,
			routeAllowlistConfigured: groupAllowlistConfigured,
			routeMatched: Boolean(groupEntry),
			routeEnabled: groupEntry?.enabled !== false && groupEntry?.allow !== false
		});
		if (!routeAccess.allowed) {
			if (routeAccess.reason === "disabled") logVerbose(`drop group message (groupPolicy=disabled, space=${spaceId})`);
			else if (routeAccess.reason === "empty_allowlist") logVerbose(`drop group message (groupPolicy=allowlist, no allowlist, space=${spaceId})`);
			else if (routeAccess.reason === "route_not_allowlisted") logVerbose(`drop group message (not allowlisted, space=${spaceId})`);
			else if (routeAccess.reason === "route_disabled") logVerbose(`drop group message (space disabled, space=${spaceId})`);
			return { ok: false };
		}
		if (groupUsers.length > 0) {
			const normalizedGroupUsers = groupUsers.map((v) => String(v));
			warnDeprecatedUsersEmailEntries(logVerbose, normalizedGroupUsers);
			if (!isSenderAllowed(senderId, senderEmail, normalizedGroupUsers, allowNameMatching)) {
				logVerbose(`drop group message (sender not allowed, ${senderId})`);
				return { ok: false };
			}
		}
	}
	const dmPolicy = account.config.dm?.policy ?? "pairing";
	const configAllowFrom = (account.config.dm?.allowFrom ?? []).map((v) => String(v));
	const normalizedGroupUsers = groupUsers.map((v) => String(v));
	const senderGroupPolicy = resolveSenderScopedGroupPolicy({
		groupPolicy,
		groupAllowFrom: normalizedGroupUsers
	});
	const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
	const access = resolveDmGroupAccessWithLists({
		isGroup,
		dmPolicy,
		groupPolicy: senderGroupPolicy,
		allowFrom: configAllowFrom,
		groupAllowFrom: normalizedGroupUsers,
		storeAllowFrom: !isGroup && dmPolicy !== "allowlist" && (dmPolicy !== "open" || shouldComputeAuth) ? await pairing.readAllowFromStore().catch(() => []) : [],
		groupAllowFromFallbackToAllowFrom: false,
		isSenderAllowed: (allowFrom) => isSenderAllowed(senderId, senderEmail, allowFrom, allowNameMatching)
	});
	const effectiveAllowFrom = access.effectiveAllowFrom;
	const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
	warnDeprecatedUsersEmailEntries(logVerbose, effectiveAllowFrom);
	const commandAllowFrom = isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom;
	const useAccessGroups = config.commands?.useAccessGroups !== false;
	const senderAllowedForCommands = isSenderAllowed(senderId, senderEmail, commandAllowFrom, allowNameMatching);
	const commandAuthorized = shouldComputeAuth ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups,
		authorizers: [{
			configured: commandAllowFrom.length > 0,
			allowed: senderAllowedForCommands
		}]
	}) : void 0;
	if (isGroup) {
		const requireMention = groupEntry?.requireMention ?? account.config.requireMention ?? true;
		const mentionInfo = extractMentionInfo(message.annotations ?? [], account.config.botUser);
		const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
			cfg: config,
			surface: "googlechat"
		});
		const mentionGate = resolveMentionGatingWithBypass({
			isGroup: true,
			requireMention,
			canDetectMention: true,
			wasMentioned: mentionInfo.wasMentioned,
			implicitMention: false,
			hasAnyMention: mentionInfo.hasAnyMention,
			allowTextCommands,
			hasControlCommand: core.channel.text.hasControlCommand(rawBody, config),
			commandAuthorized: commandAuthorized === true
		});
		effectiveWasMentioned = mentionGate.effectiveWasMentioned;
		if (mentionGate.shouldSkip) {
			logVerbose(`drop group message (mention required, space=${spaceId})`);
			return { ok: false };
		}
	}
	if (isGroup && access.decision !== "allow") {
		logVerbose(`drop group message (sender policy blocked, reason=${access.reason}, space=${spaceId})`);
		return { ok: false };
	}
	if (!isGroup) {
		if (account.config.dm?.enabled === false) {
			logVerbose(`Blocked Google Chat DM from ${senderId} (dmPolicy=disabled)`);
			return { ok: false };
		}
		if (access.decision !== "allow") {
			if (access.decision === "pairing") await issuePairingChallenge({
				channel: "googlechat",
				senderId,
				senderIdLine: `Your Google Chat user id: ${senderId}`,
				meta: {
					name: senderName || void 0,
					email: senderEmail
				},
				upsertPairingRequest: pairing.upsertPairingRequest,
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
		groupSystemPrompt: groupEntry?.systemPrompt?.trim() || void 0
	};
}
//#endregion
//#region extensions/googlechat/src/monitor-webhook.ts
function extractBearerToken(header) {
	const authHeader = Array.isArray(header) ? String(header[0] ?? "") : String(header ?? "");
	return authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
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
		addOnBearerToken = String(rawObj.authorizationEventObject?.systemIdToken ?? "").trim();
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
function createGoogleChatWebhookRequestHandler(params) {
	return async (req, res) => {
		return await withResolvedWebhookRequestPipeline({
			req,
			res,
			targetsByPath: params.webhookTargets,
			allowMethods: ["POST"],
			requireJsonContentType: true,
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
					selectedTarget = await resolveWebhookTargetWithAuthOrReject({
						targets,
						res,
						isMatch: async (target) => {
							return (await verifyGoogleChatRequest({
								bearer: headerBearer,
								audienceType: target.audienceType,
								audience: target.audience,
								expectedAddOnPrincipal: target.account.config.appPrincipal
							})).ok;
						}
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
						res.statusCode = 401;
						res.end("unauthorized");
						return true;
					}
					selectedTarget = await resolveWebhookTargetWithAuthOrReject({
						targets,
						res,
						isMatch: async (target) => {
							return (await verifyGoogleChatRequest({
								bearer: parsed.addOnBearerToken,
								audienceType: target.audienceType,
								audience: target.audience,
								expectedAddOnPrincipal: target.account.config.appPrincipal
							})).ok;
						}
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
//#region extensions/googlechat/src/monitor.ts
const webhookTargets = /* @__PURE__ */ new Map();
const googleChatWebhookRequestHandler = createGoogleChatWebhookRequestHandler({
	webhookTargets,
	webhookInFlightLimiter: createWebhookInFlightLimiter(),
	processEvent: async (event, target) => {
		await processGoogleChatEvent(event, target);
	}
});
function logVerbose(core, runtime, message) {
	if (core.logging.shouldLogVerbose()) runtime.log?.(`[googlechat] ${message}`);
}
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
function normalizeAudienceType(value) {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "app-url" || normalized === "app_url" || normalized === "app") return "app-url";
	if (normalized === "project-number" || normalized === "project_number" || normalized === "project") return "project-number";
}
async function handleGoogleChatWebhookRequest(req, res) {
	return await googleChatWebhookRequestHandler(req, res);
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
	if (!(account.config.allowBots === true)) {
		if (sender?.type?.toUpperCase() === "BOT") {
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
	const { commandAuthorized, effectiveWasMentioned, groupSystemPrompt } = access;
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
	const ctxPayload = core.channel.reply.finalizeInboundContext({
		Body: body,
		BodyForAgent: rawBody,
		RawBody: rawBody,
		CommandBody: rawBody,
		From: `googlechat:${senderId}`,
		To: `googlechat:${spaceId}`,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: isGroup ? "channel" : "direct",
		ConversationLabel: fromLabel,
		SenderName: senderName || void 0,
		SenderId: senderId,
		SenderUsername: senderEmail,
		WasMentioned: isGroup ? effectiveWasMentioned : void 0,
		CommandAuthorized: commandAuthorized,
		Provider: "googlechat",
		Surface: "googlechat",
		MessageSid: message.name,
		MessageSidFull: message.name,
		ReplyToId: message.thread?.name,
		ReplyToIdFull: message.thread?.name,
		MediaPath: mediaPath,
		MediaType: mediaType,
		MediaUrl: mediaPath,
		GroupSpace: isGroup ? space.displayName ?? void 0 : void 0,
		GroupSystemPrompt: isGroup ? groupSystemPrompt : void 0,
		OriginatingChannel: "googlechat",
		OriginatingTo: `googlechat:${spaceId}`
	});
	core.channel.session.recordSessionMetaFromInbound({
		storePath,
		sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
		ctx: ctxPayload
	}).catch((err) => {
		runtime.error?.(`googlechat: failed updating session meta: ${String(err)}`);
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
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg: config,
		agentId: route.agentId,
		channel: "googlechat",
		accountId: route.accountId
	});
	await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
		ctx: ctxPayload,
		cfg: config,
		dispatcherOptions: {
			...prefixOptions,
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
			onError: (err, info) => {
				runtime.error?.(`[${account.accountId}] Google Chat ${info.kind} reply failed: ${String(err)}`);
			}
		},
		replyOptions: { onModelSelected }
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
async function deliverGoogleChatReply(params) {
	const { payload, account, spaceId, runtime, core, config, statusSink, typingMessageName } = params;
	const mediaList = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
	if (mediaList.length > 0) {
		let suppressCaption = false;
		if (typingMessageName) try {
			await deleteGoogleChatMessage({
				account,
				messageName: typingMessageName
			});
		} catch (err) {
			runtime.error?.(`Google Chat typing cleanup failed: ${String(err)}`);
			const fallbackText = payload.text?.trim() ? payload.text : mediaList.length > 1 ? "Sent attachments." : "Sent attachment.";
			try {
				await updateGoogleChatMessage({
					account,
					messageName: typingMessageName,
					text: fallbackText
				});
				suppressCaption = Boolean(payload.text?.trim());
			} catch (updateErr) {
				runtime.error?.(`Google Chat typing update failed: ${String(updateErr)}`);
			}
		}
		let first = true;
		for (const mediaUrl of mediaList) {
			const caption = first && !suppressCaption ? payload.text : void 0;
			first = false;
			try {
				const loaded = await core.channel.media.fetchRemoteMedia({
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
		return;
	}
	if (payload.text) {
		const chunkLimit = account.config.textChunkLimit ?? 4e3;
		const chunkMode = core.channel.text.resolveChunkMode(config, "googlechat", account.accountId);
		const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			try {
				if (i === 0 && typingMessageName) await updateGoogleChatMessage({
					account,
					messageName: typingMessageName,
					text: chunk
				});
				else await sendGoogleChatMessage({
					account,
					space: spaceId,
					text: chunk,
					thread: payload.replyToId
				});
				statusSink?.({ lastOutboundAt: Date.now() });
			} catch (err) {
				runtime.error?.(`Google Chat message send failed: ${String(err)}`);
			}
		}
	}
}
async function uploadAttachmentForReply(params) {
	const { account, spaceId, buffer, contentType, filename } = params;
	const { uploadGoogleChatAttachment } = await import("./api-ru_2iUj6.js");
	return await uploadGoogleChatAttachment({
		account,
		space: spaceId,
		filename,
		buffer,
		contentType
	});
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
export { probeGoogleChat, resolveGoogleChatWebhookPath, sendGoogleChatMessage, startGoogleChatMonitor, uploadGoogleChatAttachment };
