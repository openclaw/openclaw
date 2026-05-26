import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as appendRegularFile } from "./regular-file-DaVeNX32.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { p as resolveThreadSessionKeys } from "./session-key-Bte0mmcq.js";
import { n as formatAllowlistMatchMeta } from "./allowlist-match-D8Bi9YxS.js";
import { i as writeJsonFileAtomically } from "./json-store-ChgPP2Sf.js";
import { S as buildMediaPayload } from "./reply-payload-DMPQsrQC.js";
import { S as resolveChannelStreamingBlockEnabled, a as createChannelProgressDraftGate, c as formatChannelProgressDraftText, f as mergeChannelProgressDraftLine, i as buildChannelProgressDraftLineForEntry, k as resolveChannelStreamingPreviewToolProgress, m as resolveChannelPreviewStreamMode, p as normalizeChannelProgressDraftLineIdentity, r as buildChannelProgressDraftLine, u as isChannelProgressDraftWorkToolName, y as resolveChannelProgressDraftMaxLines } from "./channel-streaming-BKIuGSWW.js";
import { n as resolveInboundMentionDecision } from "./mention-gating-3P8aSD7o.js";
import { o as resolveStableChannelMessageIngress, t as channelIngressRoutes } from "./runtime-BUVuto5K.js";
import { r as resolveDefaultGroupPolicy } from "./runtime-group-policy-CmZDlIwd.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { o as saveResponseMedia } from "./fetch-C0wRQZuz.js";
import { a as deliverWithFinalizableLivePreviewAdapter, n as createPreviewMessageReceipt, r as defineFinalizableLivePreviewAdapter, s as markLiveMessageFinalized, t as createLiveMessageState } from "./live-CF0ee90S.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./routing-79DRZvfm.js";
import "./history-BD_TtuvO.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-EtNTatED.js";
import { i as resolveChannelTurnDispatchCounts, n as hasFinalChannelTurnDispatch } from "./dispatch-result-BM3RYtx4.js";
import { n as filterSupplementalContextItems, r as shouldIncludeSupplementalContext } from "./context-visibility-C9pX_aod.js";
import { t as createChannelHistoryWindow } from "./history-window-Gy0CzEef.js";
import { r as keepHttpServerTaskAlive } from "./channel-lifecycle.core-CDt0hRZR.js";
import { f as summarizeMapping, u as mergeAllowlist } from "./allow-from-CvE3rvhy.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-jjAiM0PK.js";
import "./reply-history-Dd_Mx-HZ.js";
import { t as resolveChannelContextVisibilityMode } from "./context-visibility-Si-TIKp_.js";
import { a as dispatchReplyFromConfigWithSettledDispatcher } from "./inbound-reply-dispatch-Bi01ox5N.js";
import { n as DEFAULT_WEBHOOK_MAX_BODY_BYTES } from "./http-body-BfDL157U.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { a as resolveChannelMediaMaxBytes } from "./media-runtime-BheBFFxc.js";
import "./security-runtime-CcSekjBd.js";
import { n as logInboundDrop, r as logTypingFailure } from "./logging-Dr3f0mtP.js";
import { a as resolveInboundSessionEnvelopeContext } from "./channel-inbound-C7GtKjtG.js";
import { s as createDraftStreamLoop } from "./channel-lifecycle-B7VOl7bW.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import "./channel-message-DMGbyII_.js";
import { n as createChannelPairingController } from "./channel-pairing-N4dBc-K-.js";
import { n as getOptionalMSTeamsRuntime, t as getMSTeamsRuntime } from "./runtime-api-DN6i5eom.js";
import { A as GRAPH_ROOT, B as isUrlAllowed, C as buildUserAgent, D as formatUnknownError, E as formatMSTeamsSendErrorHint, F as extractHtmlFromAttachment, G as resolveRequestUrl, H as readNestedString, I as extractInlineImageCandidates, J as tryBuildGraphSharesUrlForSharedLink, K as safeFetchWithPolicy, L as inferPlaceholder, M as applyAuthorizationHeaderForUrl, N as encodeGraphShareId, P as estimateBase64DecodedBytes, R as isDownloadableAttachment, S as loadMSTeamsSdkWithAuth, T as classifyMSTeamsSendError, U as resolveAttachmentFetchPolicy, V as normalizeContentType, W as resolveMediaSsrfPolicy, _ as resolveMSTeamsStorePath, a as fetchGraphJson, b as createMSTeamsAdapter, h as resolveMSTeamsCredentials, j as IMG_SRC_RE, k as ATTACHMENT_TAG_RE, q as safeHostForUrl, w as ensureUserAgentHeader, x as createMSTeamsTokenProvider, y as createBotFrameworkJwtValidator, z as isLikelyImageAttachment } from "./graph-users-_25MXF-j.js";
import { c as resolveMSTeamsUserAllowlist, s as resolveMSTeamsChannelAllowlist } from "./resolve-allowlist-RCWaHejE.js";
import { i as resolveMSTeamsRouteConfig, r as resolveMSTeamsReplyPolicy, t as resolveMSTeamsAllowlistMatch } from "./policy-B0_tmat6.js";
import { C as readJsonFile, S as createMSTeamsConversationStoreFs, T as writeJsonFile, _ as buildFileInfoCard, b as createMSTeamsPollStoreFs, c as renderReplyPayloadsToMessages, d as withRevokedProxyFallback, f as resolveGraphChatId, g as removePendingUploadFs, h as getPendingUploadFs, l as sendMSTeamsMessages, m as removePendingUpload, p as getPendingUpload, s as buildConversationReference, u as AI_GENERATED_ENTITY, v as parseFileConsentInvoke, w as withFileLock, x as extractMSTeamsPollVote, y as uploadToConsentUrl } from "./probe-_OPgs2va.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region extensions/msteams/src/feedback-reflection-prompt.ts
/** Max chars of the thumbed-down response to include in the reflection prompt. */
const MAX_RESPONSE_CHARS = 500;
function buildReflectionPrompt(params) {
	const parts = ["A user indicated your previous response wasn't helpful."];
	if (params.thumbedDownResponse) {
		const truncated = params.thumbedDownResponse.length > MAX_RESPONSE_CHARS ? `${params.thumbedDownResponse.slice(0, MAX_RESPONSE_CHARS)}...` : params.thumbedDownResponse;
		parts.push(`\nYour response was:\n> ${truncated}`);
	}
	if (params.userComment) parts.push(`\nUser's comment: "${params.userComment}"`);
	parts.push("\nBriefly reflect: what could you improve? Consider tone, length, accuracy, relevance, and specificity. Reply with a single JSON object only, no markdown or prose, using this exact shape:\n{\"learning\":\"...\",\"followUp\":false,\"userMessage\":\"\"}\n- learning: a short internal adjustment note (1-2 sentences) for your future behavior in this conversation.\n- followUp: true only if the user needs a direct follow-up message.\n- userMessage: only the exact user-facing message to send; empty string when followUp is false.");
	return parts.join("\n");
}
function parseBooleanLike(value) {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = normalizeOptionalLowercaseString(value);
		if (normalized === "true" || normalized === "yes") return true;
		if (normalized === "false" || normalized === "no") return false;
	}
}
function parseStructuredReflectionValue(value) {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value;
	const learning = typeof candidate.learning === "string" ? candidate.learning.trim() : void 0;
	if (!learning) return null;
	return {
		learning,
		followUp: parseBooleanLike(candidate.followUp) ?? false,
		userMessage: typeof candidate.userMessage === "string" && candidate.userMessage.trim() ? candidate.userMessage.trim() : void 0
	};
}
function parseReflectionResponse(text) {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const candidates = [trimmed, ...trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.slice(1, 2) ?? []];
	for (const candidateText of candidates) {
		const candidate = candidateText.trim();
		if (!candidate) continue;
		try {
			const parsed = parseStructuredReflectionValue(JSON.parse(candidate));
			if (parsed) return parsed;
		} catch {}
	}
	return {
		learning: trimmed,
		followUp: false
	};
}
/** Tracks last reflection time per session to enforce cooldown. */
const lastReflectionBySession = /* @__PURE__ */ new Map();
/** Maximum cooldown entries before pruning expired ones. */
const MAX_COOLDOWN_ENTRIES = 500;
function legacySanitizeSessionKey(sessionKey) {
	return sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function encodeSessionKey(sessionKey) {
	return Buffer.from(sessionKey, "utf8").toString("base64url");
}
function resolveLearningsFilePath(storePath, sessionKey) {
	return `${storePath}/${encodeSessionKey(sessionKey)}.learnings.json`;
}
function resolveLegacyLearningsFilePath(storePath, sessionKey) {
	return `${storePath}/${legacySanitizeSessionKey(sessionKey)}.learnings.json`;
}
async function readLearningsFile(filePath) {
	try {
		const content = await fs.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content);
		return {
			exists: true,
			learnings: Array.isArray(parsed) ? parsed : []
		};
	} catch {
		return {
			exists: false,
			learnings: []
		};
	}
}
/** Prune expired cooldown entries to prevent unbounded memory growth. */
function pruneExpiredCooldowns(cooldownMs) {
	if (lastReflectionBySession.size <= MAX_COOLDOWN_ENTRIES) return;
	const now = Date.now();
	for (const [key, time] of lastReflectionBySession) if (now - time >= cooldownMs) lastReflectionBySession.delete(key);
}
/** Check if a reflection is allowed (cooldown not active). */
function isReflectionAllowed(sessionKey, cooldownMs) {
	const cooldown = cooldownMs ?? 3e5;
	const lastTime = lastReflectionBySession.get(sessionKey);
	if (lastTime == null) return true;
	return Date.now() - lastTime >= cooldown;
}
/** Record that a reflection was run for a session. */
function recordReflectionTime(sessionKey, cooldownMs) {
	lastReflectionBySession.set(sessionKey, Date.now());
	pruneExpiredCooldowns(cooldownMs ?? 3e5);
}
/** Store a learning derived from feedback reflection in a session companion file. */
async function storeSessionLearning(params) {
	const learningsFile = resolveLearningsFilePath(params.storePath, params.sessionKey);
	const legacyLearningsFile = resolveLegacyLearningsFilePath(params.storePath, params.sessionKey);
	const { exists, learnings: existingLearnings } = await readLearningsFile(learningsFile);
	const { learnings: legacyLearnings } = exists || legacyLearningsFile === learningsFile ? { learnings: [] } : await readLearningsFile(legacyLearningsFile);
	let learnings = exists ? existingLearnings : legacyLearnings;
	learnings.push(params.learning);
	if (learnings.length > 10) learnings = learnings.slice(-10);
	await writeJsonFileAtomically(learningsFile, learnings);
	if (!exists && legacyLearningsFile !== learningsFile) await fs.rm(legacyLearningsFile, { force: true }).catch(() => void 0);
}
//#endregion
//#region extensions/msteams/src/feedback-reflection.ts
function buildFeedbackEvent(params) {
	return {
		type: "custom",
		event: "feedback",
		ts: Date.now(),
		messageId: params.messageId,
		value: params.value,
		comment: params.comment,
		sessionKey: params.sessionKey,
		agentId: params.agentId,
		conversationId: params.conversationId
	};
}
function buildReflectionContext(params) {
	const core = getMSTeamsRuntime();
	const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(params.cfg);
	const body = core.channel.reply.formatAgentEnvelope({
		channel: "Teams",
		from: "system",
		body: params.reflectionPrompt,
		envelope: envelopeOptions
	});
	return { ctxPayload: core.channel.reply.finalizeInboundContext({
		Body: body,
		BodyForAgent: params.reflectionPrompt,
		RawBody: params.reflectionPrompt,
		CommandBody: params.reflectionPrompt,
		From: `msteams:system:${params.conversationId}`,
		To: `conversation:${params.conversationId}`,
		SessionKey: params.sessionKey,
		ChatType: "direct",
		SenderName: "system",
		SenderId: "system",
		Provider: "msteams",
		Surface: "msteams",
		Timestamp: Date.now(),
		WasMentioned: true,
		CommandAuthorized: false,
		OriginatingChannel: "msteams",
		OriginatingTo: `conversation:${params.conversationId}`
	}) };
}
function createReflectionCaptureDispatcher(params) {
	const core = getMSTeamsRuntime();
	let response = "";
	const { dispatcher, replyOptions } = core.channel.reply.createReplyDispatcherWithTyping({
		deliver: async (payload) => {
			if (payload.text) response += (response ? "\n" : "") + payload.text;
		},
		typingCallbacks: {
			onReplyStart: async () => {},
			onIdle: () => {},
			onCleanup: () => {}
		},
		humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
		onError: (err) => {
			params.log.debug?.("reflection reply error", { error: formatUnknownError(err) });
		}
	});
	return {
		dispatcher,
		replyOptions,
		readResponse: () => response
	};
}
async function sendReflectionFollowUp(params) {
	const proactiveRef = {
		...buildConversationReference(params.conversationRef),
		activityId: void 0
	};
	await params.adapter.continueConversation(params.appId, proactiveRef, async (ctx) => {
		await ctx.sendActivity({
			type: "message",
			text: params.userMessage
		});
	});
}
/**
* Run a background reflection after negative feedback.
* This is designed to be called fire-and-forget (don't await in the invoke handler).
*/
async function runFeedbackReflection(params) {
	const { cfg, log, sessionKey } = params;
	const cooldownMs = cfg.channels?.msteams?.feedbackReflectionCooldownMs ?? 3e5;
	if (!isReflectionAllowed(sessionKey, cooldownMs)) {
		log.debug?.("skipping reflection (cooldown active)", { sessionKey });
		return;
	}
	const reflectionPrompt = buildReflectionPrompt({
		thumbedDownResponse: params.thumbedDownResponse,
		userComment: params.userComment
	});
	const storePath = getMSTeamsRuntime().channel.session.resolveStorePath(cfg.session?.store, { agentId: params.agentId });
	const { ctxPayload } = buildReflectionContext({
		cfg,
		conversationId: params.conversationId,
		sessionKey: params.sessionKey,
		reflectionPrompt
	});
	const capture = createReflectionCaptureDispatcher({
		cfg,
		agentId: params.agentId,
		log
	});
	try {
		await dispatchReplyFromConfigWithSettledDispatcher({
			ctxPayload,
			cfg,
			dispatcher: capture.dispatcher,
			onSettled: () => {},
			replyOptions: capture.replyOptions
		});
	} catch (err) {
		log.error("reflection dispatch failed", { error: formatUnknownError(err) });
		return;
	}
	const reflectionResponse = capture.readResponse().trim();
	if (!reflectionResponse) {
		log.debug?.("reflection produced no output");
		return;
	}
	const parsedReflection = parseReflectionResponse(reflectionResponse);
	if (!parsedReflection) {
		log.debug?.("reflection produced no structured output");
		return;
	}
	recordReflectionTime(sessionKey, cooldownMs);
	log.info("reflection complete", {
		sessionKey,
		responseLength: reflectionResponse.length,
		followUp: parsedReflection.followUp
	});
	try {
		await storeSessionLearning({
			storePath,
			sessionKey: params.sessionKey,
			learning: parsedReflection.learning
		});
	} catch (err) {
		log.debug?.("failed to store reflection learning", { error: formatUnknownError(err) });
	}
	const conversationType = normalizeOptionalLowercaseString(params.conversationRef.conversation?.conversationType);
	if (!(conversationType === "personal" && parsedReflection.followUp && Boolean(parsedReflection.userMessage))) {
		if (parsedReflection.followUp && conversationType !== "personal") log.debug?.("skipping reflection follow-up outside direct message", {
			sessionKey,
			conversationType
		});
		return;
	}
	try {
		await sendReflectionFollowUp({
			adapter: params.adapter,
			appId: params.appId,
			conversationRef: params.conversationRef,
			userMessage: parsedReflection.userMessage
		});
		log.info("sent reflection follow-up", { sessionKey });
	} catch (err) {
		log.debug?.("failed to send reflection follow-up", { error: formatUnknownError(err) });
	}
}
//#endregion
//#region extensions/msteams/src/inbound.ts
/**
* Decode common HTML entities to plain text.
*/
function decodeHtmlEntities(html) {
	return html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
/**
* Strip HTML tags, preserving text content.
*/
function htmlToPlainText(html) {
	return decodeHtmlEntities(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}
/**
* Extract quote info from MS Teams HTML reply attachments.
* Teams wraps quoted content in a blockquote with itemtype="http://schema.skype.com/Reply".
*/
function extractMSTeamsQuoteInfo(attachments) {
	for (const att of attachments) {
		let content = "";
		if (typeof att.content === "string") content = att.content;
		else if (typeof att.content === "object" && att.content !== null) {
			const record = att.content;
			content = typeof record.text === "string" ? record.text : typeof record.body === "string" ? record.body : "";
		}
		if (!content) continue;
		if (!content.includes("http://schema.skype.com/Reply")) continue;
		const senderMatch = /<strong[^>]*itemprop=["']mri["'][^>]*>(.*?)<\/strong>/i.exec(content);
		const sender = senderMatch?.[1] ? htmlToPlainText(senderMatch[1]) : void 0;
		const bodyMatch = /<p[^>]*itemprop=["']copy["'][^>]*>(.*?)<\/p>/is.exec(content);
		const body = bodyMatch?.[1] ? htmlToPlainText(bodyMatch[1]) : void 0;
		if (body) return {
			sender: sender ?? "unknown",
			body
		};
	}
}
function normalizeMSTeamsConversationId(raw) {
	return raw.split(";")[0] ?? raw;
}
function extractMSTeamsConversationMessageId(raw) {
	if (!raw) return;
	return (/(?:^|;)messageid=([^;]+)/i.exec(raw)?.[1]?.trim() ?? "") || void 0;
}
function parseMSTeamsActivityTimestamp(value) {
	if (!value) return;
	if (value instanceof Date) return value;
	if (typeof value !== "string") return;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? void 0 : date;
}
function stripMSTeamsMentionTags(text) {
	return text.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
}
/**
* Bot Framework uses 'a:xxx' conversation IDs for personal chats, but Graph API
* requires the '19:{userId}_{botAppId}@unq.gbl.spaces' format.
*
* This is the documented Graph API format for 1:1 chat thread IDs between a user
* and a bot/app. See Microsoft docs "Get chat between user and app":
* https://learn.microsoft.com/en-us/graph/api/userscopeteamsappinstallation-get-chat
*
* The format is only synthesized when the Bot Framework conversation ID starts with
* 'a:' (the opaque format used by BF but not recognized by Graph). If the ID already
* has the '19:...' Graph format, it is passed through unchanged.
*/
function translateMSTeamsDmConversationIdForGraph(params) {
	const { isDirectMessage, conversationId, aadObjectId, appId } = params;
	return isDirectMessage && conversationId.startsWith("a:") && aadObjectId && appId ? `19:${aadObjectId}_${appId}@unq.gbl.spaces` : conversationId;
}
function wasMSTeamsBotMentioned(activity) {
	const botId = activity.recipient?.id;
	if (!botId) return false;
	return (activity.entities ?? []).some((e) => e.type === "mention" && e.mentioned?.id === botId);
}
//#endregion
//#region extensions/msteams/src/file-consent-invoke.ts
/**
* Handle fileConsent/invoke activities for large file uploads.
*/
async function handleMSTeamsFileConsentInvoke(context, log) {
	const expiredUploadMessage = "The file upload request has expired. Please try sending the file again.";
	const activity = context.activity;
	if (activity.type !== "invoke" || activity.name !== "fileConsent/invoke") return false;
	const consentResponse = parseFileConsentInvoke(activity);
	if (!consentResponse) {
		log.debug?.("invalid file consent invoke", { value: activity.value });
		return false;
	}
	const uploadId = typeof consentResponse.context?.uploadId === "string" ? consentResponse.context.uploadId : void 0;
	const inMemoryFile = getPendingUpload(uploadId);
	const fsFile = inMemoryFile ? void 0 : await getPendingUploadFs(uploadId);
	const pendingFile = inMemoryFile ?? fsFile;
	if (pendingFile) {
		const pendingConversationId = normalizeMSTeamsConversationId(pendingFile.conversationId);
		const invokeConversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
		if (!invokeConversationId || pendingConversationId !== invokeConversationId) {
			log.info("file consent conversation mismatch", {
				uploadId,
				expectedConversationId: pendingConversationId,
				receivedConversationId: invokeConversationId || void 0
			});
			if (consentResponse.action === "accept") await context.sendActivity(expiredUploadMessage);
			return true;
		}
	}
	if (consentResponse.action === "accept" && consentResponse.uploadInfo) if (pendingFile) {
		log.debug?.("user accepted file consent, uploading", {
			uploadId,
			filename: pendingFile.filename,
			size: pendingFile.buffer.length
		});
		try {
			await uploadToConsentUrl({
				url: consentResponse.uploadInfo.uploadUrl,
				buffer: pendingFile.buffer,
				contentType: pendingFile.contentType
			});
			const fileInfoCard = buildFileInfoCard({
				filename: consentResponse.uploadInfo.name,
				contentUrl: consentResponse.uploadInfo.contentUrl,
				uniqueId: consentResponse.uploadInfo.uniqueId,
				fileType: consentResponse.uploadInfo.fileType
			});
			if (!pendingFile.consentCardActivityId) await context.sendActivity({
				type: "message",
				attachments: [fileInfoCard]
			});
			if (pendingFile.consentCardActivityId) try {
				await context.updateActivity({
					id: pendingFile.consentCardActivityId,
					type: "message",
					attachments: [fileInfoCard]
				});
			} catch {
				await context.sendActivity({
					type: "message",
					attachments: [fileInfoCard]
				});
			}
			log.info("file upload complete", {
				uploadId,
				filename: consentResponse.uploadInfo.name,
				uniqueId: consentResponse.uploadInfo.uniqueId
			});
		} catch (err) {
			log.error("file upload failed", {
				uploadId,
				error: formatUnknownError(err)
			});
			await context.sendActivity("File upload failed. Please try again.");
		} finally {
			removePendingUpload(uploadId);
			await removePendingUploadFs(uploadId);
		}
	} else {
		log.debug?.("pending file not found for consent", { uploadId });
		await context.sendActivity(expiredUploadMessage);
	}
	else {
		log.debug?.("user declined file consent", { uploadId });
		removePendingUpload(uploadId);
		await removePendingUploadFs(uploadId);
	}
	return true;
}
async function respondToMSTeamsFileConsentInvoke(context, log) {
	await context.sendActivity({
		type: "invokeResponse",
		value: { status: 200 }
	});
	try {
		await withRevokedProxyFallback({
			run: async () => await handleMSTeamsFileConsentInvoke(context, log),
			onRevoked: async () => true,
			onRevokedLog: () => {
				log.debug?.("turn context revoked during file consent invoke; skipping delayed response");
			}
		});
	} catch (err) {
		log.debug?.("file consent handler error", { error: formatUnknownError(err) });
	}
}
//#endregion
//#region extensions/msteams/src/monitor-handler/access.ts
const msteamsIngressIdentity = {
	key: "sender-id",
	normalize: normalizeIngressValue,
	aliases: [{
		key: "sender-name",
		kind: "plugin:msteams-sender-name",
		normalizeEntry: normalizeIngressValue,
		normalizeSubject: normalizeIngressValue,
		dangerous: true
	}],
	isWildcardEntry: (entry) => normalizeIngressValue(entry) === "*",
	resolveEntryId: ({ entryIndex, fieldKey }) => `msteams-entry-${entryIndex + 1}:${fieldKey === "sender-name" ? "name" : "id"}`
};
function normalizeIngressValue(value) {
	return normalizeOptionalLowercaseString(value) ?? null;
}
async function resolveMSTeamsSenderAccess(params) {
	const activity = params.activity;
	const msteamsCfg = params.cfg.channels?.msteams;
	const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "unknown");
	const convType = normalizeOptionalLowercaseString(activity.conversation?.conversationType);
	const isDirectMessage = convType === "personal" || !convType && !activity.conversation?.isGroup;
	const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
	const senderName = activity.from?.name ?? activity.from?.id ?? senderId;
	const pairing = createChannelPairingController({
		core: getMSTeamsRuntime(),
		channel: "msteams",
		accountId: DEFAULT_ACCOUNT_ID
	});
	const dmPolicy = msteamsCfg?.dmPolicy ?? "pairing";
	const configuredDmAllowFrom = msteamsCfg?.allowFrom ?? [];
	const groupAllowFrom = msteamsCfg?.groupAllowFrom;
	const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
	const groupPolicy = !isDirectMessage && msteamsCfg ? msteamsCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist" : "disabled";
	const allowNameMatching = isDangerousNameMatchingEnabled(msteamsCfg);
	const channelGate = resolveMSTeamsRouteConfig({
		cfg: msteamsCfg,
		teamId: activity.channelData?.team?.id,
		teamName: activity.channelData?.team?.name,
		conversationId,
		channelName: activity.channelData?.channel?.name,
		allowNameMatching
	});
	return {
		...await resolveStableChannelMessageIngress({
			channelId: "msteams",
			accountId: pairing.accountId,
			identity: msteamsIngressIdentity,
			cfg: params.cfg,
			readStoreAllowFrom: pairing.readAllowFromStore,
			subject: {
				stableId: senderId,
				aliases: { "sender-name": senderName }
			},
			conversation: {
				kind: isDirectMessage ? "direct" : convType === "channel" ? "channel" : "group",
				id: conversationId,
				parentId: activity.channelData?.team?.id
			},
			route: channelIngressRoutes(!isDirectMessage && channelGate.allowlistConfigured && {
				id: "msteams:team-channel",
				kind: "nestedAllowlist",
				allowed: channelGate.allowed,
				precedence: 0,
				matchId: "msteams-route",
				...channelGate.allowed && groupPolicy === "allowlist" ? {
					senderPolicy: "deny-when-empty",
					senderAllowFromSource: "effective-group"
				} : {}
			}),
			dmPolicy,
			groupPolicy,
			policy: {
				groupAllowFromFallbackToAllowFrom: true,
				mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled"
			},
			allowFrom: configuredDmAllowFrom,
			groupAllowFrom,
			command: {
				allowTextCommands: true,
				hasControlCommand: params.hasControlCommand === true,
				directGroupAllowFrom: isDirectMessage ? "effective" : "none"
			}
		}),
		pairing,
		isDirectMessage,
		conversationId,
		senderId,
		senderName,
		msteamsCfg,
		dmPolicy,
		channelGate,
		allowNameMatching,
		groupPolicy
	};
}
//#endregion
//#region extensions/msteams/src/attachments/bot-framework.ts
/**
* Bot Framework Service token scope for requesting a token used against
* the Bot Connector (v3) REST endpoints such as `/v3/attachments/{id}`.
*/
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com";
/**
* Detect Bot Framework personal chat ("a:") and MSA orgid ("8:orgid:") conversation
* IDs. These identifiers are not recognized by Graph's `/chats/{id}` endpoint, so we
* must fetch media via the Bot Framework v3 attachments endpoint instead.
*
* Graph-compatible IDs start with `19:` and are left untouched by this detector.
*/
function isBotFrameworkPersonalChatId(conversationId) {
	if (typeof conversationId !== "string") return false;
	const trimmed = conversationId.trim();
	return trimmed.startsWith("a:") || trimmed.startsWith("8:orgid:");
}
function normalizeServiceUrl(serviceUrl) {
	return serviceUrl.replace(/\/+$/, "");
}
async function fetchBotFrameworkAttachmentInfo(params) {
	const url = `${normalizeServiceUrl(params.serviceUrl)}/v3/attachments/${encodeURIComponent(params.attachmentId)}`;
	let response;
	try {
		response = await safeFetchWithPolicy({
			url,
			policy: params.policy,
			fetchFn: params.fetchFn,
			resolveFn: params.resolveFn,
			requestInit: { headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }) }
		});
	} catch (err) {
		params.logger?.warn?.("msteams botFramework attachmentInfo fetch failed", { error: err instanceof Error ? err.message : String(err) });
		return;
	}
	if (!response.ok) {
		params.logger?.warn?.("msteams botFramework attachmentInfo non-ok", { status: response.status });
		return;
	}
	try {
		return await response.json();
	} catch (err) {
		params.logger?.warn?.("msteams botFramework attachmentInfo parse failed", { error: err instanceof Error ? err.message : String(err) });
		return;
	}
}
async function saveBotFrameworkAttachmentView(params) {
	const url = `${normalizeServiceUrl(params.serviceUrl)}/v3/attachments/${encodeURIComponent(params.attachmentId)}/views/${encodeURIComponent(params.viewId)}`;
	let response;
	try {
		response = await safeFetchWithPolicy({
			url,
			policy: params.policy,
			fetchFn: params.fetchFn,
			resolveFn: params.resolveFn,
			requestInit: { headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }) }
		});
	} catch (err) {
		params.logger?.warn?.("msteams botFramework attachmentView fetch failed", { error: err instanceof Error ? err.message : String(err) });
		return;
	}
	if (!response.ok) {
		params.logger?.warn?.("msteams botFramework attachmentView non-ok", { status: response.status });
		return;
	}
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > params.maxBytes) return;
	try {
		return await getMSTeamsRuntime().channel.media.saveResponseMedia(response, {
			sourceUrl: url,
			filePathHint: params.fileNameHint,
			maxBytes: params.maxBytes,
			fallbackContentType: params.contentTypeHint,
			subdir: "inbound",
			originalFilename: params.preserveFilenames ? params.fileNameHint : void 0
		});
	} catch (err) {
		params.logger?.warn?.("msteams botFramework attachmentView save failed", { error: err instanceof Error ? err.message : String(err) });
		return;
	}
}
/**
* Download media for a single attachment via the Bot Framework v3 attachments
* endpoint. Used for personal DM conversations where the Graph `/chats/{id}`
* path is not usable because the Bot Framework conversation ID (`a:...`) is
* not a valid Graph chat identifier.
*/
async function downloadMSTeamsBotFrameworkAttachment(params) {
	if (!params.serviceUrl || !params.attachmentId || !params.tokenProvider) return;
	const policy = resolveAttachmentFetchPolicy({
		allowHosts: params.allowHosts,
		authAllowHosts: params.authAllowHosts
	});
	if (!isUrlAllowed(`${normalizeServiceUrl(params.serviceUrl)}/v3/attachments/${encodeURIComponent(params.attachmentId)}`, policy.allowHosts)) return;
	let accessToken;
	try {
		accessToken = await params.tokenProvider.getAccessToken(BOT_FRAMEWORK_SCOPE);
	} catch (err) {
		params.logger?.warn?.("msteams botFramework token acquisition failed", { error: err instanceof Error ? err.message : String(err) });
		return;
	}
	if (!accessToken) return;
	const info = await fetchBotFrameworkAttachmentInfo({
		serviceUrl: params.serviceUrl,
		attachmentId: params.attachmentId,
		accessToken,
		policy,
		fetchFn: params.fetchFn,
		resolveFn: params.resolveFn,
		logger: params.logger
	});
	if (!info) return;
	const views = Array.isArray(info.views) ? info.views : [];
	const candidateView = views.find((view) => view?.viewId === "original") ?? views.find((view) => typeof view?.viewId === "string");
	const viewId = typeof candidateView?.viewId === "string" && candidateView.viewId ? candidateView.viewId : void 0;
	if (!viewId) return;
	if (typeof candidateView?.size === "number" && candidateView.size > 0 && candidateView.size > params.maxBytes) return;
	const fileNameHint = typeof params.fileNameHint === "string" && params.fileNameHint || typeof info.name === "string" && info.name || void 0;
	const contentTypeHint = typeof params.contentTypeHint === "string" && params.contentTypeHint || typeof info.type === "string" && info.type || void 0;
	const saved = await saveBotFrameworkAttachmentView({
		serviceUrl: params.serviceUrl,
		attachmentId: params.attachmentId,
		viewId,
		accessToken,
		maxBytes: params.maxBytes,
		fileNameHint,
		contentTypeHint,
		preserveFilenames: params.preserveFilenames,
		policy,
		fetchFn: params.fetchFn,
		resolveFn: params.resolveFn,
		logger: params.logger
	});
	if (!saved) return;
	return {
		path: saved.path,
		contentType: saved.contentType,
		placeholder: inferPlaceholder({
			contentType: saved.contentType,
			fileName: fileNameHint
		})
	};
}
/**
* Download media for every attachment referenced by a Bot Framework personal
* chat activity. Returns all successfully fetched media along with diagnostics
* compatible with `downloadMSTeamsGraphMedia`'s result shape so callers can
* reuse the existing logging path.
*/
async function downloadMSTeamsBotFrameworkAttachments(params) {
	const seen = /* @__PURE__ */ new Set();
	const unique = [];
	for (const id of params.attachmentIds ?? []) {
		if (typeof id !== "string") continue;
		const trimmed = id.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		unique.push(trimmed);
	}
	if (unique.length === 0 || !params.serviceUrl || !params.tokenProvider) return {
		media: [],
		attachmentCount: unique.length
	};
	const media = [];
	for (const attachmentId of unique) try {
		const item = await downloadMSTeamsBotFrameworkAttachment({
			serviceUrl: params.serviceUrl,
			attachmentId,
			tokenProvider: params.tokenProvider,
			maxBytes: params.maxBytes,
			allowHosts: params.allowHosts,
			authAllowHosts: params.authAllowHosts,
			fetchFn: params.fetchFn,
			resolveFn: params.resolveFn,
			fileNameHint: params.fileNameHint,
			contentTypeHint: params.contentTypeHint,
			preserveFilenames: params.preserveFilenames,
			logger: params.logger
		});
		if (item) media.push(item);
	} catch (err) {
		params.logger?.warn?.("msteams botFramework attachment download failed", {
			error: err instanceof Error ? err.message : String(err),
			attachmentId
		});
	}
	return {
		media,
		attachmentCount: unique.length
	};
}
//#endregion
//#region extensions/msteams/src/attachments/remote-media.ts
/**
* Direct fetch path used when the caller's `fetchImpl` has already validated
* the URL against a hostname allowlist (for example `safeFetchWithPolicy`).
*
* Bypasses the strict SSRF dispatcher on `readRemoteMediaBuffer` because:
*   1. The pinned undici dispatcher used by `readRemoteMediaBuffer` is incompatible
*      with Node 24+'s built-in undici v7 (fails with "invalid onRequestStart
*      method"), which silently breaks SharePoint/OneDrive downloads. See
*      issue #63396.
*   2. SSRF protection is already enforced by the caller's `fetchImpl`
*      (`safeFetch` validates every redirect hop against the hostname
*      allowlist before following).
*/
async function saveRemoteMediaDirect(params) {
	return await saveResponseMedia(await params.fetchImpl(params.url, { redirect: "follow" }), {
		sourceUrl: params.url,
		filePathHint: params.filePathHint,
		maxBytes: params.maxBytes,
		fallbackContentType: params.contentTypeHint,
		originalFilename: params.originalFilename
	});
}
async function downloadAndStoreMSTeamsRemoteMedia(params) {
	const originalFilename = params.preserveFilenames ? params.filePathHint : void 0;
	let saved;
	if (params.useDirectFetch && params.fetchImpl) saved = await saveRemoteMediaDirect({
		url: params.url,
		filePathHint: params.filePathHint,
		fetchImpl: params.fetchImpl,
		maxBytes: params.maxBytes,
		contentTypeHint: params.contentTypeHint,
		originalFilename
	});
	else saved = await getMSTeamsRuntime().channel.media.saveRemoteMedia({
		url: params.url,
		fetchImpl: params.fetchImpl,
		filePathHint: params.filePathHint,
		maxBytes: params.maxBytes,
		ssrfPolicy: params.ssrfPolicy,
		fallbackContentType: params.contentTypeHint,
		originalFilename
	});
	return {
		path: saved.path,
		contentType: saved.contentType,
		placeholder: params.placeholder ?? inferPlaceholder({
			contentType: saved.contentType,
			fileName: params.filePathHint
		})
	};
}
//#endregion
//#region extensions/msteams/src/attachments/download.ts
function resolveDownloadCandidate(att) {
	const contentType = normalizeContentType(att.contentType);
	const name = normalizeOptionalString(att.name) ?? "";
	if (contentType === "application/vnd.microsoft.teams.file.download.info") {
		if (!isRecord(att.content)) return null;
		const downloadUrl = normalizeOptionalString(att.content.downloadUrl) ?? "";
		if (!downloadUrl) return null;
		const fileType = normalizeOptionalString(att.content.fileType) ?? "";
		const uniqueId = normalizeOptionalString(att.content.uniqueId) ?? "";
		const fileName = normalizeOptionalString(att.content.fileName) ?? "";
		const fileHint = name || fileName || (uniqueId && fileType ? `${uniqueId}.${fileType}` : "");
		return {
			url: downloadUrl,
			fileHint: fileHint || void 0,
			contentTypeHint: void 0,
			placeholder: inferPlaceholder({
				contentType,
				fileName: fileHint,
				fileType
			})
		};
	}
	const contentUrl = normalizeOptionalString(att.contentUrl) ?? "";
	if (!contentUrl) return null;
	const sharesUrl = tryBuildGraphSharesUrlForSharedLink(contentUrl);
	return {
		url: sharesUrl ?? contentUrl,
		fileHint: name || void 0,
		contentTypeHint: sharesUrl ? void 0 : contentType,
		placeholder: inferPlaceholder({
			contentType,
			fileName: name
		})
	};
}
function scopeCandidatesForUrl(url) {
	try {
		const host = normalizeLowercaseStringOrEmpty(new URL(url).hostname);
		return host.endsWith("graph.microsoft.com") || host.endsWith("sharepoint.com") || host.endsWith("1drv.ms") || host.includes("sharepoint") ? ["https://graph.microsoft.com", "https://api.botframework.com"] : ["https://api.botframework.com", "https://graph.microsoft.com"];
	} catch {
		return ["https://api.botframework.com", "https://graph.microsoft.com"];
	}
}
function isRedirectStatus(status) {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
async function resolveInlineDataImageMime(inline) {
	const mime = normalizeOptionalLowercaseString(await getMSTeamsRuntime().media.detectMime({
		buffer: inline.data,
		headerMime: inline.contentType
	}) ?? inline.contentType);
	return mime?.startsWith("image/") ? mime : void 0;
}
async function fetchWithAuthFallback(params) {
	const firstAttempt = await safeFetchWithPolicy({
		url: params.url,
		policy: params.policy,
		fetchFn: params.fetchFn,
		requestInit: params.requestInit,
		resolveFn: params.resolveFn
	});
	if (firstAttempt.ok) return firstAttempt;
	if (!params.tokenProvider) return firstAttempt;
	if (firstAttempt.status !== 401 && firstAttempt.status !== 403) return firstAttempt;
	if (!isUrlAllowed(params.url, params.policy.authAllowHosts)) return firstAttempt;
	const scopes = scopeCandidatesForUrl(params.url);
	const fetchFn = params.fetchFn ?? fetch;
	for (const scope of scopes) try {
		const token = await params.tokenProvider.getAccessToken(scope);
		const authHeaders = new Headers(params.requestInit?.headers);
		authHeaders.set("Authorization", `Bearer ${token}`);
		const authAttempt = await safeFetchWithPolicy({
			url: params.url,
			policy: params.policy,
			fetchFn,
			requestInit: {
				...params.requestInit,
				headers: authHeaders
			},
			resolveFn: params.resolveFn
		});
		if (authAttempt.ok) return authAttempt;
		if (isRedirectStatus(authAttempt.status)) return authAttempt;
		if (authAttempt.status !== 401 && authAttempt.status !== 403) continue;
	} catch {}
	return firstAttempt;
}
/**
* Download all file attachments from a Teams message (images, documents, etc.).
* Renamed from downloadMSTeamsImageAttachments to support all file types.
*/
async function downloadMSTeamsAttachments(params) {
	const list = Array.isArray(params.attachments) ? params.attachments : [];
	if (list.length === 0) return [];
	const policy = resolveAttachmentFetchPolicy({
		allowHosts: params.allowHosts,
		authAllowHosts: params.authAllowHosts
	});
	const allowHosts = policy.allowHosts;
	const ssrfPolicy = resolveMediaSsrfPolicy(allowHosts);
	const candidates = list.filter(isDownloadableAttachment).map(resolveDownloadCandidate).filter(Boolean);
	const inlineCandidates = extractInlineImageCandidates(list, {
		maxInlineBytes: params.maxBytes,
		maxInlineTotalBytes: params.maxBytes
	});
	const seenUrls = /* @__PURE__ */ new Set();
	for (const inline of inlineCandidates) if (inline.kind === "url") {
		if (!isUrlAllowed(inline.url, allowHosts)) continue;
		if (seenUrls.has(inline.url)) continue;
		seenUrls.add(inline.url);
		candidates.push({
			url: inline.url,
			fileHint: inline.fileHint,
			contentTypeHint: inline.contentType,
			placeholder: inline.placeholder
		});
	}
	if (candidates.length === 0 && inlineCandidates.length === 0) return [];
	const out = [];
	for (const inline of inlineCandidates) {
		if (inline.kind !== "data") continue;
		if (inline.data.byteLength > params.maxBytes) continue;
		try {
			const contentType = await resolveInlineDataImageMime(inline);
			if (!contentType) continue;
			const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(inline.data, contentType, "inbound", params.maxBytes);
			out.push({
				path: saved.path,
				contentType: saved.contentType,
				placeholder: inferPlaceholder({ contentType: saved.contentType ?? contentType })
			});
		} catch (err) {
			params.logger?.warn?.("msteams inline attachment decode failed", { error: err instanceof Error ? err.message : String(err) });
		}
	}
	for (const candidate of candidates) {
		if (!isUrlAllowed(candidate.url, allowHosts)) continue;
		try {
			const media = await downloadAndStoreMSTeamsRemoteMedia({
				url: candidate.url,
				filePathHint: candidate.fileHint ?? candidate.url,
				maxBytes: params.maxBytes,
				contentTypeHint: candidate.contentTypeHint,
				placeholder: candidate.placeholder,
				preserveFilenames: params.preserveFilenames,
				ssrfPolicy,
				useDirectFetch: true,
				fetchImpl: (input, init) => fetchWithAuthFallback({
					url: resolveRequestUrl(input),
					tokenProvider: params.tokenProvider,
					fetchFn: params.fetchFn,
					requestInit: init,
					resolveFn: params.resolveFn,
					policy
				})
			});
			out.push(media);
		} catch (err) {
			params.logger?.warn?.("msteams attachment download failed", {
				error: err instanceof Error ? err.message : String(err),
				host: safeHostForLog(candidate.url)
			});
		}
	}
	return out;
}
function safeHostForLog(url) {
	try {
		return new URL(url).host;
	} catch {
		return "invalid-url";
	}
}
//#endregion
//#region extensions/msteams/src/attachments/graph.ts
function buildMSTeamsGraphMessageUrls(params) {
	const conversationType = normalizeLowercaseStringOrEmpty(params.conversationType ?? "");
	const messageIdCandidates = /* @__PURE__ */ new Set();
	const pushCandidate = (value) => {
		const trimmed = normalizeOptionalString(value) ?? "";
		if (trimmed) messageIdCandidates.add(trimmed);
	};
	pushCandidate(params.messageId);
	pushCandidate(params.conversationMessageId);
	pushCandidate(readNestedString(params.channelData, ["messageId"]));
	pushCandidate(readNestedString(params.channelData, ["teamsMessageId"]));
	const replyToId = normalizeOptionalString(params.replyToId) ?? "";
	if (conversationType === "channel") {
		const teamId = readNestedString(params.channelData, ["team", "id"]) ?? readNestedString(params.channelData, ["teamId"]);
		const channelId = readNestedString(params.channelData, ["channel", "id"]) ?? readNestedString(params.channelData, ["channelId"]) ?? readNestedString(params.channelData, ["teamsChannelId"]);
		if (!teamId || !channelId) return [];
		const urls = [];
		if (replyToId) for (const candidate of messageIdCandidates) {
			if (candidate === replyToId) continue;
			urls.push(`${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(replyToId)}/replies/${encodeURIComponent(candidate)}`);
		}
		if (messageIdCandidates.size === 0 && replyToId) messageIdCandidates.add(replyToId);
		for (const candidate of messageIdCandidates) urls.push(`${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(candidate)}`);
		return Array.from(new Set(urls));
	}
	const chatId = params.conversationId?.trim() || readNestedString(params.channelData, ["chatId"]);
	if (!chatId) return [];
	if (messageIdCandidates.size === 0 && replyToId) messageIdCandidates.add(replyToId);
	const urls = Array.from(messageIdCandidates).map((candidate) => `${GRAPH_ROOT}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(candidate)}`);
	return Array.from(new Set(urls));
}
async function fetchGraphCollection(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const { response, release } = await fetchWithSsrFGuard({
		url: params.url,
		fetchImpl: fetchFn,
		init: { headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }) },
		policy: params.ssrfPolicy,
		auditContext: "msteams.graph.collection"
	});
	try {
		const status = response.status;
		if (!response.ok) return {
			status,
			items: []
		};
		try {
			const data = await response.json();
			return {
				status,
				items: Array.isArray(data.value) ? data.value : []
			};
		} catch {
			return {
				status,
				items: []
			};
		}
	} finally {
		await release();
	}
}
function normalizeGraphAttachment(att) {
	let content = att.content;
	if (typeof content === "string") try {
		content = JSON.parse(content);
	} catch {}
	return {
		contentType: normalizeContentType(att.contentType) ?? void 0,
		contentUrl: att.contentUrl ?? void 0,
		name: att.name ?? void 0,
		thumbnailUrl: att.thumbnailUrl ?? void 0,
		content
	};
}
/**
* Download all hosted content from a Teams message (images, documents, etc.).
* Renamed from downloadGraphHostedImages to support all file types.
*/
async function downloadGraphHostedContent(params) {
	const hosted = await fetchGraphCollection({
		url: `${params.messageUrl}/hostedContents`,
		accessToken: params.accessToken,
		fetchFn: params.fetchFn,
		ssrfPolicy: params.ssrfPolicy
	});
	if (hosted.items.length === 0) return {
		media: [],
		status: hosted.status,
		count: 0
	};
	const out = [];
	for (const item of hosted.items) {
		const contentBytes = typeof item.contentBytes === "string" ? item.contentBytes : "";
		let buffer;
		if (contentBytes) {
			if (estimateBase64DecodedBytes(contentBytes) > params.maxBytes) continue;
			try {
				buffer = Buffer.from(contentBytes, "base64");
			} catch (err) {
				params.logger?.warn?.("msteams graph hostedContent base64 decode failed", { error: err instanceof Error ? err.message : String(err) });
				continue;
			}
		} else if (item.id) {
			try {
				const valueUrl = `${params.messageUrl}/hostedContents/${encodeURIComponent(item.id)}/$value`;
				const { response: valRes, release } = await fetchWithSsrFGuard({
					url: valueUrl,
					fetchImpl: params.fetchFn ?? fetch,
					init: { headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }) },
					policy: params.ssrfPolicy,
					auditContext: "msteams.graph.hostedContent.value"
				});
				try {
					if (!valRes.ok) continue;
					const saved = await getMSTeamsRuntime().channel.media.saveResponseMedia(valRes, {
						sourceUrl: valueUrl,
						maxBytes: params.maxBytes,
						fallbackContentType: item.contentType ?? void 0,
						subdir: "inbound"
					});
					out.push({
						path: saved.path,
						contentType: saved.contentType,
						placeholder: inferPlaceholder({ contentType: saved.contentType })
					});
				} finally {
					await release();
				}
			} catch (err) {
				params.logger?.warn?.("msteams graph hostedContent value fetch failed", { error: err instanceof Error ? err.message : String(err) });
				continue;
			}
			continue;
		} else continue;
		if (buffer.byteLength > params.maxBytes) continue;
		const mime = await getMSTeamsRuntime().media.detectMime({
			buffer,
			headerMime: item.contentType ?? void 0
		});
		try {
			const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(buffer, mime ?? item.contentType ?? void 0, "inbound", params.maxBytes);
			out.push({
				path: saved.path,
				contentType: saved.contentType,
				placeholder: inferPlaceholder({ contentType: saved.contentType })
			});
		} catch (err) {
			params.logger?.warn?.("msteams graph hostedContent save failed", { error: err instanceof Error ? err.message : String(err) });
		}
	}
	return {
		media: out,
		status: hosted.status,
		count: hosted.items.length
	};
}
async function downloadMSTeamsGraphMedia(params) {
	if (!params.messageUrl || !params.tokenProvider) return { media: [] };
	const policy = resolveAttachmentFetchPolicy({
		allowHosts: params.allowHosts,
		authAllowHosts: params.authAllowHosts
	});
	const ssrfPolicy = resolveMediaSsrfPolicy(policy.allowHosts);
	const messageUrl = params.messageUrl;
	const debugLog = params.log ?? params.logger ?? void 0;
	let accessToken;
	try {
		accessToken = await params.tokenProvider.getAccessToken("https://graph.microsoft.com");
	} catch (err) {
		debugLog?.debug?.("graph media token acquisition failed", {
			messageUrl,
			error: err instanceof Error ? err.message : String(err)
		});
		params.logger?.warn?.("msteams graph token acquisition failed", { error: err instanceof Error ? err.message : String(err) });
		return {
			media: [],
			messageUrl,
			tokenError: true
		};
	}
	const fetchFn = params.fetchFn ?? fetch;
	const sharePointMedia = [];
	const downloadedReferenceUrls = /* @__PURE__ */ new Set();
	let messageAttachments = [];
	let messageStatus;
	try {
		const { response: msgRes, release } = await fetchWithSsrFGuard({
			url: messageUrl,
			fetchImpl: fetchFn,
			init: { headers: ensureUserAgentHeader({ Authorization: `Bearer ${accessToken}` }) },
			policy: ssrfPolicy,
			auditContext: "msteams.graph.message"
		});
		try {
			messageStatus = msgRes.status;
			if (msgRes.ok) {
				let msgData;
				try {
					msgData = await msgRes.json();
				} catch (err) {
					debugLog?.debug?.("graph media message parse failed", {
						messageUrl,
						error: err instanceof Error ? err.message : String(err)
					});
					params.logger?.warn?.("msteams graph message parse failed", {
						error: err instanceof Error ? err.message : String(err),
						messageUrl
					});
					msgData = {};
				}
				messageAttachments = Array.isArray(msgData.attachments) ? msgData.attachments : [];
				const spAttachments = messageAttachments.filter((a) => a.contentType === "reference" && a.contentUrl && a.name);
				for (const att of spAttachments) {
					const name = att.name ?? "file";
					const shareUrl = att.contentUrl ?? "";
					if (!shareUrl) continue;
					try {
						const sharesUrl = `${GRAPH_ROOT}/shares/${encodeGraphShareId(shareUrl)}/driveItem/content`;
						if (!isUrlAllowed(sharesUrl, policy.allowHosts)) {
							debugLog?.debug?.("graph media sharepoint url not in allowHosts", {
								messageUrl,
								sharesUrl
							});
							continue;
						}
						const media = await downloadAndStoreMSTeamsRemoteMedia({
							url: sharesUrl,
							filePathHint: name,
							maxBytes: params.maxBytes,
							contentTypeHint: "application/octet-stream",
							preserveFilenames: params.preserveFilenames,
							ssrfPolicy,
							useDirectFetch: true,
							fetchImpl: async (input, init) => {
								const requestUrl = resolveRequestUrl(input);
								const headers = ensureUserAgentHeader(init?.headers);
								applyAuthorizationHeaderForUrl({
									headers,
									url: requestUrl,
									authAllowHosts: policy.authAllowHosts,
									bearerToken: accessToken
								});
								return await safeFetchWithPolicy({
									url: requestUrl,
									policy,
									fetchFn,
									requestInit: {
										...init,
										headers
									},
									resolveFn: params.resolveFn
								});
							}
						});
						sharePointMedia.push(media);
						downloadedReferenceUrls.add(shareUrl);
					} catch (err) {
						params.logger?.warn?.("msteams SharePoint reference download failed", {
							error: err instanceof Error ? err.message : String(err),
							name
						});
					}
				}
			} else debugLog?.debug?.("graph media message fetch not ok", {
				messageUrl,
				status: messageStatus
			});
		} finally {
			await release();
		}
	} catch (err) {
		debugLog?.debug?.("graph media message fetch failed", {
			messageUrl,
			error: err instanceof Error ? err.message : String(err)
		});
		params.logger?.warn?.("msteams graph message fetch failed", { error: err instanceof Error ? err.message : String(err) });
	}
	const hosted = await downloadGraphHostedContent({
		accessToken,
		messageUrl,
		maxBytes: params.maxBytes,
		fetchFn: params.fetchFn,
		preserveFilenames: params.preserveFilenames,
		ssrfPolicy,
		logger: params.logger
	});
	const normalizedAttachments = messageAttachments.map(normalizeGraphAttachment);
	const filteredAttachments = sharePointMedia.length > 0 ? normalizedAttachments.filter((att) => {
		if (normalizeOptionalLowercaseString(att.contentType) !== "reference") return true;
		const url = typeof att.contentUrl === "string" ? att.contentUrl : "";
		if (!url) return true;
		return !downloadedReferenceUrls.has(url);
	}) : normalizedAttachments;
	let attachmentMedia = [];
	try {
		attachmentMedia = await downloadMSTeamsAttachments({
			attachments: filteredAttachments,
			maxBytes: params.maxBytes,
			tokenProvider: params.tokenProvider,
			allowHosts: policy.allowHosts,
			authAllowHosts: policy.authAllowHosts,
			fetchFn: params.fetchFn,
			resolveFn: params.resolveFn,
			preserveFilenames: params.preserveFilenames,
			logger: params.logger
		});
	} catch (err) {
		params.logger?.warn?.("msteams graph attachment download failed", {
			error: err instanceof Error ? err.message : String(err),
			messageUrl
		});
	}
	return {
		media: [
			...sharePointMedia,
			...hosted.media,
			...attachmentMedia
		],
		hostedCount: hosted.count,
		attachmentCount: filteredAttachments.length + sharePointMedia.length,
		hostedStatus: hosted.status,
		attachmentStatus: messageStatus,
		messageUrl
	};
}
//#endregion
//#region extensions/msteams/src/attachments/html.ts
/**
* Extract every `<attachment id="...">` reference from the HTML attachments in
* the inbound activity. Returns the complete (non-sliced) list; callers that
* need a capped diagnostic summary can truncate after calling this helper.
*/
function extractMSTeamsHtmlAttachmentIds(attachments) {
	const list = Array.isArray(attachments) ? attachments : [];
	if (list.length === 0) return [];
	const ids = /* @__PURE__ */ new Set();
	for (const att of list) {
		const html = extractHtmlFromAttachment(att);
		if (!html) continue;
		ATTACHMENT_TAG_RE.lastIndex = 0;
		let match = ATTACHMENT_TAG_RE.exec(html);
		while (match) {
			const id = match[1]?.trim();
			if (id) ids.add(id);
			match = ATTACHMENT_TAG_RE.exec(html);
		}
	}
	return Array.from(ids);
}
function summarizeMSTeamsHtmlAttachments(attachments) {
	const list = Array.isArray(attachments) ? attachments : [];
	if (list.length === 0) return;
	let htmlAttachments = 0;
	let imgTags = 0;
	let dataImages = 0;
	let cidImages = 0;
	const srcHosts = /* @__PURE__ */ new Set();
	let attachmentTags = 0;
	const attachmentIds = /* @__PURE__ */ new Set();
	for (const att of list) {
		const html = extractHtmlFromAttachment(att);
		if (!html) continue;
		htmlAttachments += 1;
		IMG_SRC_RE.lastIndex = 0;
		let match = IMG_SRC_RE.exec(html);
		while (match) {
			imgTags += 1;
			const src = match[1]?.trim();
			if (src) if (src.startsWith("data:")) dataImages += 1;
			else if (src.startsWith("cid:")) cidImages += 1;
			else srcHosts.add(safeHostForUrl(src));
			match = IMG_SRC_RE.exec(html);
		}
		ATTACHMENT_TAG_RE.lastIndex = 0;
		let attachmentMatch = ATTACHMENT_TAG_RE.exec(html);
		while (attachmentMatch) {
			attachmentTags += 1;
			const id = attachmentMatch[1]?.trim();
			if (id) attachmentIds.add(id);
			attachmentMatch = ATTACHMENT_TAG_RE.exec(html);
		}
	}
	if (htmlAttachments === 0) return;
	return {
		htmlAttachments,
		imgTags,
		dataImages,
		cidImages,
		srcHosts: Array.from(srcHosts).slice(0, 5),
		attachmentTags,
		attachmentIds: Array.from(attachmentIds).slice(0, 5)
	};
}
function buildMSTeamsAttachmentPlaceholder(attachments, limits) {
	const list = Array.isArray(attachments) ? attachments : [];
	if (list.length === 0) return "";
	const totalImages = list.filter(isLikelyImageAttachment).length + extractInlineImageCandidates(list, limits).length;
	if (totalImages > 0) return `<media:image>${totalImages > 1 ? ` (${totalImages} images)` : ""}`;
	const count = list.length;
	return `<media:document>${count > 1 ? ` (${count} files)` : ""}`;
}
//#endregion
//#region extensions/msteams/src/attachments/payload.ts
function buildMSTeamsMediaPayload(mediaList) {
	return buildMediaPayload(mediaList, { preserveMediaTypeCardinality: true });
}
//#endregion
//#region extensions/msteams/src/graph-thread.ts
const teamGroupIdCache = /* @__PURE__ */ new Map();
const CACHE_TTL_MS = 600 * 1e3;
/**
* Strip HTML tags from Teams message content, preserving @mention display names.
* Teams wraps mentions in <at>Name</at> tags.
*/
function stripHtmlFromTeamsMessage(html) {
	let text = html.replace(/<at[^>]*>(.*?)<\/at>/gi, "@$1");
	text = text.replace(/<[^>]*>/g, " ");
	text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
	return text.replace(/\s+/g, " ").trim();
}
/**
* Resolve the Azure AD group GUID for a Teams conversation team ID.
* Results are cached with a TTL to avoid repeated Graph API calls.
*/
async function resolveTeamGroupId(token, conversationTeamId) {
	const cached = teamGroupIdCache.get(conversationTeamId);
	if (cached && cached.expiresAt > Date.now()) return cached.groupId;
	try {
		const groupId = (await fetchGraphJson({
			token,
			path: `/teams/${encodeURIComponent(conversationTeamId)}?$select=id`
		})).id ?? conversationTeamId;
		teamGroupIdCache.set(conversationTeamId, {
			groupId,
			expiresAt: Date.now() + CACHE_TTL_MS
		});
		return groupId;
	} catch {
		return conversationTeamId;
	}
}
/**
* Fetch a single channel message (the parent/root of a thread).
* Returns undefined on error so callers can degrade gracefully.
*/
async function fetchChannelMessage(token, groupId, channelId, messageId) {
	const path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}?$select=id,from,body,createdDateTime`;
	try {
		return await fetchGraphJson({
			token,
			path
		});
	} catch {
		return;
	}
}
/**
* Fetch thread replies for a channel message, ordered chronologically.
*
* **Limitation:** The Graph API replies endpoint (`/messages/{id}/replies`) does not
* support `$orderby`, so results are always returned in ascending (oldest-first) order.
* Combined with the `$top` cap of 50, this means only the **oldest 50 replies** are
* returned for long threads — newer replies are silently omitted. There is currently no
* Graph API workaround for this; pagination via `@odata.nextLink` can retrieve more
* replies but still in ascending order only.
*/
async function fetchThreadReplies(token, groupId, channelId, messageId, limit = 50) {
	return (await fetchGraphJson({
		token,
		path: `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies?$top=${Math.min(Math.max(limit, 1), 50)}&$select=id,from,body,createdDateTime`
	})).value ?? [];
}
/**
* Format thread messages into a context string for the agent.
* Skips the current message (by id) and blank messages.
*/
function formatThreadContext(messages, currentMessageId) {
	const lines = [];
	for (const msg of messages) {
		if (msg.id && msg.id === currentMessageId) continue;
		const sender = msg.from?.user?.displayName ?? msg.from?.application?.displayName ?? "unknown";
		const contentType = msg.body?.contentType ?? "text";
		const rawContent = msg.body?.content ?? "";
		const content = contentType === "html" ? stripHtmlFromTeamsMessage(rawContent) : rawContent.trim();
		if (!content) continue;
		lines.push(`${sender}: ${content}`);
	}
	return lines.join("\n");
}
//#endregion
//#region extensions/msteams/src/thread-parent-context.ts
const PARENT_CACHE_TTL_MS = 300 * 1e3;
const PARENT_CACHE_MAX = 100;
const parentCache = /* @__PURE__ */ new Map();
const INJECTED_MAX = 200;
const injectedParents = /* @__PURE__ */ new Map();
function touchLru(map, key, value, max) {
	if (map.has(key)) map.delete(key);
	else if (map.size >= max) {
		const firstKey = map.keys().next().value;
		if (firstKey !== void 0) map.delete(firstKey);
	}
	map.set(key, value);
}
function buildParentCacheKey(groupId, channelId, parentId) {
	return `${groupId}\u0000${channelId}\u0000${parentId}`;
}
/**
* Fetch a channel parent message with an LRU+TTL cache.
*
* Uses the injected `fetchParent` (defaults to `fetchChannelMessage`) so
* tests can swap in a stub without mocking the Graph transport.
*/
async function fetchParentMessageCached(token, groupId, channelId, parentId, fetchParent = fetchChannelMessage) {
	const key = buildParentCacheKey(groupId, channelId, parentId);
	const now = Date.now();
	const cached = parentCache.get(key);
	if (cached && cached.expiresAt > now) {
		parentCache.delete(key);
		parentCache.set(key, cached);
		return cached.message;
	}
	const message = await fetchParent(token, groupId, channelId, parentId);
	touchLru(parentCache, key, {
		message,
		expiresAt: now + PARENT_CACHE_TTL_MS
	}, PARENT_CACHE_MAX);
	return message;
}
const PARENT_TEXT_MAX_CHARS = 400;
/**
* Extract a compact summary (sender + plain-text body) from a Graph parent
* message. Returns undefined when the parent cannot be summarized (missing
* or blank body).
*/
function summarizeParentMessage(message) {
	if (!message) return;
	const sender = message.from?.user?.displayName ?? message.from?.application?.displayName ?? "unknown";
	const contentType = message.body?.contentType ?? "text";
	const raw = message.body?.content ?? "";
	const text = contentType === "html" ? stripHtmlFromTeamsMessage(raw) : raw.replace(/\s+/g, " ").trim();
	if (!text) return;
	return {
		sender,
		text: text.length > PARENT_TEXT_MAX_CHARS ? `${text.slice(0, PARENT_TEXT_MAX_CHARS - 1)}…` : text
	};
}
/**
* Build the single-line `Replying to @sender: body` system event text.
* Callers should pass this text to `enqueueSystemEvent` together with a
* stable contextKey derived from the parent id.
*/
function formatParentContextEvent(summary) {
	return `Replying to @${summary.sender}: ${summary.text}`;
}
/**
* Decide whether a parent context event should be enqueued for the current
* session. Returns `false` when we already injected the same parent for this
* session recently (prevents re-prepending identical context on every reply
* in the thread).
*/
function shouldInjectParentContext(sessionKey, parentId) {
	const key = sessionKey;
	return injectedParents.get(key) !== parentId;
}
/**
* Record that `parentId` was just injected for `sessionKey` so subsequent
* replies with the same parent can short-circuit via `shouldInjectParentContext`.
*/
function markParentContextInjected(sessionKey, parentId) {
	touchLru(injectedParents, sessionKey, parentId, INJECTED_MAX);
}
//#endregion
//#region extensions/msteams/src/streaming-message.ts
/**
* Teams streaming message using the streaminfo entity protocol.
*
* Follows the official Teams SDK pattern:
* 1. First chunk → POST a typing activity with streaminfo entity (streamType: "streaming")
* 2. Subsequent chunks → POST typing activities with streaminfo + incrementing streamSequence
* 3. Finalize → POST a message activity with streaminfo (streamType: "final")
*
* Uses the shared draft-stream-loop for throttling (avoids rate limits).
*/
/** Default throttle interval between stream updates (ms).
* Teams docs recommend buffering tokens for 1.5-2s; limit is 1 req/s. */
const DEFAULT_THROTTLE_MS = 1500;
/** Minimum chars before sending the first streaming message. */
const MIN_INITIAL_CHARS = 20;
/** Teams message text limit. */
const TEAMS_MAX_CHARS = 4e3;
/**
* Stop streaming before Teams expires the content stream server-side.
* The exact service limit is opaque, so stay comfortably under it.
*/
const MAX_STREAM_AGE_MS = 45e3;
function extractId(response) {
	if (response && typeof response === "object" && "id" in response) return readStringValue(response.id);
}
function buildStreamInfoEntity(streamId, streamType, streamSequence) {
	const entity = {
		type: "streaminfo",
		streamType
	};
	if (streamId) entity.streamId = streamId;
	if (streamSequence != null) entity.streamSequence = streamSequence;
	return entity;
}
var TeamsHttpStream = class {
	constructor(options) {
		this.accumulatedText = "";
		this.streamId = void 0;
		this.sequenceNumber = 0;
		this.stopped = false;
		this.finalized = false;
		this.streamFailed = false;
		this.lastStreamedText = "";
		this.finalMessageId = void 0;
		this.streamStartedAt = void 0;
		this.sendActivity = options.sendActivity;
		this.feedbackLoopEnabled = options.feedbackLoopEnabled ?? false;
		this.onError = options.onError;
		this.loop = createDraftStreamLoop({
			throttleMs: options.throttleMs ?? DEFAULT_THROTTLE_MS,
			isStopped: () => this.stopped,
			sendOrEditStreamMessage: (text) => this.pushStreamChunk(text)
		});
	}
	/**
	* Send an informative status update (blue progress bar in Teams).
	* Call this immediately when a message is received, before LLM starts generating.
	* Establishes the stream so subsequent chunks continue from this stream ID.
	*/
	async sendInformativeUpdate(text) {
		if (this.stopped || this.finalized) return;
		this.sequenceNumber++;
		const activity = {
			type: "typing",
			text,
			entities: [buildStreamInfoEntity(this.streamId, "informative", this.sequenceNumber)]
		};
		try {
			const response = await this.sendActivity(activity);
			if (!this.streamId) this.streamId = extractId(response);
		} catch (err) {
			this.onError?.(err);
		}
	}
	/**
	* Ingest partial text from the LLM token stream.
	* Called by onPartialReply — accumulates text and throttles updates.
	*/
	update(text) {
		if (this.stopped || this.finalized) return;
		this.accumulatedText = text;
		if (!this.streamId && this.accumulatedText.length < MIN_INITIAL_CHARS) return;
		if (this.accumulatedText.length > TEAMS_MAX_CHARS) {
			this.streamFailed = true;
			this.finalize();
			return;
		}
		if (this.streamStartedAt && Date.now() - this.streamStartedAt >= MAX_STREAM_AGE_MS) {
			this.streamFailed = true;
			this.finalize();
			return;
		}
		this.loop.update(this.accumulatedText);
	}
	/**
	* Replace an informative progress update with final answer text.
	* Returns false when the stream could not safely carry the final text, so
	* callers can deliver the answer through the normal Teams message path.
	*/
	async replaceInformativeWithFinal(text) {
		if (this.stopped || this.finalized) return false;
		this.update(text);
		await this.loop.flush();
		await this.finalize();
		return !this.streamFailed && this.hasContent;
	}
	/**
	* Finalize the stream — send the final message activity.
	*/
	async finalize() {
		if (this.finalized) return this.finalMessageId;
		this.finalized = true;
		this.stopped = true;
		this.loop.stop();
		await this.loop.waitForInFlight();
		if (!this.accumulatedText.trim()) return this.finalMessageId;
		if (this.streamFailed) {
			if (this.streamId) try {
				const response = await this.sendActivity({
					type: "message",
					text: this.lastStreamedText || "",
					channelData: { feedbackLoopEnabled: this.feedbackLoopEnabled },
					entities: [AI_GENERATED_ENTITY, buildStreamInfoEntity(this.streamId, "final")]
				});
				this.finalMessageId = extractId(response);
			} catch {}
			return this.finalMessageId;
		}
		try {
			const entities = [AI_GENERATED_ENTITY];
			if (this.streamId) entities.push(buildStreamInfoEntity(this.streamId, "final"));
			const finalActivity = {
				type: "message",
				text: this.accumulatedText,
				channelData: { feedbackLoopEnabled: this.feedbackLoopEnabled },
				entities
			};
			const response = await this.sendActivity(finalActivity);
			this.finalMessageId = extractId(response);
		} catch (err) {
			this.streamFailed = true;
			this.onError?.(err);
		}
		return this.finalMessageId;
	}
	/** Whether streaming successfully delivered content (at least one chunk sent, not failed). */
	get hasContent() {
		return this.accumulatedText.length > 0 && !this.streamFailed;
	}
	/** Whether streaming failed and fallback delivery is needed. */
	get isFailed() {
		return this.streamFailed;
	}
	/** Number of characters successfully streamed before failure. */
	get streamedLength() {
		return this.lastStreamedText.length;
	}
	/** Whether the stream has been finalized. */
	get isFinalized() {
		return this.finalized;
	}
	/** Platform id returned by the final message activity, when available. */
	get messageId() {
		return this.finalMessageId;
	}
	/** Stream id returned by the first streaminfo activity, when available. */
	get previewStreamId() {
		return this.streamId;
	}
	/** Whether streaming fell back (not used in this implementation). */
	get isFallback() {
		return false;
	}
	/**
	* Send a single streaming chunk as a typing activity with streaminfo.
	* Per the Teams REST API spec:
	* - First chunk: no streamId, streamSequence=1 → returns 201 with { id: streamId }
	* - Subsequent chunks: include streamId, increment streamSequence → returns 202
	*/
	async pushStreamChunk(text) {
		if (this.stopped && !this.finalized) return false;
		this.sequenceNumber++;
		const activity = {
			type: "typing",
			text,
			entities: [buildStreamInfoEntity(this.streamId, "streaming", this.sequenceNumber)]
		};
		try {
			const response = await this.sendActivity(activity);
			if (!this.streamStartedAt) this.streamStartedAt = Date.now();
			if (!this.streamId) this.streamId = extractId(response);
			this.lastStreamedText = text;
			return true;
		} catch (err) {
			const axiosData = err?.response;
			const statusCode = axiosData?.status ?? err?.statusCode;
			const responseBody = axiosData?.data ? JSON.stringify(axiosData.data).slice(0, 300) : "";
			const msg = formatUnknownError(err);
			this.onError?.(/* @__PURE__ */ new Error(`stream POST failed (HTTP ${statusCode ?? "?"}): ${msg}${responseBody ? ` body=${responseBody}` : ""}`));
			this.streamFailed = true;
			return false;
		}
	}
};
//#endregion
//#region extensions/msteams/src/reply-stream-controller.ts
function createTeamsReplyStreamController(params) {
	const isPersonal = normalizeOptionalLowercaseString(params.conversationType) === "personal";
	const streamMode = resolveChannelPreviewStreamMode(params.msteamsConfig, "partial");
	const shouldUseNativeStream = isPersonal && (streamMode === "partial" || streamMode === "progress");
	const shouldSuppressDefaultToolProgressMessages = shouldUseNativeStream && streamMode === "progress";
	const shouldStreamPreviewToolProgress = shouldSuppressDefaultToolProgressMessages && resolveChannelStreamingPreviewToolProgress(params.msteamsConfig);
	const stream = shouldUseNativeStream ? new TeamsHttpStream({
		sendActivity: (activity) => params.context.sendActivity(activity),
		feedbackLoopEnabled: params.feedbackLoopEnabled,
		onError: (err) => {
			params.log.debug?.(`stream error: ${formatUnknownError(err)}`);
		}
	}) : void 0;
	let streamReceivedTokens = false;
	let informativeUpdateSent = false;
	let progressLines = [];
	let lastInformativeText = "";
	let pendingFinalize;
	let liveState = createLiveMessageState({ canFinalizeInPlace: Boolean(stream) });
	const markStreamFinalized = () => {
		if (!stream || stream.isFailed) return;
		const messageId = stream.messageId ?? stream.previewStreamId;
		if (!messageId) return;
		liveState = markLiveMessageFinalized(liveState, createPreviewMessageReceipt({ id: messageId }));
	};
	const renderInformativeUpdate = async () => {
		if (!stream) return;
		const informativeText = formatChannelProgressDraftText({
			entry: params.msteamsConfig,
			lines: shouldStreamPreviewToolProgress ? progressLines : [],
			seed: params.progressSeed,
			bullet: "-"
		});
		if (!informativeText || informativeText === lastInformativeText) return;
		lastInformativeText = informativeText;
		informativeUpdateSent = true;
		await stream.sendInformativeUpdate(informativeText);
	};
	const progressDraftGate = createChannelProgressDraftGate({ onStart: renderInformativeUpdate });
	const noteProgressWork = async (options) => {
		if (!stream || streamMode !== "progress") return;
		if (options?.toolName !== void 0 && !isChannelProgressDraftWorkToolName(options.toolName)) return;
		const hadStarted = progressDraftGate.hasStarted;
		await progressDraftGate.noteWork();
		if (hadStarted && progressDraftGate.hasStarted) await renderInformativeUpdate();
	};
	const pushProgressLine = async (line, options) => {
		if (!stream || streamMode !== "progress") return;
		if (options?.toolName !== void 0 && !isChannelProgressDraftWorkToolName(options.toolName)) return;
		if (shouldStreamPreviewToolProgress) {
			const normalized = normalizeChannelProgressDraftLineIdentity(line);
			if (normalized) progressLines = mergeChannelProgressDraftLine(progressLines, typeof line === "object" && line !== void 0 ? line : normalized, { maxLines: resolveChannelProgressDraftMaxLines(params.msteamsConfig) });
		}
		await noteProgressWork();
	};
	const fallbackAfterStreamFailure = (payload, hasMedia) => {
		if (!payload.text) return payload;
		const streamedLength = stream?.streamedLength ?? 0;
		if (streamedLength <= 0) return payload;
		const remainingText = payload.text.slice(streamedLength);
		if (!remainingText) return hasMedia ? {
			...payload,
			text: void 0
		} : void 0;
		return {
			...payload,
			text: remainingText
		};
	};
	const finalizeProgressPayload = async (payload, hasMedia) => {
		if (!stream || !payload.text) return payload;
		return (await deliverWithFinalizableLivePreviewAdapter({
			kind: "final",
			payload,
			liveState,
			adapter: defineFinalizableLivePreviewAdapter({
				draft: {
					flush: async () => {},
					clear: async () => {},
					id: () => stream.previewStreamId
				},
				buildFinalEdit: (candidate) => candidate.text ? { text: candidate.text } : void 0,
				editFinal: async (_previewId, edit) => {
					const finalized = await stream.replaceInformativeWithFinal(edit.text);
					informativeUpdateSent = false;
					if (!finalized || stream.isFailed) throw new Error("Teams progress stream finalization failed");
				},
				resolveFinalizedId: (previewId) => stream.messageId ?? stream.previewStreamId ?? previewId,
				createPreviewReceipt: (id) => createPreviewMessageReceipt({ id }),
				onPreviewFinalized: (_id, _receipt, state) => {
					liveState = state;
				},
				logPreviewEditFailure: (err) => {
					params.log.debug?.(`stream finalization failed: ${formatUnknownError(err)}`);
				}
			}),
			deliverNormally: async () => false
		})).kind === "preview-finalized" ? hasMedia ? {
			...payload,
			text: void 0
		} : void 0 : payload;
	};
	return {
		async onReplyStart() {},
		async noteProgressWork(options) {
			await noteProgressWork(options);
		},
		onPartialReply(payload) {
			if (!stream || !payload.text) return;
			if (streamMode === "progress") return;
			streamReceivedTokens = true;
			stream.update(payload.text);
		},
		async pushProgressLine(line, options) {
			await pushProgressLine(line, options);
		},
		shouldSuppressDefaultToolProgressMessages() {
			return shouldSuppressDefaultToolProgressMessages;
		},
		shouldStreamPreviewToolProgress() {
			return shouldStreamPreviewToolProgress;
		},
		async preparePayload(payload) {
			const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
			if (stream && streamMode === "progress" && informativeUpdateSent && !stream.isFinalized) {
				if (!payload.text) return payload;
				return await finalizeProgressPayload(payload, hasMedia);
			}
			if (!stream || !streamReceivedTokens) return payload;
			if (stream.isFailed) {
				streamReceivedTokens = false;
				return fallbackAfterStreamFailure(payload, hasMedia);
			}
			if (!stream.hasContent || stream.isFinalized) return payload;
			streamReceivedTokens = false;
			pendingFinalize = stream.finalize().then(() => {
				markStreamFinalized();
			});
			if (!hasMedia) return;
			return {
				...payload,
				text: void 0
			};
		},
		async finalize() {
			progressDraftGate.cancel();
			await pendingFinalize;
			if (!pendingFinalize) {
				await stream?.finalize();
				markStreamFinalized();
			}
		},
		hasStream() {
			return Boolean(stream);
		},
		liveState() {
			return liveState;
		},
		/**
		* Whether the Teams streaming card is currently receiving LLM tokens.
		* Used to gate side-channel keepalive activity so we don't overlay plain
		* "typing" indicators on top of a live streaming card.
		*
		* Returns true only while the stream is actively chunking text into the
		* streaming card. The informative update (blue progress bar) is short
		* lived so we intentionally do not count it as "active"; this way the
		* typing keepalive can still fire during the informative window and
		* during tool chains between text segments.
		*
		* Returns false when:
		* - No stream exists (non-personal conversation).
		* - Stream has not yet received any text tokens.
		* - Stream has been finalized (e.g. after the first text segment, while
		*   tools run before the next segment).
		*/
		isStreamActive() {
			if (!stream) return false;
			if (stream.isFinalized || stream.isFailed) return false;
			return streamReceivedTokens;
		}
	};
}
//#endregion
//#region extensions/msteams/src/reply-dispatcher.ts
function createMSTeamsReplyDispatcher(params) {
	const core = getMSTeamsRuntime();
	const msteamsCfg = params.cfg.channels?.msteams;
	const conversationType = normalizeOptionalLowercaseString(params.conversationRef.conversation?.conversationType);
	const isTypingSupported = conversationType === "personal" || conversationType === "groupchat";
	/**
	* Keepalive cadence for the typing indicator while the bot is running
	* (including long tool chains). Bot Framework 1:1 TurnContext proxies
	* expire after ~30s of inactivity; sending a typing activity every 8s
	* keeps the proxy alive so the post-tool reply can still land via the
	* turn context. Sits in the middle of the 5-10s range recommended in
	* #59731.
	*/
	const TYPING_KEEPALIVE_INTERVAL_MS = 8e3;
	/**
	* TTL ceiling for the typing keepalive loop. The default in
	* createTypingCallbacks is 60s, which is too short for the Teams long tool
	* chains described in #59731 (60s+ total runs are common). Give tool
	* chains up to 10 minutes before auto-stopping the keepalive.
	*/
	const TYPING_KEEPALIVE_MAX_DURATION_MS = 10 * 6e4;
	const streamActiveRef = { current: () => false };
	const rawSendTypingIndicator = async () => {
		await withRevokedProxyFallback({
			run: async () => {
				await params.context.sendActivity({ type: "typing" });
			},
			onRevoked: async () => {
				const baseRef = buildConversationReference(params.conversationRef);
				await params.adapter.continueConversation(params.appId, {
					...baseRef,
					activityId: void 0
				}, async (ctx) => {
					await ctx.sendActivity({ type: "typing" });
				});
			},
			onRevokedLog: () => {
				params.log.debug?.("turn context revoked, sending typing via proactive messaging");
			}
		});
	};
	const sendTypingIndicator = isTypingSupported ? async () => {
		if (streamActiveRef.current()) return;
		await rawSendTypingIndicator();
	} : async () => {};
	const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "msteams",
		accountId: params.accountId,
		typing: {
			start: sendTypingIndicator,
			keepaliveIntervalMs: TYPING_KEEPALIVE_INTERVAL_MS,
			maxDurationMs: TYPING_KEEPALIVE_MAX_DURATION_MS,
			onStartError: (err) => {
				logTypingFailure({
					log: (message) => params.log.debug?.(message),
					channel: "msteams",
					action: "start",
					error: err
				});
			}
		}
	});
	const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "msteams");
	const tableMode = core.channel.text.resolveMarkdownTableMode({
		cfg: params.cfg,
		channel: "msteams"
	});
	const mediaMaxBytes = resolveChannelMediaMaxBytes({
		cfg: params.cfg,
		resolveChannelLimitMb: ({ cfg }) => cfg.channels?.msteams?.mediaMaxMb
	});
	const feedbackLoopEnabled = params.cfg.channels?.msteams?.feedbackEnabled !== false;
	const streamController = createTeamsReplyStreamController({
		conversationType,
		context: params.context,
		feedbackLoopEnabled,
		log: params.log,
		msteamsConfig: msteamsCfg,
		progressSeed: `${params.accountId ?? "default"}:${params.conversationRef.conversation?.id ?? ""}`
	});
	streamActiveRef.current = () => streamController.isStreamActive();
	const resolvedBlockStreamingEnabled = resolveChannelPreviewStreamMode(msteamsCfg, "partial") === "block" ? true : resolveChannelStreamingBlockEnabled(msteamsCfg);
	const blockStreamingEnabled = resolvedBlockStreamingEnabled ?? false;
	const typingIndicatorEnabled = typeof msteamsCfg?.typingIndicator === "boolean" ? msteamsCfg.typingIndicator : true;
	const pendingMessages = [];
	const sendMessages = async (messages) => {
		return sendMSTeamsMessages({
			replyStyle: params.replyStyle,
			adapter: params.adapter,
			appId: params.appId,
			conversationRef: params.conversationRef,
			context: params.context,
			messages,
			retry: {},
			onRetry: (event) => {
				params.log.debug?.("retrying send", {
					replyStyle: params.replyStyle,
					...event
				});
			},
			tokenProvider: params.tokenProvider,
			sharePointSiteId: params.sharePointSiteId,
			mediaMaxBytes,
			feedbackLoopEnabled
		});
	};
	const queueDeliveryFailureSystemEvent = (failure) => {
		const classification = classifyMSTeamsSendError(failure.error);
		const errorText = formatUnknownError(failure.error);
		const failedAll = failure.failed >= failure.total;
		const sentences = [
			`Microsoft Teams delivery failed: ${failedAll ? "the previous reply was not delivered" : `${failure.failed} of ${failure.total} message blocks were not delivered`}.`,
			`The user may not have received ${failedAll ? "that reply" : "the full reply"}.`,
			`Error: ${errorText}.`,
			classification.statusCode != null ? `Status: ${classification.statusCode}.` : void 0,
			classification.kind === "transient" || classification.kind === "throttled" ? "Retrying later may succeed." : void 0
		].filter(Boolean);
		core.system.enqueueSystemEvent(sentences.join(" "), {
			sessionKey: params.sessionKey,
			contextKey: `msteams:delivery-failure:${params.conversationRef.conversation?.id ?? "unknown"}`
		});
	};
	const flushPendingMessages = async () => {
		if (pendingMessages.length === 0) return;
		const toSend = pendingMessages.splice(0);
		const total = toSend.length;
		let ids;
		try {
			ids = await sendMessages(toSend);
		} catch (batchError) {
			ids = [];
			let failed = 0;
			let lastFailedError = batchError;
			for (const msg of toSend) try {
				const msgIds = await sendMessages([msg]);
				ids.push(...msgIds);
			} catch (msgError) {
				failed += 1;
				lastFailedError = msgError;
				params.log.debug?.("individual message send failed, continuing with remaining blocks");
			}
			if (failed > 0) {
				params.log.warn?.(`failed to deliver ${failed} of ${total} message blocks`, {
					failed,
					total
				});
				queueDeliveryFailureSystemEvent({
					failed,
					total,
					error: lastFailedError
				});
			}
		}
		if (ids.length > 0) params.onSentMessageIds?.(ids);
	};
	const { dispatcher, replyOptions, markDispatchIdle: baseMarkDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
		...replyPipeline,
		humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
		onReplyStart: async () => {
			await streamController.onReplyStart();
			if (typingIndicatorEnabled) await typingCallbacks?.onReplyStart?.();
		},
		typingCallbacks,
		deliver: async (payload) => {
			const preparedPayload = await streamController.preparePayload(payload);
			if (!preparedPayload) return;
			const messages = renderReplyPayloadsToMessages([preparedPayload], {
				textChunkLimit: params.textLimit,
				chunkText: true,
				mediaMode: "split",
				tableMode,
				chunkMode
			});
			pendingMessages.push(...messages);
			if (blockStreamingEnabled) await flushPendingMessages();
		},
		onError: (err, info) => {
			const errMsg = formatUnknownError(err);
			const classification = classifyMSTeamsSendError(err);
			const hint = formatMSTeamsSendErrorHint(classification);
			params.runtime.error?.(`msteams ${info.kind} reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`);
			params.log.error("reply failed", {
				kind: info.kind,
				error: errMsg,
				classification,
				hint
			});
		}
	});
	const markDispatchIdle = () => {
		return flushPendingMessages().catch((err) => {
			const errMsg = formatUnknownError(err);
			const classification = classifyMSTeamsSendError(err);
			const hint = formatMSTeamsSendErrorHint(classification);
			params.runtime.error?.(`msteams flush reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`);
			params.log.error("flush reply failed", {
				error: errMsg,
				classification,
				hint
			});
		}).then(() => {
			return streamController.finalize().catch((err) => {
				params.log.debug?.("stream finalize failed", { error: formatUnknownError(err) });
			});
		}).finally(() => {
			baseMarkDispatchIdle();
		});
	};
	return {
		dispatcher,
		replyOptions: {
			...replyOptions,
			...streamController.hasStream() ? {
				onPartialReply: (payload) => streamController.onPartialReply(payload),
				onToolStart: async (payload) => {
					await streamController.noteProgressWork({ toolName: payload.name });
				},
				onItemEvent: async () => {
					await streamController.noteProgressWork();
				},
				onPlanUpdate: async (payload) => {
					if (payload.phase === "update") await streamController.noteProgressWork();
				},
				onApprovalEvent: async (payload) => {
					if (payload.phase === "requested") await streamController.noteProgressWork();
				},
				onCommandOutput: async (payload) => {
					if (payload.phase === "end") await streamController.noteProgressWork();
				},
				onPatchSummary: async (payload) => {
					if (payload.phase === "end") await streamController.noteProgressWork();
				}
			} : {},
			...streamController.shouldSuppressDefaultToolProgressMessages() ? { suppressDefaultToolProgressMessages: true } : {},
			...streamController.shouldStreamPreviewToolProgress() ? {
				onToolStart: async (payload) => {
					await streamController.pushProgressLine(buildChannelProgressDraftLineForEntry(msteamsCfg, {
						event: "tool",
						name: payload.name,
						phase: payload.phase,
						args: payload.args
					}, payload.detailMode ? { detailMode: payload.detailMode } : void 0), { toolName: payload.name });
				},
				onItemEvent: async (payload) => {
					await streamController.pushProgressLine(buildChannelProgressDraftLineForEntry(msteamsCfg, {
						event: "item",
						itemId: payload.itemId,
						itemKind: payload.kind,
						title: payload.title,
						name: payload.name,
						phase: payload.phase,
						status: payload.status,
						summary: payload.summary,
						progressText: payload.progressText,
						meta: payload.meta
					}));
				},
				onPlanUpdate: async (payload) => {
					if (payload.phase !== "update") return;
					await streamController.pushProgressLine(buildChannelProgressDraftLine({
						event: "plan",
						phase: payload.phase,
						title: payload.title,
						explanation: payload.explanation,
						steps: payload.steps
					}));
				},
				onApprovalEvent: async (payload) => {
					if (payload.phase !== "requested") return;
					await streamController.pushProgressLine(buildChannelProgressDraftLine({
						event: "approval",
						phase: payload.phase,
						title: payload.title,
						command: payload.command,
						reason: payload.reason,
						message: payload.message
					}));
				},
				onCommandOutput: async (payload) => {
					if (payload.phase !== "end") return;
					await streamController.pushProgressLine(buildChannelProgressDraftLine({
						event: "command-output",
						phase: payload.phase,
						title: payload.title,
						name: payload.name,
						status: payload.status,
						exitCode: payload.exitCode
					}));
				},
				onPatchSummary: async (payload) => {
					if (payload.phase !== "end") return;
					await streamController.pushProgressLine(buildChannelProgressDraftLine({
						event: "patch",
						phase: payload.phase,
						title: payload.title,
						name: payload.name,
						added: payload.added,
						modified: payload.modified,
						deleted: payload.deleted,
						summary: payload.summary
					}));
				}
			} : {},
			disableBlockStreaming: typeof resolvedBlockStreamingEnabled === "boolean" ? !resolvedBlockStreamingEnabled : void 0,
			onModelSelected
		},
		markDispatchIdle
	};
}
//#endregion
//#region extensions/msteams/src/sent-message-cache.ts
const TTL_MS = 1440 * 60 * 1e3;
const PERSISTENT_MAX_ENTRIES = 1e3;
const PERSISTENT_NAMESPACE = "msteams.sent-messages";
const MSTEAMS_SENT_MESSAGES_KEY = Symbol.for("openclaw.msteamsSentMessages");
let sentMessageCache;
let persistentStore;
let persistentStoreDisabled = false;
function getSentMessageCache() {
	if (!sentMessageCache) {
		const globalStore = globalThis;
		sentMessageCache = globalStore[MSTEAMS_SENT_MESSAGES_KEY] ?? /* @__PURE__ */ new Map();
		globalStore[MSTEAMS_SENT_MESSAGES_KEY] = sentMessageCache;
	}
	return sentMessageCache;
}
function makePersistentKey(conversationId, messageId) {
	return `${conversationId}:${messageId}`;
}
function reportPersistentSentMessageError(error) {
	try {
		getOptionalMSTeamsRuntime()?.logging.getChildLogger({
			plugin: "msteams",
			feature: "sent-message-state"
		}).warn("Microsoft Teams persistent sent-message state failed", { error: String(error) });
	} catch {}
}
function disablePersistentSentMessageStore(error) {
	persistentStoreDisabled = true;
	persistentStore = void 0;
	reportPersistentSentMessageError(error);
}
function getPersistentSentMessageStore() {
	if (persistentStoreDisabled) return;
	if (persistentStore) return persistentStore;
	const runtime = getOptionalMSTeamsRuntime();
	if (!runtime) return;
	try {
		persistentStore = runtime.state.openKeyedStore({
			namespace: PERSISTENT_NAMESPACE,
			maxEntries: PERSISTENT_MAX_ENTRIES,
			defaultTtlMs: TTL_MS
		});
		return persistentStore;
	} catch (error) {
		disablePersistentSentMessageStore(error);
		return;
	}
}
function cleanupExpired(scopeKey, entry, now) {
	for (const [id, timestamp] of entry) if (now - timestamp > TTL_MS) entry.delete(id);
	if (entry.size === 0) getSentMessageCache().delete(scopeKey);
}
function rememberSentMessageInMemory(conversationId, messageId, sentAt) {
	const store = getSentMessageCache();
	let entry = store.get(conversationId);
	if (!entry) {
		entry = /* @__PURE__ */ new Map();
		store.set(conversationId, entry);
	}
	entry.set(messageId, sentAt);
	if (entry.size > 200) cleanupExpired(conversationId, entry, sentAt);
}
function rememberPersistentSentMessage(params) {
	const store = getPersistentSentMessageStore();
	if (!store) return;
	store.register(makePersistentKey(params.conversationId, params.messageId), { sentAt: params.sentAt }).catch(disablePersistentSentMessageStore);
}
async function lookupPersistentSentMessage(params) {
	const store = getPersistentSentMessageStore();
	if (!store) return;
	try {
		return (await store.lookup(makePersistentKey(params.conversationId, params.messageId)))?.sentAt;
	} catch (error) {
		disablePersistentSentMessageStore(error);
		return;
	}
}
function recordMSTeamsSentMessage(conversationId, messageId) {
	if (!conversationId || !messageId) return;
	const now = Date.now();
	rememberSentMessageInMemory(conversationId, messageId, now);
	rememberPersistentSentMessage({
		conversationId,
		messageId,
		sentAt: now
	});
}
function wasMSTeamsMessageSent(conversationId, messageId) {
	const entry = getSentMessageCache().get(conversationId);
	if (!entry) return false;
	cleanupExpired(conversationId, entry, Date.now());
	return entry.has(messageId);
}
async function wasMSTeamsMessageSentWithPersistence(params) {
	if (!params.conversationId || !params.messageId) return false;
	if (wasMSTeamsMessageSent(params.conversationId, params.messageId)) return true;
	const sentAt = await lookupPersistentSentMessage(params);
	if (sentAt == null) return false;
	rememberSentMessageInMemory(params.conversationId, params.messageId, sentAt);
	return wasMSTeamsMessageSent(params.conversationId, params.messageId);
}
//#endregion
//#region extensions/msteams/src/monitor-handler/inbound-media.ts
async function resolveMSTeamsInboundMedia(params) {
	const { attachments, htmlSummary, maxBytes, tokenProvider, allowHosts, conversationType, conversationId, conversationMessageId, serviceUrl, activity, log, preserveFilenames } = params;
	let mediaList = await downloadMSTeamsAttachments({
		attachments,
		maxBytes,
		tokenProvider,
		allowHosts,
		authAllowHosts: params.authAllowHosts,
		preserveFilenames,
		logger: log
	});
	if (mediaList.length === 0) {
		const attachmentIds = extractMSTeamsHtmlAttachmentIds(attachments);
		const hasHtmlFileAttachment = attachmentIds.length > 0;
		if (hasHtmlFileAttachment && isBotFrameworkPersonalChatId(conversationId)) if (!serviceUrl) log.debug?.("bot framework attachment skipped (missing serviceUrl)", {
			conversationType,
			conversationId
		});
		else {
			const bfMedia = await downloadMSTeamsBotFrameworkAttachments({
				serviceUrl,
				attachmentIds,
				tokenProvider,
				maxBytes,
				allowHosts,
				authAllowHosts: params.authAllowHosts,
				preserveFilenames
			});
			if (bfMedia.media.length > 0) mediaList = bfMedia.media;
			else log.debug?.("bot framework attachments fetch empty", {
				conversationType,
				attachmentCount: bfMedia.attachmentCount ?? attachmentIds.length
			});
		}
		if (hasHtmlFileAttachment && mediaList.length === 0 && !isBotFrameworkPersonalChatId(conversationId)) {
			const messageUrls = buildMSTeamsGraphMessageUrls({
				conversationType,
				conversationId,
				messageId: activity.id ?? void 0,
				replyToId: activity.replyToId ?? void 0,
				conversationMessageId,
				channelData: activity.channelData
			});
			if (messageUrls.length === 0) log.debug?.("graph message url unavailable", {
				conversationType,
				hasChannelData: Boolean(activity.channelData),
				messageId: activity.id ?? void 0,
				replyToId: activity.replyToId ?? void 0
			});
			else {
				const attempts = [];
				for (const messageUrl of messageUrls) {
					const graphMedia = await downloadMSTeamsGraphMedia({
						messageUrl,
						tokenProvider,
						maxBytes,
						allowHosts,
						authAllowHosts: params.authAllowHosts,
						preserveFilenames,
						log,
						logger: log
					});
					attempts.push({
						url: messageUrl,
						hostedStatus: graphMedia.hostedStatus,
						attachmentStatus: graphMedia.attachmentStatus,
						hostedCount: graphMedia.hostedCount,
						attachmentCount: graphMedia.attachmentCount,
						tokenError: graphMedia.tokenError
					});
					if (graphMedia.media.length > 0) {
						mediaList = graphMedia.media;
						break;
					}
					if (graphMedia.tokenError) break;
				}
				if (mediaList.length === 0) log.debug?.("graph media fetch empty", {
					attempts,
					attachmentIdCount: attachmentIds.length
				});
			}
		}
	}
	if (mediaList.length > 0) log.debug?.("downloaded attachments", { count: mediaList.length });
	else if (htmlSummary?.imgTags) log.debug?.("inline images detected but none downloaded", {
		imgTags: htmlSummary.imgTags,
		srcHosts: htmlSummary.srcHosts,
		dataImages: htmlSummary.dataImages,
		cidImages: htmlSummary.cidImages
	});
	return mediaList;
}
//#endregion
//#region extensions/msteams/src/monitor-handler/thread-session.ts
const TRAILING_THREAD_SUFFIX = /(?::thread:[^:]+)+$/;
function resolveMSTeamsRouteSessionKey(params) {
	const channelThreadId = params.isChannel ? params.conversationMessageId ?? params.replyToId ?? void 0 : void 0;
	const cleanBase = params.baseSessionKey.replace(TRAILING_THREAD_SUFFIX, "");
	return resolveThreadSessionKeys({
		baseSessionKey: cleanBase,
		threadId: channelThreadId,
		parentSessionKey: channelThreadId ? cleanBase : void 0
	}).sessionKey;
}
//#endregion
//#region extensions/msteams/src/monitor-handler/message-handler.ts
function extractTextFromHtmlAttachments(attachments) {
	for (const attachment of attachments) {
		if (attachment.contentType !== "text/html") continue;
		const content = attachment.content;
		const raw = typeof content === "string" ? content : isRecord(content) && typeof content.text === "string" ? content.text : isRecord(content) && typeof content.body === "string" ? content.body : "";
		if (!raw) continue;
		const text = raw.replace(/<at[^>]*>.*?<\/at>/gis, " ").replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, "$2 $1").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
		if (text) return text;
	}
	return "";
}
function formatMSTeamsSenderReason(params) {
	switch (params.reasonCode) {
		case "dm_policy_open": return "dmPolicy=open";
		case "dm_policy_disabled": return "dmPolicy=disabled";
		case "dm_policy_pairing_required": return "dmPolicy=pairing (not allowlisted)";
		case "dm_policy_allowlisted": return `dmPolicy=${params.dmPolicy ?? "allowlist"} (allowlisted)`;
		case "dm_policy_not_allowlisted": return `dmPolicy=${params.dmPolicy ?? "allowlist"} (not allowlisted)`;
		case "group_policy_disabled": return "groupPolicy=disabled";
		case "group_policy_empty_allowlist":
		case "route_sender_empty": return "groupPolicy=allowlist (empty allowlist)";
		case "group_policy_not_allowlisted": return "groupPolicy=allowlist (not allowlisted)";
		case "group_policy_open": return "groupPolicy=open";
		case "group_policy_allowed": return `groupPolicy=${params.groupPolicy ?? "allowlist"}`;
		default: return params.reasonCode;
	}
}
function buildStoredConversationReference(params) {
	const { activity, conversationId, conversationType, teamId, threadId } = params;
	const from = activity.from;
	const conversation = activity.conversation;
	const agent = activity.recipient;
	const clientInfo = activity.entities?.find((e) => e.type === "clientInfo");
	const tenantId = activity.channelData?.tenant?.id ?? conversation?.tenantId;
	const aadObjectId = from?.aadObjectId;
	return {
		activityId: activity.id,
		user: from ? {
			id: from.id,
			name: from.name,
			aadObjectId: from.aadObjectId
		} : void 0,
		agent,
		bot: agent ? {
			id: agent.id,
			name: agent.name
		} : void 0,
		conversation: {
			id: conversationId,
			conversationType,
			tenantId
		},
		...tenantId ? { tenantId } : {},
		...aadObjectId ? { aadObjectId } : {},
		teamId,
		channelId: activity.channelId,
		serviceUrl: activity.serviceUrl,
		locale: activity.locale,
		...clientInfo?.timezone ? { timezone: clientInfo.timezone } : {},
		...threadId ? { threadId } : {}
	};
}
function createMSTeamsMessageHandler(deps) {
	const { cfg, runtime, appId, adapter, tokenProvider, textLimit, mediaMaxBytes, conversationStore, pollStore, log } = deps;
	const core = getMSTeamsRuntime();
	const logVerboseMessage = (message) => {
		if (core.logging.shouldLogVerbose()) log.debug?.(message);
	};
	const msteamsCfg = cfg.channels?.msteams;
	const contextVisibilityMode = resolveChannelContextVisibilityMode({
		cfg,
		channel: "msteams"
	});
	const historyLimit = Math.max(0, msteamsCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 50);
	const conversationHistories = /* @__PURE__ */ new Map();
	const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
		cfg,
		channel: "msteams"
	});
	const handleTeamsMessageNow = async (params) => {
		const context = params.context;
		const activity = context.activity;
		const rawText = params.rawText;
		const text = params.text;
		const attachments = params.attachments;
		const attachmentPlaceholder = buildMSTeamsAttachmentPlaceholder(attachments, {
			maxInlineBytes: mediaMaxBytes,
			maxInlineTotalBytes: mediaMaxBytes
		});
		const rawBody = text || attachmentPlaceholder;
		const quoteInfo = extractMSTeamsQuoteInfo(attachments);
		let quoteSenderId;
		let quoteSenderName;
		const from = activity.from;
		const conversation = activity.conversation;
		const attachmentTypes = attachments.map((att) => typeof att.contentType === "string" ? att.contentType : void 0).filter(Boolean).slice(0, 3);
		const htmlSummary = summarizeMSTeamsHtmlAttachments(attachments);
		log.info("received message", {
			rawText: rawText.slice(0, 50),
			text: text.slice(0, 50),
			attachments: attachments.length,
			attachmentTypes,
			from: from?.id,
			conversation: conversation?.id
		});
		if (htmlSummary) log.debug?.("html attachment summary", htmlSummary);
		if (!from?.id) {
			log.debug?.("skipping message without from.id");
			return;
		}
		const rawConversationId = conversation?.id ?? "";
		const conversationId = normalizeMSTeamsConversationId(rawConversationId);
		const conversationMessageId = extractMSTeamsConversationMessageId(rawConversationId);
		const conversationType = conversation?.conversationType ?? "personal";
		const teamId = activity.channelData?.team?.id;
		const conversationRef = buildStoredConversationReference({
			activity,
			conversationId,
			conversationType,
			teamId,
			threadId: conversationType === "channel" ? conversationMessageId ?? activity.replyToId ?? void 0 : void 0
		});
		const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
			cfg,
			surface: "msteams"
		});
		const isControlCommand = allowTextCommands && core.channel.commands.isControlCommandMessage(text, cfg);
		const { dmPolicy, senderId, senderName, pairing, isDirectMessage, channelGate, senderAccess, commandAccess, allowNameMatching, groupPolicy } = await resolveMSTeamsSenderAccess({
			cfg,
			activity,
			hasControlCommand: isControlCommand
		});
		const commandAuthorized = commandAccess.requested ? commandAccess.authorized : void 0;
		const effectiveDmAllowFrom = senderAccess.effectiveAllowFrom;
		const effectiveGroupAllowFrom = senderAccess.effectiveGroupAllowFrom;
		const isChannel = conversationType === "channel";
		if (isDirectMessage && msteamsCfg && senderAccess.decision !== "allow") {
			if (senderAccess.reasonCode === "dm_policy_disabled") {
				log.info("dropping dm (dms disabled)", {
					sender: senderId,
					label: senderName
				});
				log.debug?.("dropping dm (dms disabled)");
				return;
			}
			const allowMatch = resolveMSTeamsAllowlistMatch({
				allowFrom: effectiveDmAllowFrom,
				senderId,
				senderName,
				allowNameMatching
			});
			if (senderAccess.decision === "pairing") {
				conversationStore.upsert(conversationId, conversationRef).catch((err) => {
					log.debug?.("failed to save conversation reference", { error: formatUnknownError(err) });
				});
				if (await pairing.upsertPairingRequest({
					id: senderId,
					meta: { name: senderName }
				})) log.info("msteams pairing request created", {
					sender: senderId,
					label: senderName
				});
			}
			log.debug?.("dropping dm (not allowlisted)", {
				sender: senderId,
				label: senderName,
				allowlistMatch: formatAllowlistMatchMeta(allowMatch)
			});
			log.info("dropping dm (not allowlisted)", {
				sender: senderId,
				label: senderName,
				dmPolicy,
				reason: formatMSTeamsSenderReason({
					reasonCode: senderAccess.reasonCode,
					dmPolicy,
					groupPolicy
				}),
				allowlistMatch: formatAllowlistMatchMeta(allowMatch)
			});
			return;
		}
		if (!isDirectMessage && msteamsCfg) {
			if (channelGate.allowlistConfigured && !channelGate.allowed) {
				log.info("dropping group message (not in team/channel allowlist)", {
					conversationId,
					teamKey: channelGate.teamKey ?? "none",
					channelKey: channelGate.channelKey ?? "none",
					channelMatchKey: channelGate.channelMatchKey ?? "none",
					channelMatchSource: channelGate.channelMatchSource ?? "none"
				});
				log.debug?.("dropping group message (not in team/channel allowlist)", {
					conversationId,
					teamKey: channelGate.teamKey ?? "none",
					channelKey: channelGate.channelKey ?? "none",
					channelMatchKey: channelGate.channelMatchKey ?? "none",
					channelMatchSource: channelGate.channelMatchSource ?? "none"
				});
				return;
			}
			if (!senderAccess.allowed && senderAccess.reasonCode === "group_policy_disabled") {
				log.info("dropping group message (groupPolicy: disabled)", { conversationId });
				log.debug?.("dropping group message (groupPolicy: disabled)", { conversationId });
				return;
			}
			if (!senderAccess.allowed && (senderAccess.reasonCode === "group_policy_empty_allowlist" || senderAccess.reasonCode === "route_sender_empty")) {
				log.info("dropping group message (groupPolicy: allowlist, no allowlist)", { conversationId });
				log.debug?.("dropping group message (groupPolicy: allowlist, no allowlist)", { conversationId });
				return;
			}
			if (!senderAccess.allowed && senderAccess.reasonCode === "group_policy_not_allowlisted") {
				const allowMatch = resolveMSTeamsAllowlistMatch({
					allowFrom: effectiveGroupAllowFrom,
					senderId,
					senderName,
					allowNameMatching
				});
				log.debug?.("dropping group message (not in groupAllowFrom)", {
					sender: senderId,
					label: senderName,
					allowlistMatch: formatAllowlistMatchMeta(allowMatch)
				});
				log.info("dropping group message (not in groupAllowFrom)", {
					sender: senderId,
					label: senderName,
					allowlistMatch: formatAllowlistMatchMeta(allowMatch)
				});
				return;
			}
		}
		if (commandAccess.shouldBlockControlCommand) {
			logInboundDrop({
				log: logVerboseMessage,
				channel: "msteams",
				reason: "control command (unauthorized)",
				target: senderId
			});
			return;
		}
		conversationStore.upsert(conversationId, conversationRef).catch((err) => {
			log.debug?.("failed to save conversation reference", { error: formatUnknownError(err) });
		});
		const pollVote = extractMSTeamsPollVote(activity);
		if (pollVote) {
			try {
				if (!await pollStore.recordVote({
					pollId: pollVote.pollId,
					voterId: senderId,
					selections: pollVote.selections
				})) log.debug?.("poll vote ignored (poll not found)", { pollId: pollVote.pollId });
				else log.info("recorded poll vote", {
					pollId: pollVote.pollId,
					voter: senderId,
					selections: pollVote.selections
				});
			} catch (err) {
				log.error("failed to record poll vote", {
					pollId: pollVote.pollId,
					error: formatUnknownError(err)
				});
			}
			return;
		}
		if (!rawBody) {
			log.debug?.("skipping empty message after stripping mentions");
			return;
		}
		const teamsFrom = isDirectMessage ? `msteams:${senderId}` : isChannel ? `msteams:channel:${conversationId}` : `msteams:group:${conversationId}`;
		const teamsTo = isDirectMessage ? `user:${senderId}` : `conversation:${conversationId}`;
		const route = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "msteams",
			teamId,
			peer: {
				kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
				id: isDirectMessage ? senderId : conversationId
			}
		});
		route.sessionKey = resolveMSTeamsRouteSessionKey({
			baseSessionKey: route.sessionKey,
			isChannel,
			conversationMessageId,
			replyToId: activity.replyToId
		});
		const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
		const inboundLabel = isDirectMessage ? `Teams DM from ${senderName}` : `Teams message in ${conversationType} from ${senderName}`;
		const enqueuePrimaryMessageSystemEvent = () => core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
			sessionKey: route.sessionKey,
			contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`
		});
		const channelId = conversationId;
		const { teamConfig, channelConfig } = channelGate;
		const { requireMention, replyStyle } = resolveMSTeamsReplyPolicy({
			isDirectMessage,
			globalConfig: msteamsCfg,
			teamConfig,
			channelConfig
		});
		const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);
		const mentionDecision = resolveInboundMentionDecision({
			facts: {
				canDetectMention: true,
				wasMentioned: params.wasMentioned,
				implicitMentionKinds: params.implicitMentionKinds
			},
			policy: {
				isGroup: !isDirectMessage,
				requireMention,
				allowTextCommands,
				hasControlCommand: isControlCommand,
				commandAuthorized: commandAuthorized === true
			}
		});
		if (!isDirectMessage) {
			const mentioned = mentionDecision.effectiveWasMentioned;
			if (requireMention && mentionDecision.shouldSkip) {
				log.debug?.("skipping message (mention required)", {
					teamId,
					channelId,
					requireMention,
					mentioned
				});
				enqueuePrimaryMessageSystemEvent();
				createChannelHistoryWindow({ historyMap: conversationHistories }).record({
					historyKey: conversationId,
					limit: historyLimit,
					entry: {
						sender: senderName,
						body: rawBody,
						timestamp: timestamp?.getTime(),
						messageId: activity.id ?? void 0
					}
				});
				return;
			}
		}
		enqueuePrimaryMessageSystemEvent();
		let graphConversationId = translateMSTeamsDmConversationIdForGraph({
			isDirectMessage,
			conversationId,
			aadObjectId: from.aadObjectId,
			appId
		});
		if (isDirectMessage && conversationId.startsWith("a:")) {
			const cached = await conversationStore.get(conversationId);
			if (cached?.graphChatId) graphConversationId = cached.graphChatId;
			else try {
				const resolved = await resolveGraphChatId({
					botFrameworkConversationId: conversationId,
					userAadObjectId: from.aadObjectId ?? void 0,
					tokenProvider
				});
				if (resolved) {
					graphConversationId = resolved;
					conversationStore.upsert(conversationId, {
						...conversationRef,
						graphChatId: resolved
					}).catch(() => {});
				}
			} catch {
				log.debug?.("failed to resolve Graph chat ID for inbound media", { conversationId });
			}
		}
		const mediaPayload = buildMSTeamsMediaPayload(await resolveMSTeamsInboundMedia({
			attachments,
			htmlSummary: htmlSummary ?? void 0,
			maxBytes: mediaMaxBytes,
			tokenProvider,
			allowHosts: msteamsCfg?.mediaAllowHosts,
			authAllowHosts: msteamsCfg?.mediaAuthAllowHosts,
			conversationType,
			conversationId: graphConversationId,
			conversationMessageId: conversationMessageId ?? void 0,
			serviceUrl: activity.serviceUrl,
			activity: {
				id: activity.id,
				replyToId: activity.replyToId,
				channelData: activity.channelData
			},
			log,
			preserveFilenames: cfg.media?.preserveFilenames
		}));
		let threadContext;
		if (activity.replyToId && isChannel && teamId) try {
			const graphToken = await tokenProvider.getAccessToken("https://graph.microsoft.com");
			const groupId = await resolveTeamGroupId(graphToken, teamId);
			const [parentResult, repliesResult] = await Promise.allSettled([fetchParentMessageCached(graphToken, groupId, conversationId, activity.replyToId), fetchThreadReplies(graphToken, groupId, conversationId, activity.replyToId)]);
			const parentMsg = parentResult.status === "fulfilled" ? parentResult.value : void 0;
			const replies = repliesResult.status === "fulfilled" ? repliesResult.value : [];
			if (parentResult.status === "rejected") log.debug?.("failed to fetch parent message", { error: formatUnknownError(parentResult.reason) });
			if (repliesResult.status === "rejected") log.debug?.("failed to fetch thread replies", { error: formatUnknownError(repliesResult.reason) });
			const isThreadSenderAllowed = (msg) => groupPolicy === "allowlist" ? resolveMSTeamsAllowlistMatch({
				allowFrom: effectiveGroupAllowFrom,
				senderId: msg.from?.user?.id ?? "",
				senderName: msg.from?.user?.displayName,
				allowNameMatching
			}).allowed : true;
			const parentSummary = summarizeParentMessage(parentMsg);
			const visibleParentMessages = parentMsg ? filterSupplementalContextItems({
				items: [parentMsg],
				mode: contextVisibilityMode,
				kind: "thread",
				isSenderAllowed: isThreadSenderAllowed
			}).items : [];
			if (parentSummary && visibleParentMessages.length > 0 && shouldInjectParentContext(route.sessionKey, activity.replyToId)) {
				core.system.enqueueSystemEvent(formatParentContextEvent(parentSummary), {
					sessionKey: route.sessionKey,
					contextKey: `msteams:thread-parent:${conversationId}:${activity.replyToId}`
				});
				markParentContextInjected(route.sessionKey, activity.replyToId);
			}
			const allMessages = parentMsg ? [parentMsg, ...replies] : replies;
			quoteSenderId = parentMsg?.from?.user?.id ?? parentMsg?.from?.application?.id ?? void 0;
			quoteSenderName = parentMsg?.from?.user?.displayName ?? parentMsg?.from?.application?.displayName ?? quoteInfo?.sender;
			const { items: threadMessages } = filterSupplementalContextItems({
				items: allMessages,
				mode: contextVisibilityMode,
				kind: "thread",
				isSenderAllowed: isThreadSenderAllowed
			});
			const formatted = formatThreadContext(threadMessages, activity.id);
			if (formatted) threadContext = formatted;
		} catch (err) {
			log.debug?.("failed to fetch thread history", { error: formatUnknownError(err) });
		}
		quoteSenderName ??= quoteInfo?.sender;
		const envelopeFrom = isDirectMessage ? senderName : conversationType;
		const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
			cfg,
			agentId: route.agentId,
			sessionKey: route.sessionKey
		});
		let combinedBody = core.channel.reply.formatAgentEnvelope({
			channel: "Teams",
			from: envelopeFrom,
			timestamp,
			previousTimestamp,
			envelope: envelopeOptions,
			body: rawBody
		});
		const isRoomish = !isDirectMessage;
		const historyKey = isRoomish ? conversationId : void 0;
		if (isRoomish && historyKey) combinedBody = createChannelHistoryWindow({ historyMap: conversationHistories }).buildPendingContext({
			historyKey,
			limit: historyLimit,
			currentMessage: combinedBody,
			formatEntry: (entry) => core.channel.reply.formatAgentEnvelope({
				channel: "Teams",
				from: conversationType,
				timestamp: entry.timestamp,
				body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
				envelope: envelopeOptions
			})
		});
		const inboundHistory = isRoomish && historyKey && historyLimit > 0 ? createChannelHistoryWindow({ historyMap: conversationHistories }).buildInboundHistory({
			historyKey,
			limit: historyLimit
		}) : void 0;
		const commandBody = text.trim();
		const quoteSenderAllowed = quoteInfo && quoteInfo.sender ? !isChannel || groupPolicy !== "allowlist" ? true : resolveMSTeamsAllowlistMatch({
			allowFrom: effectiveGroupAllowFrom,
			senderId: quoteSenderId ?? "",
			senderName: quoteSenderName,
			allowNameMatching
		}).allowed : true;
		const includeQuoteContext = quoteInfo && shouldIncludeSupplementalContext({
			mode: contextVisibilityMode,
			kind: "quote",
			senderAllowed: quoteSenderAllowed
		});
		const bodyForAgent = threadContext ? `[Thread history]\n${threadContext}\n[/Thread history]\n\n${rawBody}` : rawBody;
		const nativeChannelId = isChannel && teamId ? `${teamId}/${conversationId}` : void 0;
		const ctxPayload = core.channel.reply.finalizeInboundContext({
			Body: combinedBody,
			BodyForAgent: bodyForAgent,
			InboundHistory: inboundHistory,
			RawBody: rawBody,
			CommandBody: commandBody,
			BodyForCommands: commandBody,
			From: teamsFrom,
			To: teamsTo,
			SessionKey: route.sessionKey,
			AccountId: route.accountId,
			ChatType: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
			ConversationLabel: envelopeFrom,
			GroupSubject: !isDirectMessage ? conversationType : void 0,
			GroupSpace: teamId,
			SenderName: senderName,
			SenderId: senderId,
			Provider: "msteams",
			Surface: "msteams",
			MessageSid: activity.id,
			Timestamp: timestamp?.getTime() ?? Date.now(),
			WasMentioned: isDirectMessage || mentionDecision.effectiveWasMentioned,
			CommandAuthorized: commandAuthorized,
			OriginatingChannel: "msteams",
			OriginatingTo: teamsTo,
			NativeChannelId: nativeChannelId,
			ReplyToId: activity.replyToId ?? void 0,
			ReplyToBody: includeQuoteContext ? quoteInfo?.body : void 0,
			ReplyToSender: includeQuoteContext ? quoteInfo?.sender : void 0,
			ReplyToIsQuote: quoteInfo ? true : void 0,
			...mediaPayload
		});
		logVerboseMessage(`msteams inbound: from=${ctxPayload.From} preview="${preview}"`);
		const sharePointSiteId = msteamsCfg?.sharePointSiteId;
		const { dispatcher, replyOptions, markDispatchIdle } = createMSTeamsReplyDispatcher({
			cfg,
			agentId: route.agentId,
			sessionKey: route.sessionKey,
			accountId: route.accountId,
			runtime,
			log,
			adapter,
			appId,
			conversationRef,
			context,
			replyStyle,
			textLimit,
			onSentMessageIds: (ids) => {
				for (const id of ids) recordMSTeamsSentMessage(conversationId, id);
			},
			tokenProvider,
			sharePointSiteId
		});
		const senderTimezone = (activity.entities?.find((e) => e.type === "clientInfo"))?.timezone || conversationRef.timezone;
		const configOverride = senderTimezone && !cfg.agents?.defaults?.userTimezone ? { agents: { defaults: {
			...cfg.agents?.defaults,
			userTimezone: senderTimezone
		} } } : void 0;
		log.info("dispatching to agent", { sessionKey: route.sessionKey });
		try {
			const turnResult = await core.channel.turn.run({
				channel: "msteams",
				accountId: route.accountId,
				raw: context,
				adapter: {
					ingest: () => ({
						id: activity.id ?? `${teamsFrom}:${Date.now()}`,
						timestamp: timestamp?.getTime(),
						rawText: rawBody,
						textForAgent: bodyForAgent,
						textForCommands: commandBody,
						raw: activity
					}),
					resolveTurn: () => ({
						channel: "msteams",
						accountId: route.accountId,
						routeSessionKey: route.sessionKey,
						storePath,
						ctxPayload,
						recordInboundSession: core.channel.session.recordInboundSession,
						record: { onRecordError: (err) => {
							logVerboseMessage(`msteams: failed updating session meta: ${formatUnknownError(err)}`);
						} },
						history: {
							isGroup: isRoomish,
							historyKey,
							historyMap: conversationHistories,
							limit: historyLimit
						},
						onPreDispatchFailure: () => core.channel.reply.settleReplyDispatcher({
							dispatcher,
							onSettled: () => markDispatchIdle()
						}),
						runDispatch: () => dispatchReplyFromConfigWithSettledDispatcher({
							cfg,
							ctxPayload,
							dispatcher,
							onSettled: () => markDispatchIdle(),
							replyOptions,
							configOverride
						})
					})
				}
			});
			const dispatchResult = turnResult.dispatched ? turnResult.dispatchResult : void 0;
			const queuedFinal = dispatchResult?.queuedFinal ?? false;
			const counts = resolveChannelTurnDispatchCounts(dispatchResult);
			const hasFinalResponse = hasFinalChannelTurnDispatch(dispatchResult);
			log.info("dispatch complete", {
				queuedFinal,
				counts
			});
			if (!hasFinalResponse) return;
			const finalCount = counts.final;
			logVerboseMessage(`msteams: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${teamsTo}`);
		} catch (err) {
			log.error("dispatch failed", { error: formatUnknownError(err) });
			runtime.error(`msteams dispatch failed: ${formatUnknownError(err)}`);
			try {
				await context.sendActivity("⚠️ Something went wrong. Please try again.");
			} catch {}
		}
	};
	const inboundDebouncer = core.channel.debounce.createInboundDebouncer({
		debounceMs: inboundDebounceMs,
		buildKey: (entry) => {
			const conversationId = normalizeMSTeamsConversationId(entry.context.activity.conversation?.id ?? "");
			const senderId = entry.context.activity.from?.aadObjectId ?? entry.context.activity.from?.id ?? "";
			if (!senderId || !conversationId) return null;
			return `msteams:${appId}:${conversationId}:${senderId}`;
		},
		shouldDebounce: (entry) => {
			if (!entry.text.trim()) return false;
			if (entry.attachments.length > 0) return false;
			return !core.channel.commands.isControlCommandMessage(entry.text, cfg);
		},
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			if (entries.length === 1) {
				await handleTeamsMessageNow(last);
				return;
			}
			const combinedText = entries.map((entry) => entry.text).filter(Boolean).join("\n");
			if (!combinedText.trim()) return;
			const combinedRawText = entries.map((entry) => entry.rawText).filter(Boolean).join("\n");
			const wasMentioned = entries.some((entry) => entry.wasMentioned);
			const implicitMentionKinds = entries.flatMap((entry) => entry.implicitMentionKinds);
			await handleTeamsMessageNow({
				context: last.context,
				rawText: combinedRawText,
				text: combinedText,
				attachments: [],
				wasMentioned,
				implicitMentionKinds
			});
		},
		onError: (err) => {
			runtime.error(`msteams debounce flush failed: ${formatUnknownError(err)}`);
		}
	});
	return async function handleTeamsMessage(context) {
		const activity = context.activity;
		const attachments = Array.isArray(activity.attachments) ? activity.attachments : [];
		const rawText = activity.text?.trim() ?? "";
		const htmlText = extractTextFromHtmlAttachments(attachments);
		const text = stripMSTeamsMentionTags(rawText || htmlText);
		const wasMentioned = wasMSTeamsBotMentioned(activity);
		const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
		const replyToId = activity.replyToId ?? void 0;
		const implicitMentionKinds = conversationId && replyToId && await wasMSTeamsMessageSentWithPersistence({
			conversationId,
			messageId: replyToId
		}) ? ["reply_to_bot"] : [];
		await inboundDebouncer.enqueue({
			context,
			rawText,
			text,
			attachments,
			wasMentioned,
			implicitMentionKinds
		});
	};
}
//#endregion
//#region extensions/msteams/src/monitor-handler/reaction-handler.ts
/** Teams reaction type names → Unicode emoji. */
const TEAMS_REACTION_EMOJI = {
	like: "👍",
	heart: "❤️",
	laugh: "😆",
	surprised: "😮",
	sad: "😢",
	angry: "😡"
};
/**
* Map a Teams reaction type string to a Unicode emoji.
* Falls back to the raw type if not recognized.
*/
function mapReactionEmoji(reactionType) {
	return TEAMS_REACTION_EMOJI[reactionType] ?? reactionType;
}
/**
* Create a handler for MS Teams reaction activities (reactionsAdded / reactionsRemoved).
* The returned function accepts a turn context and a direction string.
*/
function createMSTeamsReactionHandler(deps) {
	const { cfg, log } = deps;
	const core = getMSTeamsRuntime();
	const msteamsCfg = cfg.channels?.msteams;
	return async function handleReaction(context, direction) {
		const activity = context.activity;
		const reactions = direction === "added" ? activity.reactionsAdded ?? [] : activity.reactionsRemoved ?? [];
		if (reactions.length === 0) {
			log.debug?.("reaction activity has no reactions; skipping");
			return;
		}
		const from = activity.from;
		if (!from?.id) {
			log.debug?.("reaction activity missing from.id; skipping");
			return;
		}
		const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
		const conversationType = activity.conversation?.conversationType ?? "personal";
		const isGroupChat = conversationType === "groupChat" || activity.conversation?.isGroup === true;
		const isChannel = conversationType === "channel";
		const isDirectMessage = !isGroupChat && !isChannel;
		const senderId = from.aadObjectId ?? from.id;
		const senderName = from.name ?? from.id;
		if (msteamsCfg) {
			const senderAccess = await resolveMSTeamsSenderAccess({
				cfg,
				activity
			});
			if (senderAccess.senderAccess.decision !== "allow") {
				log.debug?.("dropping reaction (access denied)", {
					sender: senderId,
					reason: senderAccess.senderAccess.reasonCode
				});
				return;
			}
		}
		const teamId = isDirectMessage ? void 0 : activity.channelData?.team?.id;
		const route = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "msteams",
			peer: {
				kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
				id: isDirectMessage ? senderId : conversationId
			},
			...teamId ? { teamId } : {}
		});
		const targetMessageId = activity.replyToId ?? "unknown";
		for (const reaction of reactions) {
			const reactionType = reaction.type ?? "unknown";
			const emoji = mapReactionEmoji(reactionType);
			const label = direction === "added" ? `Teams reaction ${emoji} added by ${senderName} on message ${targetMessageId}` : `Teams reaction ${emoji} removed by ${senderName} from message ${targetMessageId}`;
			log.info(`reaction ${direction}`, {
				sender: senderId,
				reactionType,
				emoji,
				targetMessageId,
				conversationId
			});
			core.system.enqueueSystemEvent(label, {
				sessionKey: route.sessionKey,
				contextKey: `msteams:reaction:${conversationId}:${targetMessageId}:${senderId}:${reactionType}:${direction}`
			});
		}
	};
}
//#endregion
//#region extensions/msteams/src/sso.ts
/** Scope used to obtain a Bot Framework service token. */
const BOT_FRAMEWORK_TOKEN_SCOPE = "https://api.botframework.com/.default";
/** Bot Framework User Token service base URL. */
const BOT_FRAMEWORK_USER_TOKEN_BASE_URL = "https://token.botframework.com";
/**
* Extract and validate the `signin/tokenExchange` activity value. Teams
* delivers `{ id, connectionName, token }`; any field may be missing on
* malformed invocations, so callers should check the parsed result.
*/
function parseSigninTokenExchangeValue(value) {
	if (!value || typeof value !== "object") return null;
	const obj = value;
	return {
		id: typeof obj.id === "string" ? obj.id : void 0,
		connectionName: typeof obj.connectionName === "string" ? obj.connectionName : void 0,
		token: typeof obj.token === "string" ? obj.token : void 0
	};
}
/** Extract the `signin/verifyState` activity value `{ state }`. */
function parseSigninVerifyStateValue(value) {
	if (!value || typeof value !== "object") return null;
	const obj = value;
	return { state: typeof obj.state === "string" ? obj.state : void 0 };
}
async function callUserTokenService(params) {
	const qs = new URLSearchParams(params.query).toString();
	const url = `${params.baseUrl.replace(/\/+$/, "")}${params.path}?${qs}`;
	const headers = {
		Accept: "application/json",
		Authorization: `Bearer ${params.bearerToken}`,
		"User-Agent": buildUserAgent()
	};
	if (params.body !== void 0) headers["Content-Type"] = "application/json";
	const response = await params.fetchImpl(url, {
		method: params.method,
		headers,
		body: params.body === void 0 ? void 0 : JSON.stringify(params.body)
	});
	if (!response.ok) return {
		error: await response.text().catch(() => "") || `HTTP ${response.status}`,
		status: response.status
	};
	let parsed;
	try {
		parsed = await response.json();
	} catch {
		return {
			error: "invalid JSON from User Token service",
			status: response.status
		};
	}
	if (!parsed || typeof parsed !== "object") return {
		error: "empty response from User Token service",
		status: response.status
	};
	const obj = parsed;
	const token = typeof obj.token === "string" ? obj.token : void 0;
	const connectionName = typeof obj.connectionName === "string" ? obj.connectionName : void 0;
	const channelId = typeof obj.channelId === "string" ? obj.channelId : void 0;
	const expiration = typeof obj.expiration === "string" ? obj.expiration : void 0;
	if (!token || !connectionName) return {
		error: "User Token service response missing token/connectionName",
		status: 502
	};
	return {
		channelId,
		connectionName,
		token,
		expiration
	};
}
/**
* Exchange a Teams SSO token for a delegated user token via Bot
* Framework's User Token service, then persist the result.
*/
async function handleSigninTokenExchangeInvoke(params) {
	const { value, user, deps } = params;
	if (!user.userId) return {
		ok: false,
		code: "missing_user",
		message: "no user id on invoke activity"
	};
	const connectionName = value.connectionName?.trim() || deps.connectionName;
	if (!connectionName) return {
		ok: false,
		code: "missing_connection",
		message: "no OAuth connection name"
	};
	if (!value.token) return {
		ok: false,
		code: "missing_token",
		message: "no exchangeable token on invoke"
	};
	const bearer = await deps.tokenProvider.getAccessToken(BOT_FRAMEWORK_TOKEN_SCOPE);
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const result = await callUserTokenService({
		baseUrl: deps.userTokenBaseUrl ?? BOT_FRAMEWORK_USER_TOKEN_BASE_URL,
		path: "/api/usertoken/exchange",
		query: {
			userId: user.userId,
			connectionName,
			channelId: user.channelId ?? "msteams"
		},
		method: "POST",
		body: { token: value.token },
		bearerToken: bearer,
		fetchImpl
	});
	if ("error" in result) return {
		ok: false,
		code: result.status >= 500 ? "service_error" : "unexpected_response",
		message: result.error,
		status: result.status
	};
	await deps.tokenStore.save({
		connectionName,
		userId: user.userId,
		token: result.token,
		expiresAt: result.expiration,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	});
	return {
		ok: true,
		token: result.token,
		expiresAt: result.expiration
	};
}
/**
* Finish a magic-code sign-in: look up the user token for the state
* code via Bot Framework's User Token service, then persist it.
*/
async function handleSigninVerifyStateInvoke(params) {
	const { value, user, deps } = params;
	if (!user.userId) return {
		ok: false,
		code: "missing_user",
		message: "no user id on invoke activity"
	};
	if (!deps.connectionName) return {
		ok: false,
		code: "missing_connection",
		message: "no OAuth connection name"
	};
	const state = value.state?.trim();
	if (!state) return {
		ok: false,
		code: "missing_state",
		message: "no state code on invoke"
	};
	const bearer = await deps.tokenProvider.getAccessToken(BOT_FRAMEWORK_TOKEN_SCOPE);
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const result = await callUserTokenService({
		baseUrl: deps.userTokenBaseUrl ?? BOT_FRAMEWORK_USER_TOKEN_BASE_URL,
		path: "/api/usertoken/GetToken",
		query: {
			userId: user.userId,
			connectionName: deps.connectionName,
			channelId: user.channelId ?? "msteams",
			code: state
		},
		method: "GET",
		bearerToken: bearer,
		fetchImpl
	});
	if ("error" in result) return {
		ok: false,
		code: result.status >= 500 ? "service_error" : "unexpected_response",
		message: result.error,
		status: result.status
	};
	await deps.tokenStore.save({
		connectionName: deps.connectionName,
		userId: user.userId,
		token: result.token,
		expiresAt: result.expiration,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	});
	return {
		ok: true,
		token: result.token,
		expiresAt: result.expiration
	};
}
//#endregion
//#region extensions/msteams/src/welcome-card.ts
/**
* Builds an Adaptive Card for welcoming users when the bot is added to a conversation.
*/
const DEFAULT_PROMPT_STARTERS = [
	"What can you do?",
	"Summarize my last meeting",
	"Help me draft an email"
];
/**
* Build a welcome Adaptive Card for 1:1 personal chats.
*/
function buildWelcomeCard(options) {
	const botName = options?.botName || "OpenClaw";
	const starters = options?.promptStarters?.length ? options.promptStarters : DEFAULT_PROMPT_STARTERS;
	return {
		type: "AdaptiveCard",
		version: "1.5",
		body: [{
			type: "TextBlock",
			text: `Hi! I'm ${botName}.`,
			weight: "bolder",
			size: "medium"
		}, {
			type: "TextBlock",
			text: "I can help you with questions, tasks, and more. Here are some things to try:",
			wrap: true
		}],
		actions: starters.map((label) => ({
			type: "Action.Submit",
			title: label,
			data: { msteams: {
				type: "imBack",
				value: label
			} }
		}))
	};
}
/**
* Build a brief welcome message for group chats (when the bot is @mentioned).
*/
function buildGroupWelcomeText(botName) {
	const name = botName || "OpenClaw";
	return `Hi! I'm ${name}. Mention me with @${name} to get started.`;
}
//#endregion
//#region extensions/msteams/src/monitor-handler.ts
function serializeAdaptiveCardActionValue(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : null;
	}
	if (value === void 0) return null;
	try {
		return JSON.stringify(value);
	} catch {
		return null;
	}
}
async function isInvokeAuthorized(params) {
	const { context, deps, deniedLogs, includeInvokeName = false } = params;
	const resolved = await resolveMSTeamsSenderAccess({
		cfg: deps.cfg,
		activity: context.activity
	});
	const { msteamsCfg, isDirectMessage, conversationId, senderId } = resolved;
	if (!msteamsCfg) return true;
	const maybeInvokeName = includeInvokeName ? { name: context.activity.name } : void 0;
	if (isDirectMessage && resolved.senderAccess.decision !== "allow") {
		deps.log.debug?.(deniedLogs.dm, {
			sender: senderId,
			conversationId,
			...maybeInvokeName
		});
		return false;
	}
	if (!isDirectMessage && resolved.channelGate.allowlistConfigured && !resolved.channelGate.allowed) {
		deps.log.debug?.(deniedLogs.channel, {
			conversationId,
			teamKey: resolved.channelGate.teamKey ?? "none",
			channelKey: resolved.channelGate.channelKey ?? "none",
			...maybeInvokeName
		});
		return false;
	}
	if (!isDirectMessage && !resolved.senderAccess.allowed) {
		deps.log.debug?.(deniedLogs.group, {
			sender: senderId,
			conversationId,
			...maybeInvokeName
		});
		return false;
	}
	return true;
}
async function isFeedbackInvokeAuthorized(context, deps) {
	return isInvokeAuthorized({
		context,
		deps,
		deniedLogs: {
			dm: "dropping feedback invoke (dm sender not allowlisted)",
			channel: "dropping feedback invoke (not in team/channel allowlist)",
			group: "dropping feedback invoke (group sender not allowlisted)"
		}
	});
}
async function isSigninInvokeAuthorized(context, deps) {
	return isInvokeAuthorized({
		context,
		deps,
		deniedLogs: {
			dm: "dropping signin invoke (dm sender not allowlisted)",
			channel: "dropping signin invoke (not in team/channel allowlist)",
			group: "dropping signin invoke (group sender not allowlisted)"
		},
		includeInvokeName: true
	});
}
/**
* Parse and handle feedback invoke activities (thumbs up/down).
* Returns true if the activity was a feedback invoke, false otherwise.
*/
async function handleFeedbackInvoke(context, deps) {
	const activity = context.activity;
	const value = activity.value;
	if (!value) return false;
	if (value.actionName !== "feedback") return false;
	const reaction = value.actionValue?.reaction;
	if (reaction !== "like" && reaction !== "dislike") {
		deps.log.debug?.("ignoring feedback with unknown reaction", { reaction });
		return false;
	}
	const msteamsCfg = deps.cfg.channels?.msteams;
	if (msteamsCfg?.feedbackEnabled === false) {
		deps.log.debug?.("feedback handling disabled");
		return true;
	}
	if (!await isFeedbackInvokeAuthorized(context, deps)) return true;
	let userComment;
	if (value.actionValue?.feedback) try {
		userComment = JSON.parse(value.actionValue.feedback).feedbackText || void 0;
	} catch {}
	const rawConversationId = activity.conversation?.id ?? "unknown";
	const conversationId = normalizeMSTeamsConversationId(rawConversationId);
	const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
	const messageId = value.replyToId ?? activity.replyToId ?? "unknown";
	const isNegative = reaction === "dislike";
	const convType = normalizeOptionalLowercaseString(activity.conversation?.conversationType);
	const isDirectMessage = convType === "personal" || !convType && !activity.conversation?.isGroup;
	const isChannel = convType === "channel";
	const core = getMSTeamsRuntime();
	const route = core.channel.routing.resolveAgentRoute({
		cfg: deps.cfg,
		channel: "msteams",
		peer: {
			kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
			id: isDirectMessage ? senderId : conversationId
		}
	});
	const feedbackThreadId = isChannel ? extractMSTeamsConversationMessageId(rawConversationId) ?? activity.replyToId ?? void 0 : void 0;
	if (feedbackThreadId) route.sessionKey = resolveThreadSessionKeys({
		baseSessionKey: route.sessionKey,
		threadId: feedbackThreadId,
		parentSessionKey: route.sessionKey
	}).sessionKey;
	const feedbackEvent = buildFeedbackEvent({
		messageId,
		value: isNegative ? "negative" : "positive",
		comment: userComment,
		sessionKey: route.sessionKey,
		agentId: route.agentId,
		conversationId
	});
	deps.log.info("received feedback", {
		value: feedbackEvent.value,
		messageId,
		conversationId,
		hasComment: Boolean(userComment)
	});
	try {
		const storePath = core.channel.session.resolveStorePath(deps.cfg.session?.store, { agentId: route.agentId });
		const safeKey = route.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
		await appendRegularFile({
			filePath: path.join(storePath, `${safeKey}.jsonl`),
			content: `${JSON.stringify(feedbackEvent)}\n`,
			rejectSymlinkParents: true
		}).catch(() => {});
	} catch {}
	const conversationRef = {
		activityId: activity.id,
		user: {
			id: activity.from?.id,
			name: activity.from?.name,
			aadObjectId: activity.from?.aadObjectId
		},
		agent: activity.recipient ? {
			id: activity.recipient.id,
			name: activity.recipient.name
		} : void 0,
		bot: activity.recipient ? {
			id: activity.recipient.id,
			name: activity.recipient.name
		} : void 0,
		conversation: {
			id: conversationId,
			conversationType: activity.conversation?.conversationType,
			tenantId: activity.conversation?.tenantId
		},
		channelId: activity.channelId ?? "msteams",
		serviceUrl: activity.serviceUrl,
		locale: activity.locale
	};
	if (isNegative && msteamsCfg?.feedbackReflection !== false) runFeedbackReflection({
		cfg: deps.cfg,
		adapter: deps.adapter,
		appId: deps.appId,
		conversationRef,
		sessionKey: route.sessionKey,
		agentId: route.agentId,
		conversationId,
		feedbackMessageId: messageId,
		userComment,
		log: deps.log
	}).catch((err) => {
		deps.log.error("feedback reflection failed", { error: formatUnknownError(err) });
	});
	return true;
}
function registerMSTeamsHandlers(handler, deps) {
	const handleTeamsMessage = createMSTeamsMessageHandler(deps);
	const handleReaction = createMSTeamsReactionHandler(deps);
	const originalRun = handler.run;
	if (originalRun) handler.run = async (context) => {
		const ctx = context;
		if (ctx.activity?.type === "invoke" && ctx.activity?.name === "fileConsent/invoke") {
			await respondToMSTeamsFileConsentInvoke(ctx, deps.log);
			return;
		}
		if (ctx.activity?.type === "invoke" && ctx.activity?.name === "message/submitAction") {
			if (await handleFeedbackInvoke(ctx, deps)) return;
		}
		if (ctx.activity?.type === "invoke" && ctx.activity?.name === "adaptiveCard/action") {
			const text = serializeAdaptiveCardActionValue(ctx.activity?.value);
			if (text) {
				await handleTeamsMessage({
					...ctx,
					activity: {
						...ctx.activity,
						type: "message",
						text
					}
				});
				return;
			}
			deps.log.debug?.("skipping adaptive card action invoke without value payload");
		}
		if (ctx.activity?.type === "invoke" && (ctx.activity?.name === "signin/tokenExchange" || ctx.activity?.name === "signin/verifyState")) {
			await ctx.sendActivity({
				type: "invokeResponse",
				value: {
					status: 200,
					body: {}
				}
			});
			if (!await isSigninInvokeAuthorized(ctx, deps)) return;
			if (!deps.sso) {
				deps.log.debug?.("signin invoke received but msteams.sso is not configured", { name: ctx.activity.name });
				return;
			}
			const user = {
				userId: ctx.activity.from?.aadObjectId ?? ctx.activity.from?.id ?? "",
				channelId: ctx.activity.channelId ?? "msteams"
			};
			try {
				if (ctx.activity.name === "signin/tokenExchange") {
					const parsed = parseSigninTokenExchangeValue(ctx.activity.value);
					if (!parsed) {
						deps.log.debug?.("invalid signin/tokenExchange invoke value");
						return;
					}
					const result = await handleSigninTokenExchangeInvoke({
						value: parsed,
						user,
						deps: deps.sso
					});
					if (result.ok) deps.log.info("msteams sso token exchanged", {
						userId: user.userId,
						hasExpiry: Boolean(result.expiresAt)
					});
					else deps.log.error("msteams sso token exchange failed", {
						code: result.code,
						status: result.status,
						message: result.message
					});
					return;
				}
				const parsed = parseSigninVerifyStateValue(ctx.activity.value);
				if (!parsed) {
					deps.log.debug?.("invalid signin/verifyState invoke value");
					return;
				}
				const result = await handleSigninVerifyStateInvoke({
					value: parsed,
					user,
					deps: deps.sso
				});
				if (result.ok) deps.log.info("msteams sso verifyState succeeded", {
					userId: user.userId,
					hasExpiry: Boolean(result.expiresAt)
				});
				else deps.log.error("msteams sso verifyState failed", {
					code: result.code,
					status: result.status,
					message: result.message
				});
			} catch (err) {
				deps.log.error("msteams sso invoke handler error", { error: formatUnknownError(err) });
			}
			return;
		}
		return originalRun.call(handler, context);
	};
	handler.onMessage(async (context, next) => {
		try {
			await handleTeamsMessage(context);
		} catch (err) {
			deps.runtime.error(`msteams handler failed: ${formatUnknownError(err)}`);
		}
		await next();
	});
	handler.onMembersAdded(async (context, next) => {
		const ctx = context;
		const membersAdded = ctx.activity?.membersAdded ?? [];
		const botId = ctx.activity?.recipient?.id;
		const msteamsCfg = deps.cfg.channels?.msteams;
		for (const member of membersAdded) if (member.id === botId) {
			const isPersonal = (normalizeOptionalLowercaseString(ctx.activity?.conversation?.conversationType) ?? "personal") === "personal";
			if (isPersonal && msteamsCfg?.welcomeCard !== false) {
				const card = buildWelcomeCard({
					botName: ctx.activity?.recipient?.name ?? void 0,
					promptStarters: msteamsCfg?.promptStarters
				});
				try {
					await ctx.sendActivity({
						type: "message",
						attachments: [{
							contentType: "application/vnd.microsoft.card.adaptive",
							content: card
						}]
					});
					deps.log.info("sent welcome card");
				} catch (err) {
					deps.log.debug?.("failed to send welcome card", { error: formatUnknownError(err) });
				}
			} else if (!isPersonal && msteamsCfg?.groupWelcomeCard === true) {
				const botName = ctx.activity?.recipient?.name ?? void 0;
				try {
					await ctx.sendActivity(buildGroupWelcomeText(botName));
					deps.log.info("sent group welcome message");
				} catch (err) {
					deps.log.debug?.("failed to send group welcome", { error: formatUnknownError(err) });
				}
			} else deps.log.debug?.("skipping welcome (disabled by config or conversation type)");
		} else deps.log.debug?.("member added", { member: member.id });
		await next();
	});
	handler.onReactionsAdded(async (context, next) => {
		try {
			await handleReaction(context, "added");
		} catch (err) {
			deps.runtime.error(`msteams reaction handler failed: ${String(err)}`);
		}
		await next();
	});
	handler.onReactionsRemoved(async (context, next) => {
		try {
			await handleReaction(context, "removed");
		} catch (err) {
			deps.runtime.error(`msteams reaction handler failed: ${String(err)}`);
		}
		await next();
	});
	return handler;
}
//#endregion
//#region extensions/msteams/src/sso-token-store.ts
/**
* File-backed store for Bot Framework OAuth SSO tokens.
*
* Tokens are keyed by (connectionName, userId). `userId` should be the
* stable AAD object ID (`activity.from.aadObjectId`) when available,
* falling back to the Bot Framework `activity.from.id`.
*
* The store is intentionally minimal: it persists the exchanged user
* token plus its expiration so consumers (for example tool handlers
* that call Microsoft Graph with delegated permissions) can fetch a
* valid token without reaching back into Bot Framework every turn.
*/
const STORE_FILENAME = "msteams-sso-tokens.json";
const STORE_KEY_VERSION_PREFIX = "v2:";
function makeKey(connectionName, userId) {
	return `${STORE_KEY_VERSION_PREFIX}${Buffer.from(JSON.stringify([connectionName, userId]), "utf8").toString("base64url")}`;
}
function normalizeStoredToken(value) {
	if (!value || typeof value !== "object") return null;
	const token = value;
	if (typeof token.connectionName !== "string" || !token.connectionName || typeof token.userId !== "string" || !token.userId || typeof token.token !== "string" || !token.token || typeof token.updatedAt !== "string" || !token.updatedAt) return null;
	return {
		connectionName: token.connectionName,
		userId: token.userId,
		token: token.token,
		...typeof token.expiresAt === "string" ? { expiresAt: token.expiresAt } : {},
		updatedAt: token.updatedAt
	};
}
function isSsoStoreData(value) {
	if (!value || typeof value !== "object") return false;
	const obj = value;
	return obj.version === 1 && typeof obj.tokens === "object" && obj.tokens !== null;
}
function createMSTeamsSsoTokenStoreFs(params) {
	const filePath = resolveMSTeamsStorePath({
		filename: STORE_FILENAME,
		env: params?.env,
		homedir: params?.homedir,
		stateDir: params?.stateDir,
		storePath: params?.storePath
	});
	const empty = {
		version: 1,
		tokens: {}
	};
	const readStore = async () => {
		const { value } = await readJsonFile(filePath, empty);
		if (!isSsoStoreData(value)) return {
			version: 1,
			tokens: {}
		};
		const tokens = {};
		for (const stored of Object.values(value.tokens)) {
			const normalized = normalizeStoredToken(stored);
			if (!normalized) continue;
			tokens[makeKey(normalized.connectionName, normalized.userId)] = normalized;
		}
		return {
			version: 1,
			tokens
		};
	};
	return {
		async get({ connectionName, userId }) {
			return (await readStore()).tokens[makeKey(connectionName, userId)] ?? null;
		},
		async save(token) {
			await withFileLock(filePath, empty, async () => {
				const store = await readStore();
				const key = makeKey(token.connectionName, token.userId);
				store.tokens[key] = { ...token };
				await writeJsonFile(filePath, store);
			});
		},
		async remove({ connectionName, userId }) {
			let removed = false;
			await withFileLock(filePath, empty, async () => {
				const store = await readStore();
				const key = makeKey(connectionName, userId);
				if (store.tokens[key]) {
					delete store.tokens[key];
					removed = true;
					await writeJsonFile(filePath, store);
				}
			});
			return removed;
		}
	};
}
//#endregion
//#region extensions/msteams/src/webhook-timeouts.ts
const MSTEAMS_WEBHOOK_INACTIVITY_TIMEOUT_MS = 3e4;
const MSTEAMS_WEBHOOK_REQUEST_TIMEOUT_MS = 3e4;
const MSTEAMS_WEBHOOK_HEADERS_TIMEOUT_MS = 15e3;
function applyMSTeamsWebhookTimeouts(httpServer, opts) {
	const inactivityTimeoutMs = opts?.inactivityTimeoutMs ?? MSTEAMS_WEBHOOK_INACTIVITY_TIMEOUT_MS;
	const requestTimeoutMs = opts?.requestTimeoutMs ?? MSTEAMS_WEBHOOK_REQUEST_TIMEOUT_MS;
	const headersTimeoutMs = Math.min(opts?.headersTimeoutMs ?? MSTEAMS_WEBHOOK_HEADERS_TIMEOUT_MS, requestTimeoutMs);
	httpServer.setTimeout(inactivityTimeoutMs);
	httpServer.requestTimeout = requestTimeoutMs;
	httpServer.headersTimeout = headersTimeoutMs;
}
//#endregion
//#region extensions/msteams/src/monitor.ts
const MSTEAMS_WEBHOOK_MAX_BODY_BYTES = DEFAULT_WEBHOOK_MAX_BODY_BYTES;
async function monitorMSTeamsProvider(opts) {
	const core = getMSTeamsRuntime();
	const log = core.logging.getChildLogger({ name: "msteams" });
	let cfg = opts.cfg;
	let msteamsCfg = cfg.channels?.msteams;
	if (!msteamsCfg?.enabled) {
		log.debug?.("msteams provider disabled");
		return {
			app: null,
			shutdown: async () => {}
		};
	}
	const creds = resolveMSTeamsCredentials(msteamsCfg);
	if (!creds) {
		log.error("msteams credentials not configured");
		return {
			app: null,
			shutdown: async () => {}
		};
	}
	const appId = creds.appId;
	const runtime = opts.runtime ?? {
		log: console.log,
		error: console.error,
		exit: (code) => {
			throw new Error(`exit ${code}`);
		}
	};
	let allowFrom = msteamsCfg.allowFrom;
	let groupAllowFrom = msteamsCfg.groupAllowFrom;
	let teamsConfig = msteamsCfg.teams;
	const allowNameMatching = isDangerousNameMatchingEnabled(msteamsCfg);
	const cleanAllowEntry = (entry) => entry.replace(/^(msteams|teams):/i, "").replace(/^user:/i, "").trim();
	const isStableUserId = (entry) => /^[0-9a-fA-F-]{16,}$/.test(entry);
	const cleanAllowEntries = (entries) => entries?.map((entry) => cleanAllowEntry(entry)).filter((entry) => entry && entry !== "*") ?? [];
	const mergeStableUserIds = (entries) => {
		const additions = cleanAllowEntries(entries).filter((entry) => isStableUserId(entry));
		return additions.length > 0 ? mergeAllowlist({
			existing: entries,
			additions
		}) : entries;
	};
	const resolveAllowlistUsers = async (label, entries) => {
		if (entries.length === 0) return {
			additions: [],
			unresolved: []
		};
		const resolved = await resolveMSTeamsUserAllowlist({
			cfg,
			entries
		});
		const additions = [];
		const unresolved = [];
		for (const entry of resolved) if (entry.resolved && entry.id) additions.push(entry.id);
		else unresolved.push(entry.input);
		summarizeMapping(label, resolved.filter((entry) => entry.resolved && entry.id).map((entry) => `${entry.input}→${entry.id}`), unresolved, runtime);
		return {
			additions,
			unresolved
		};
	};
	try {
		allowFrom = mergeStableUserIds(allowFrom);
		if (Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0) groupAllowFrom = mergeStableUserIds(groupAllowFrom);
		if (allowNameMatching) {
			const allowEntries = cleanAllowEntries(allowFrom).filter((entry) => !isStableUserId(entry));
			if (allowEntries.length > 0) {
				const { additions } = await resolveAllowlistUsers("msteams users", allowEntries);
				allowFrom = mergeAllowlist({
					existing: allowFrom,
					additions
				});
			}
			if (Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0) {
				const groupEntries = cleanAllowEntries(groupAllowFrom).filter((entry) => !isStableUserId(entry));
				if (groupEntries.length > 0) {
					const { additions } = await resolveAllowlistUsers("msteams group users", groupEntries);
					groupAllowFrom = mergeAllowlist({
						existing: groupAllowFrom,
						additions
					});
				}
			}
		}
		if (teamsConfig && Object.keys(teamsConfig).length > 0) {
			const entries = [];
			for (const [teamKey, teamCfg] of Object.entries(teamsConfig)) {
				if (teamKey === "*") continue;
				const channels = teamCfg?.channels ?? {};
				const channelKeys = Object.keys(channels).filter((key) => key !== "*");
				if (channelKeys.length === 0) {
					entries.push({
						input: teamKey,
						teamKey
					});
					continue;
				}
				for (const channelKey of channelKeys) entries.push({
					input: `${teamKey}/${channelKey}`,
					teamKey,
					channelKey
				});
			}
			if (entries.length > 0) {
				const resolved = await resolveMSTeamsChannelAllowlist({
					cfg,
					entries: entries.map((entry) => entry.input)
				});
				const mapping = [];
				const unresolved = [];
				const nextTeams = { ...teamsConfig };
				resolved.forEach((entry, idx) => {
					const source = entries[idx];
					if (!source) return;
					const sourceTeam = teamsConfig?.[source.teamKey] ?? {};
					if (!entry.resolved || !entry.teamId) {
						unresolved.push(entry.input);
						return;
					}
					mapping.push(entry.channelId ? `${entry.input}→${entry.teamId}/${entry.channelId}` : `${entry.input}→${entry.teamId}`);
					const existing = nextTeams[entry.teamId] ?? {};
					const mergedChannels = {
						...sourceTeam.channels,
						...existing.channels
					};
					const mergedTeam = {
						...sourceTeam,
						...existing,
						channels: mergedChannels
					};
					nextTeams[entry.teamId] = mergedTeam;
					if (source.channelKey && entry.channelId) {
						const sourceChannel = sourceTeam.channels?.[source.channelKey];
						if (sourceChannel) nextTeams[entry.teamId] = {
							...mergedTeam,
							channels: {
								...mergedChannels,
								[entry.channelId]: {
									...sourceChannel,
									...mergedChannels?.[entry.channelId]
								}
							}
						};
					}
				});
				teamsConfig = nextTeams;
				summarizeMapping("msteams channels", mapping, unresolved, runtime);
			}
		}
	} catch (err) {
		runtime?.error(`msteams resolve failed; falling back to raw config entries — allowlist members resolved via Graph may be missing. ${formatUnknownError(err)}`);
	}
	msteamsCfg = {
		...msteamsCfg,
		allowFrom,
		groupAllowFrom,
		teams: teamsConfig
	};
	cfg = {
		...cfg,
		channels: {
			...cfg.channels,
			msteams: msteamsCfg
		}
	};
	const port = msteamsCfg.webhook?.port ?? 3978;
	const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "msteams");
	const MB = 1024 * 1024;
	const agentDefaults = cfg.agents?.defaults;
	const mediaMaxBytes = typeof agentDefaults?.mediaMaxMb === "number" && agentDefaults.mediaMaxMb > 0 ? Math.floor(agentDefaults.mediaMaxMb * MB) : 8 * MB;
	const conversationStore = opts.conversationStore ?? createMSTeamsConversationStoreFs();
	const pollStore = opts.pollStore ?? createMSTeamsPollStoreFs();
	log.info(`starting provider (port ${port})`);
	const express = await import("express");
	const { sdk, app } = await loadMSTeamsSdkWithAuth(creds);
	const tokenProvider = createMSTeamsTokenProvider(app);
	const adapter = createMSTeamsAdapter(app, sdk);
	let ssoDeps;
	if (msteamsCfg.sso?.enabled && msteamsCfg.sso.connectionName) {
		ssoDeps = {
			tokenProvider,
			tokenStore: createMSTeamsSsoTokenStoreFs(),
			connectionName: msteamsCfg.sso.connectionName
		};
		log.debug?.("msteams sso enabled", { connectionName: msteamsCfg.sso.connectionName });
	}
	const handler = buildActivityHandler();
	registerMSTeamsHandlers(handler, {
		cfg,
		runtime,
		appId,
		adapter,
		tokenProvider,
		textLimit,
		mediaMaxBytes,
		conversationStore,
		pollStore,
		log,
		sso: ssoDeps
	});
	const expressApp = express.default();
	expressApp.use((req, res, next) => {
		const auth = req.headers.authorization;
		if (!auth || !auth.startsWith("Bearer ")) {
			res.status(401).json({ error: "Unauthorized" });
			return;
		}
		next();
	});
	const jwtValidator = await createBotFrameworkJwtValidator(creds);
	expressApp.use((req, res, next) => {
		const authHeader = req.headers.authorization;
		jwtValidator.validate(authHeader).then((valid) => {
			if (!valid) {
				log.debug?.("JWT validation failed");
				res.status(401).json({ error: "Unauthorized" });
				return;
			}
			next();
		}).catch((err) => {
			if (err instanceof Error && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET/i.test(err.code ?? err.message)) runtime?.error(`msteams: JWKS key fetch failed — check egress to login.botframework.com:443 (firewall or DNS may be blocking it). Bot will 401 all inbound requests until this is resolved. Error: ${formatUnknownError(err)}`);
			else log.debug?.(`JWT validation error: ${formatUnknownError(err)}`);
			res.status(401).json({ error: "Unauthorized" });
		});
	});
	expressApp.use(express.json({ limit: MSTEAMS_WEBHOOK_MAX_BODY_BYTES }));
	expressApp.use((err, _req, res, next) => {
		if (err && typeof err === "object" && "status" in err && err.status === 413) {
			res.status(413).json({ error: "Payload too large" });
			return;
		}
		next(err);
	});
	const configuredPath = msteamsCfg.webhook?.path ?? "/api/messages";
	const messageHandler = (req, res) => {
		adapter.process(req, res, (context) => handler.run(context)).catch((err) => {
			log.error("msteams webhook failed", { error: formatUnknownError(err) });
		});
	};
	expressApp.post(configuredPath, messageHandler);
	if (configuredPath !== "/api/messages") expressApp.post("/api/messages", messageHandler);
	log.debug?.("listening on paths", {
		primary: configuredPath,
		fallback: "/api/messages"
	});
	const httpServer = expressApp.listen(port);
	await new Promise((resolve, reject) => {
		const onListening = () => {
			httpServer.off("error", onError);
			log.info(`msteams provider started on port ${port}`);
			resolve();
		};
		const onError = (err) => {
			httpServer.off("listening", onListening);
			log.error("msteams server error", { error: formatUnknownError(err) });
			reject(err);
		};
		httpServer.once("listening", onListening);
		httpServer.once("error", onError);
	});
	applyMSTeamsWebhookTimeouts(httpServer);
	httpServer.on("error", (err) => {
		log.error("msteams server error", { error: formatUnknownError(err) });
	});
	const shutdown = async () => {
		log.info("shutting down msteams provider");
		return new Promise((resolve) => {
			httpServer.close((err) => {
				if (err) log.debug?.("msteams server close error", { error: formatUnknownError(err) });
				resolve();
			});
		});
	};
	await keepHttpServerTaskAlive({
		server: httpServer,
		abortSignal: opts.abortSignal,
		onAbort: shutdown
	});
	return {
		app: expressApp,
		shutdown
	};
}
/**
* Build a minimal ActivityHandler-compatible object that supports
* onMessage / onMembersAdded registration and a run() method.
*/
function buildActivityHandler() {
	const messageHandlers = [];
	const membersAddedHandlers = [];
	const reactionsAddedHandlers = [];
	const reactionsRemovedHandlers = [];
	const handler = {
		onMessage(cb) {
			messageHandlers.push(cb);
			return handler;
		},
		onMembersAdded(cb) {
			membersAddedHandlers.push(cb);
			return handler;
		},
		onReactionsAdded(cb) {
			reactionsAddedHandlers.push(cb);
			return handler;
		},
		onReactionsRemoved(cb) {
			reactionsRemovedHandlers.push(cb);
			return handler;
		},
		async run(context) {
			const ctx = context;
			const activityType = ctx?.activity?.type;
			const noop = async () => {};
			if (activityType === "message") for (const h of messageHandlers) await h(context, noop);
			else if (activityType === "conversationUpdate") for (const h of membersAddedHandlers) await h(context, noop);
			else if (activityType === "messageReaction") {
				const activity = ctx?.activity;
				if (activity?.reactionsAdded?.length) for (const h of reactionsAddedHandlers) await h(context, noop);
				if (activity?.reactionsRemoved?.length) for (const h of reactionsRemovedHandlers) await h(context, noop);
			}
		}
	};
	return handler;
}
//#endregion
export { monitorMSTeamsProvider };
