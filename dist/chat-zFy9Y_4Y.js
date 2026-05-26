import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { a as formatUncaughtError, i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { b as assertNoWindowsNetworkPath, w as safeFileURLToPath } from "./fs-safe-CV86zY9G.js";
import { r as openLocalFileSafely } from "./secure-temp-dir-aidxCRgA.js";
import { i as resolveAgentModelPrimaryValue, r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { c as measureDiagnosticsTimelineSpanSync, s as measureDiagnosticsTimelineSpan } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { a as hasGatewayClientCap, i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES, t as GATEWAY_CLIENT_CAPS } from "./client-info-BVWE_ra1.js";
import { r as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-core-BoUoCGOD.js";
import { a as isOperatorUiClient, n as isGatewayCliClient, o as isWebchatClient, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { r as setSafeTimeout } from "./timer-delay-awNPCchy.js";
import { C as validateChatSendParams, Ni as ErrorCodes, Pi as errorShape, S as validateChatInjectParams, t as formatValidationErrors, x as validateChatHistoryParams, y as validateChatAbortParams } from "./protocol-DiXjp30g.js";
import { s as normalizeInputProvenance } from "./input-provenance-CmqYxlZ2.js";
import { t as ADMIN_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import "./method-scopes-D4RcH8qD.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import "./local-file-access-CBe_wA_B.js";
import { t as isPassThroughRemoteMediaSource } from "./media-source-url-B2V2UVFP.js";
import { n as deliveryContextFromSession } from "./delivery-context.shared-CBmB9dF7.js";
import { i as resolveSessionFilePath } from "./paths-Bg3PO6Gj.js";
import "./sessions-CQHHcgC_.js";
import { o as isAudioFileName } from "./mime-DppuT-pZ.js";
import { c as appendSessionTranscriptMessage, o as streamSessionTranscriptLines } from "./transcript-BA0Ngd-A.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-ClYG_P1o.js";
import { i as buildModelAliasIndex, l as inferUniqueProviderFromConfiguredModels, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { n as modelKey } from "./model-selection-normalize-CBfQo-Fd.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { r as resolveAgentTimeoutMs } from "./task-completion-contract-D5t-_eBh.js";
import { h as stripEnvelopeFromMessage, i as readRecentSessionMessagesAsync, m as readSessionTranscriptIndex, n as capArrayByJsonBytes, x as jsonUtf8Bytes } from "./session-utils.fs-CsnHXIqH.js";
import { i as stripInlineDirectiveTagsForDisplay, n as sanitizeReplyDirectiveId } from "./directive-tags-CClLEtM7.js";
import { c as loadSessionEntry, d as resolveDeletedAgentIdFromSessionKey, h as resolveGatewaySessionThinkingDefault, p as resolveGatewayModelSupportsImages, v as resolveSessionModelRef } from "./session-utils-CRKr-5AU.js";
import { a as getReplyPayloadTtsSupplement, n as buildTtsSupplementMediaPayload, s as isReplyPayloadTtsSupplement } from "./reply-payload-CiT5mlcY.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import { t as dispatchInboundMessage } from "./dispatch-cQjCJvZr.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { c as isNonTerminalAgentRunStatus } from "./subagent-announce-delivery-p160OmJs.js";
import { i as normalizeReplyPayloadsForDelivery } from "./payloads-BOM5t2O4.js";
import { i as deleteMediaBuffer, t as MEDIA_MAX_BYTES, u as saveMediaBuffer } from "./store-rQFzzX5P.js";
import { r as getAgentScopedMediaLocalRoots, t as appendLocalMediaParentRoots } from "./local-roots-Pi6a9oaK.js";
import { n as assertLocalMediaAllowed, t as LocalMediaAccessError } from "./local-media-access-Cfwhp6hG.js";
import { c as normalizeProviderStarted, d as normalizeBlockedLivenessWaitStatus, s as normalizeAgentRunTimeoutPhase } from "./run-wait-BlZoP48F.js";
import { a as ensureSandboxWorkspaceForSession } from "./sandbox-DiI74XYF.js";
import { l as rewriteTranscriptEntriesInSessionFile } from "./context-engine-lifecycle-BMb8IJAk.js";
import { u as isPluginOwnedSessionBindingRecord } from "./conversation-binding-CMioKWCr.js";
import { n as resolveSendPolicy } from "./send-policy-Dh6BW0dE.js";
import { n as createReplyMediaPathNormalizer } from "./reply-media-paths.runtime-DYciI0K5.js";
import { t as createReplyDispatcher } from "./reply-dispatcher-DPt1UxjJ.js";
import { i as registerChatAbortController, o as updateChatRunProvider, r as isChatStopCommandText, t as abortChatRunById } from "./chat-abort-GHhFaqcz.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-EtNTatED.js";
import { t as logLargePayload } from "./diagnostic-payload-DTCZLTc7.js";
import { c as getMaxChatHistoryMessagesBytes } from "./server-constants-BGwLM6XN.js";
import { t as formatForLog } from "./ws-log-Ds39xp21.js";
import "./channel-message-DMGbyII_.js";
import { t as augmentChatHistoryWithCliSessionImports } from "./cli-session-history-D7YDatc9.js";
import { n as isSuppressedControlReplyText } from "./control-reply-text-CL8TBl4o.js";
import { a as projectRecentChatDisplayMessages, n as isToolHistoryBlockType, o as resolveEffectiveChatHistoryMaxChars, r as projectChatDisplayMessage } from "./chat-display-projection-D_n0QMN-.js";
import { t as stageSandboxMedia } from "./stage-sandbox-media-Cvwi-a_Q.js";
import { a as resolveChatAttachmentLooksLikeImage, i as parseMessageWithAttachments, n as MediaOffloadError, o as resolveChatAttachmentMaxBytes, r as UnsupportedAttachmentError, t as normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize-DnMVXpe_.js";
import { i as createManagedOutgoingImageBlocks, n as attachManagedOutgoingImagesToMessage, r as cleanupManagedOutgoingImageRecords } from "./managed-image-attachments-CZvCe_Xl.js";
import { n as timestampOptsFromConfig, t as injectTimestamp } from "./agent-timestamp-JdPenpRZ.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
//#region src/auto-reply/reply/image-model-override-plan.ts
function resolveImageModelCandidate(params) {
	const trimmed = params.raw.trim();
	if (!trimmed) return null;
	const imageDefaultProvider = trimmed.includes("/") ? params.defaultProvider : inferUniqueProviderFromConfiguredModels({
		cfg: params.cfg,
		model: trimmed
	}) ?? params.defaultProvider;
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: imageDefaultProvider
	});
	const resolved = resolveModelRefFromString({
		cfg: params.cfg,
		raw: trimmed,
		defaultProvider: imageDefaultProvider,
		aliasIndex
	});
	if (!resolved) return null;
	const ref = resolved.ref;
	return {
		raw: trimmed,
		ref,
		key: modelKey(ref.provider, ref.model)
	};
}
async function resolveImageModelOverridePlan(params) {
	if (!params.hasImageAttachments) return {
		kind: "media-paths",
		reason: "no-image-attachments"
	};
	if (params.sessionModelSupportsImages) return { kind: "inline-session" };
	const imageModelConfig = params.cfg.agents?.defaults?.imageModel;
	const primary = resolveAgentModelPrimaryValue(imageModelConfig);
	const rawCandidates = [...primary ? [primary] : [], ...resolveAgentModelFallbackValues(imageModelConfig)];
	if (rawCandidates.length === 0) return {
		kind: "media-paths",
		reason: "no-image-model"
	};
	const runnableCandidates = [];
	for (const raw of rawCandidates) {
		const candidate = resolveImageModelCandidate({
			raw,
			cfg: params.cfg,
			defaultProvider: params.defaultProvider
		});
		if (!candidate) continue;
		if (!await params.modelSupportsImages(candidate.ref)) continue;
		runnableCandidates.push(candidate);
	}
	const selected = runnableCandidates[0];
	if (!selected) return {
		kind: "media-paths",
		reason: "not-vision-capable"
	};
	return {
		kind: "inline-image-model",
		modelOverride: selected.key,
		modelOverrideFallbacks: runnableCandidates.slice(1).map((candidate) => candidate.key)
	};
}
//#endregion
//#region src/chat/canvas-render.ts
function tryParseJsonRecord(value) {
	if (typeof value !== "string") return;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
function getRecordStringField(record, key) {
	const value = record?.[key];
	return typeof value === "string" && value.trim() ? value : void 0;
}
function getRecordNumberField(record, key) {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function getNestedRecord(record, key) {
	const value = record?.[key];
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function normalizeSurface(value) {
	return value === "assistant_message" ? value : void 0;
}
function normalizePreferredHeight(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 160 ? Math.min(Math.trunc(value), 1200) : void 0;
}
function coerceCanvasPreview(record) {
	if (!record) return;
	if (getRecordStringField(record, "kind")?.trim().toLowerCase() !== "canvas") return;
	const presentation = getNestedRecord(record, "presentation");
	const view = getNestedRecord(record, "view");
	const source = getNestedRecord(record, "source");
	const requestedSurface = getRecordStringField(presentation, "target") ?? getRecordStringField(record, "target");
	const surface = requestedSurface ? normalizeSurface(requestedSurface) : "assistant_message";
	if (!surface) return;
	const title = getRecordStringField(presentation, "title") ?? getRecordStringField(view, "title");
	const preferredHeight = normalizePreferredHeight(getRecordNumberField(presentation, "preferred_height") ?? getRecordNumberField(presentation, "preferredHeight") ?? getRecordNumberField(view, "preferred_height") ?? getRecordNumberField(view, "preferredHeight"));
	const className = getRecordStringField(presentation, "class_name") ?? getRecordStringField(presentation, "className");
	const style = getRecordStringField(presentation, "style");
	const viewUrl = getRecordStringField(view, "url") ?? getRecordStringField(view, "entryUrl");
	const viewId = getRecordStringField(view, "id") ?? getRecordStringField(view, "docId");
	if (viewUrl) return {
		kind: "canvas",
		surface,
		render: "url",
		url: viewUrl,
		...viewId ? { viewId } : {},
		...title ? { title } : {},
		...preferredHeight ? { preferredHeight } : {},
		...className ? { className } : {},
		...style ? { style } : {}
	};
	if (getRecordStringField(source, "type")?.trim().toLowerCase() === "url") {
		const url = getRecordStringField(source, "url");
		if (!url) return;
		return {
			kind: "canvas",
			surface,
			render: "url",
			url,
			...title ? { title } : {},
			...preferredHeight ? { preferredHeight } : {},
			...className ? { className } : {},
			...style ? { style } : {}
		};
	}
}
function extractCanvasFromText(outputText, _toolName) {
	return coerceCanvasPreview(tryParseJsonRecord(outputText));
}
//#endregion
//#region src/gateway/server-methods/agent-wait-dedupe.ts
const AGENT_WAITERS_BY_RUN_ID = /* @__PURE__ */ new Map();
function parseRunIdFromDedupeKey(key) {
	if (key.startsWith("agent:")) return key.slice(6) || null;
	if (key.startsWith("chat:")) return key.slice(5) || null;
	return null;
}
function asFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function asString(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function removeWaiter(runId, waiter) {
	const waiters = AGENT_WAITERS_BY_RUN_ID.get(runId);
	if (!waiters) return;
	waiters.delete(waiter);
	if (waiters.size === 0) AGENT_WAITERS_BY_RUN_ID.delete(runId);
}
function addWaiter(runId, waiter) {
	const normalizedRunId = runId.trim();
	if (!normalizedRunId) return () => {};
	const existing = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
	if (existing) {
		existing.add(waiter);
		return () => removeWaiter(normalizedRunId, waiter);
	}
	AGENT_WAITERS_BY_RUN_ID.set(normalizedRunId, new Set([waiter]));
	return () => removeWaiter(normalizedRunId, waiter);
}
function notifyWaiters(runId) {
	const normalizedRunId = runId.trim();
	if (!normalizedRunId) return;
	const waiters = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
	if (!waiters || waiters.size === 0) return;
	for (const waiter of waiters) waiter();
}
function readTerminalSnapshotFromDedupeEntry(entry) {
	const payload = entry.payload;
	const status = typeof payload?.status === "string" ? payload.status : void 0;
	if (isNonTerminalAgentRunStatus(status)) return null;
	const startedAt = asFiniteNumber(payload?.startedAt);
	const endedAt = asFiniteNumber(payload?.endedAt) ?? entry.ts;
	const resultMeta = asRecord(asRecord(payload?.result)?.meta);
	const stopReason = asString(payload?.stopReason) ?? asString(resultMeta?.stopReason);
	const livenessState = asString(payload?.livenessState) ?? asString(resultMeta?.livenessState);
	const yielded = payload?.yielded === true || resultMeta?.yielded === true;
	const timeoutPhase = normalizeAgentRunTimeoutPhase(payload?.timeoutPhase) ?? normalizeAgentRunTimeoutPhase(resultMeta?.timeoutPhase);
	const providerStarted = normalizeProviderStarted(payload?.providerStarted) ?? normalizeProviderStarted(resultMeta?.providerStarted);
	const errorMessage = typeof payload?.error === "string" ? payload.error : typeof payload?.summary === "string" ? payload.summary : entry.error?.message;
	if (status === "ok" || status === "timeout") {
		const normalized = normalizeBlockedLivenessWaitStatus({
			status,
			livenessState,
			error: errorMessage
		});
		return {
			status: normalized.status,
			startedAt,
			endedAt,
			error: normalized.status === "error" ? normalized.error : normalized.status === "timeout" ? errorMessage : void 0,
			stopReason,
			livenessState,
			...yielded ? { yielded } : {},
			...timeoutPhase ? { timeoutPhase } : {},
			...providerStarted !== void 0 ? { providerStarted } : {}
		};
	}
	if (status === "error" || !entry.ok) return {
		status: "error",
		startedAt,
		endedAt,
		error: errorMessage,
		stopReason,
		livenessState,
		...yielded ? { yielded } : {},
		...timeoutPhase ? { timeoutPhase } : {},
		...providerStarted !== void 0 ? { providerStarted } : {}
	};
	return null;
}
function readTerminalSnapshotFromGatewayDedupe(params) {
	if (params.ignoreAgentTerminalSnapshot) {
		const chatEntry = params.dedupe.get(`chat:${params.runId}`);
		if (!chatEntry) return null;
		return readTerminalSnapshotFromDedupeEntry(chatEntry);
	}
	const chatEntry = params.dedupe.get(`chat:${params.runId}`);
	const chatSnapshot = chatEntry ? readTerminalSnapshotFromDedupeEntry(chatEntry) : null;
	const agentEntry = params.dedupe.get(`agent:${params.runId}`);
	const agentSnapshot = agentEntry ? readTerminalSnapshotFromDedupeEntry(agentEntry) : null;
	if (agentEntry) {
		if (!agentSnapshot) {
			if (chatSnapshot && chatEntry && chatEntry.ts > agentEntry.ts) return chatSnapshot;
			return null;
		}
	}
	if (agentSnapshot && chatSnapshot && agentEntry && chatEntry) return chatEntry.ts > agentEntry.ts ? chatSnapshot : agentSnapshot;
	return agentSnapshot ?? chatSnapshot;
}
async function waitForTerminalGatewayDedupe(params) {
	const initial = readTerminalSnapshotFromGatewayDedupe(params);
	if (initial) return initial;
	if (params.timeoutMs <= 0 || params.signal?.aborted) return null;
	return await new Promise((resolve) => {
		let settled = false;
		let timeoutHandle;
		let onAbort;
		let removeWaiter;
		const finish = (snapshot) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (onAbort) params.signal?.removeEventListener("abort", onAbort);
			removeWaiter?.();
			resolve(snapshot);
		};
		const onWake = () => {
			const snapshot = readTerminalSnapshotFromGatewayDedupe(params);
			if (snapshot) finish(snapshot);
		};
		removeWaiter = addWaiter(params.runId, onWake);
		onWake();
		if (settled) return;
		timeoutHandle = setSafeTimeout(() => finish(null), params.timeoutMs);
		timeoutHandle.unref?.();
		onAbort = () => finish(null);
		params.signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function setGatewayDedupeEntry(params) {
	const existing = params.dedupe.get(params.key);
	const existingSnapshot = existing ? readTerminalSnapshotFromDedupeEntry(existing) : null;
	const incomingSnapshot = readTerminalSnapshotFromDedupeEntry(params.entry);
	if (existingSnapshot?.status === "timeout" && existingSnapshot.stopReason === "rpc") return;
	params.dedupe.set(params.key, params.entry);
	const runId = parseRunIdFromDedupeKey(params.key);
	if (!runId) return;
	if (!incomingSnapshot) return;
	notifyWaiters(runId);
}
//#endregion
//#region src/gateway/server-methods/chat-reply-media.ts
function isDataUrlMedia(mediaUrl) {
	return mediaUrl.trim().toLowerCase().startsWith("data:");
}
function shouldPreserveDisplayMediaUrl(payload, mediaUrl) {
	if (isDataUrlMedia(mediaUrl)) return true;
	if (!isAudioFileName(mediaUrl)) return false;
	if (isPassThroughRemoteMediaSource(mediaUrl)) return true;
	return payload.trustedLocalMedia === true;
}
async function normalizeWebchatReplyMediaPathsForDisplay(params) {
	if (params.payloads.length === 0) return params.payloads;
	const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
	if (!workspaceDir) return params.payloads;
	const normalizeMediaPaths = createReplyMediaPathNormalizer({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		agentId: params.agentId,
		workspaceDir,
		accountId: params.accountId
	});
	const normalized = [];
	for (const payload of params.payloads) {
		if (payload.sensitiveMedia === true) {
			normalized.push(payload);
			continue;
		}
		const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
		if (!mediaUrls.some((mediaUrl) => shouldPreserveDisplayMediaUrl(payload, mediaUrl))) {
			normalized.push(await normalizeMediaPaths(payload));
			continue;
		}
		if (!mediaUrls.some((mediaUrl) => !shouldPreserveDisplayMediaUrl(payload, mediaUrl))) {
			normalized.push(payload);
			continue;
		}
		const mergedMediaUrls = [];
		let text = payload.text;
		for (const mediaUrl of mediaUrls) {
			if (shouldPreserveDisplayMediaUrl(payload, mediaUrl)) {
				mergedMediaUrls.push(mediaUrl);
				continue;
			}
			const normalizedMediaUrls = resolveSendableOutboundReplyParts(await normalizeMediaPaths({
				...payload,
				mediaUrl,
				mediaUrls: [mediaUrl]
			})).mediaUrls;
			if (normalizedMediaUrls.length === 0) continue;
			mergedMediaUrls.push(...normalizedMediaUrls);
		}
		normalized.push({
			...payload,
			text,
			mediaUrl: mergedMediaUrls[0],
			mediaUrls: mergedMediaUrls
		});
	}
	return normalized;
}
//#endregion
//#region src/gateway/server-methods/chat-transcript-inject.ts
function resolveInjectedAssistantContent(params) {
	const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
	if (params.content && params.content.length > 0) {
		if (!labelPrefix) return params.content;
		const first = params.content[0];
		if (first && typeof first === "object" && first.type === "text" && typeof first.text === "string") return [{
			...first,
			text: `${labelPrefix}${first.text}`
		}, ...params.content.slice(1)];
		return [{
			type: "text",
			text: labelPrefix.trim()
		}, ...params.content];
	}
	return [{
		type: "text",
		text: `${labelPrefix}${params.message}`
	}];
}
async function appendInjectedAssistantMessageToTranscript(params) {
	const now = params.now ?? Date.now();
	const messageBody = {
		role: "assistant",
		content: resolveInjectedAssistantContent({
			message: params.message,
			label: params.label,
			content: params.content
		}),
		timestamp: now,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0
			}
		},
		api: "openai-responses",
		provider: "openclaw",
		model: "gateway-injected",
		...params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {},
		...params.ttsSupplement ? { openclawTtsSupplement: params.ttsSupplement } : {},
		...params.abortMeta ? { openclawAbort: {
			aborted: true,
			origin: params.abortMeta.origin,
			runId: params.abortMeta.runId
		} } : {}
	};
	try {
		const { messageId, message: appendedMessage } = await appendSessionTranscriptMessage({
			transcriptPath: params.transcriptPath,
			message: messageBody,
			now,
			useRawWhenLinear: true,
			config: params.config
		});
		emitSessionTranscriptUpdate({
			sessionFile: params.transcriptPath,
			message: appendedMessage,
			messageId
		});
		return {
			ok: true,
			messageId,
			message: appendedMessage
		};
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
		};
	}
}
//#endregion
//#region src/gateway/server-methods/chat-webchat-media.ts
/** Cap local audio files exposed through assistant media. */
const MAX_WEBCHAT_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_WEBCHAT_IMAGE_DATA_URL_CHARS = 2e6;
const MAX_WEBCHAT_IMAGE_DATA_BYTES = 15e5;
const ALLOWED_WEBCHAT_DATA_IMAGE_MEDIA_TYPES = new Set([
	"image/apng",
	"image/avif",
	"image/bmp",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp"
]);
const MIME_BY_EXT = {
	".aac": "audio/aac",
	".m4a": "audio/mp4",
	".mp3": "audio/mpeg",
	".oga": "audio/ogg",
	".ogg": "audio/ogg",
	".opus": "audio/opus",
	".wav": "audio/wav",
	".webm": "audio/webm"
};
/** Map `mediaUrl` strings to an absolute filesystem path for local embedding (plain paths or `file:` URLs). */
function resolveLocalMediaPathForEmbedding(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (/^data:/i.test(trimmed)) return null;
	if (/^https?:/i.test(trimmed)) return null;
	if (trimmed.startsWith("file:")) try {
		const p = safeFileURLToPath(trimmed);
		if (!path.isAbsolute(p)) return null;
		return p;
	} catch {
		return null;
	}
	if (!path.isAbsolute(trimmed)) return null;
	try {
		assertNoWindowsNetworkPath(trimmed, "Local media path");
	} catch {
		return null;
	}
	return trimmed;
}
async function readLocalAudioContentBlockForEmbedding(payload, raw, options) {
	if (payload.trustedLocalMedia !== true) return null;
	const resolved = resolveLocalMediaPathForEmbedding(raw);
	if (!resolved) return null;
	if (!isAudioFileName(resolved)) return null;
	let opened;
	try {
		await assertLocalMediaAllowed(resolved, options?.localRoots);
		opened = await openLocalFileSafely({ filePath: resolved });
		await assertLocalMediaAllowed(opened.realPath, options?.localRoots);
		if (opened.stat.size > MAX_WEBCHAT_AUDIO_BYTES) return null;
		return {
			path: opened.realPath,
			block: {
				type: "attachment",
				attachment: {
					url: opened.realPath,
					kind: "audio",
					label: path.basename(opened.realPath),
					mimeType: mimeTypeForPath(opened.realPath),
					...payload.audioAsVoice === true ? { isVoiceNote: true } : {}
				}
			}
		};
	} catch (err) {
		if (err instanceof LocalMediaAccessError) options?.onLocalAudioAccessDenied?.(err);
		return null;
	} finally {
		await opened?.handle.close().catch(() => {});
	}
}
function mimeTypeForPath(filePath) {
	return MIME_BY_EXT[normalizeLowercaseStringOrEmpty(path.extname(filePath))] ?? "audio/mpeg";
}
function estimateBase64DecodedBytes(base64) {
	const sanitized = base64.replace(/\s+/g, "");
	const padding = sanitized.endsWith("==") ? 2 : sanitized.endsWith("=") ? 1 : 0;
	return Math.floor(sanitized.length * 3 / 4) - padding;
}
function resolveEmbeddableImageUrl(url) {
	const trimmed = url.trim();
	if (!trimmed) return null;
	if (trimmed.length > MAX_WEBCHAT_IMAGE_DATA_URL_CHARS) return null;
	const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
	if (!match) return null;
	const mediaType = normalizeLowercaseStringOrEmpty(match[1]);
	const base64Data = match[2];
	if (!ALLOWED_WEBCHAT_DATA_IMAGE_MEDIA_TYPES.has(mediaType)) return null;
	if (estimateBase64DecodedBytes(base64Data) > MAX_WEBCHAT_IMAGE_DATA_BYTES) return null;
	return trimmed;
}
function resolveReplyDirectivePrefix(payload) {
	const replyToId = sanitizeReplyDirectiveId(payload.replyToId);
	if (replyToId) return `[[reply_to:${replyToId}]]`;
	if (payload.replyToCurrent) return "[[reply_to_current]]";
	return "";
}
/**
* Build Control UI / transcript `content` blocks for local TTS (or other) audio files
* referenced by slash-command / agent replies when the webchat path only had text aggregation.
*/
async function buildWebchatAudioContentBlocksFromReplyPayloads(payloads, options) {
	const seen = /* @__PURE__ */ new Set();
	const blocks = [];
	for (const payload of payloads) {
		if (payload.isReasoning === true) continue;
		const parts = resolveSendableOutboundReplyParts(payload);
		for (const raw of parts.mediaUrls) {
			const url = raw.trim();
			if (!url) continue;
			const audio = await readLocalAudioContentBlockForEmbedding(payload, url, options);
			if (!audio || seen.has(audio.path)) continue;
			seen.add(audio.path);
			blocks.push(audio.block);
		}
	}
	return blocks;
}
async function buildWebchatAssistantMessageFromReplyPayloads(payloads, options) {
	const content = [];
	const transcriptTextParts = [];
	const seenAudio = /* @__PURE__ */ new Set();
	const seenImages = /* @__PURE__ */ new Set();
	let hasAudio = false;
	let hasImage = false;
	for (const payload of payloads) {
		if (payload.isReasoning === true) continue;
		const visibleText = payload.text?.trim();
		const text = visibleText && !isSuppressedControlReplyText(visibleText) ? visibleText : void 0;
		const replyDirectivePrefix = resolveReplyDirectivePrefix(payload);
		let payloadHasAudio = false;
		let payloadHasImage = false;
		const payloadMediaBlocks = [];
		const parts = resolveSendableOutboundReplyParts(payload);
		for (const raw of parts.mediaUrls) {
			const url = raw.trim();
			if (!url) continue;
			const audio = await readLocalAudioContentBlockForEmbedding(payload, url, options);
			if (audio) {
				if (seenAudio.has(audio.path)) continue;
				seenAudio.add(audio.path);
				payloadMediaBlocks.push(audio.block);
				hasAudio = true;
				payloadHasAudio = true;
				continue;
			}
			const imageUrl = resolveEmbeddableImageUrl(url);
			if (!imageUrl || seenImages.has(imageUrl)) continue;
			seenImages.add(imageUrl);
			payloadMediaBlocks.push({
				type: "input_image",
				image_url: imageUrl
			});
			hasImage = true;
			payloadHasImage = true;
		}
		const syntheticText = payloadMediaBlocks.length > 0 && (!text || replyDirectivePrefix) && transcriptTextParts.length === 0 ? payloadHasAudio && payloadHasImage ? "Media reply" : payloadHasAudio ? "Audio reply" : "Image reply" : void 0;
		const blockText = text ?? syntheticText;
		if (blockText) {
			const fullText = replyDirectivePrefix ? `${replyDirectivePrefix}${blockText}` : blockText;
			transcriptTextParts.push(fullText);
			content.push({
				type: "text",
				text: fullText
			});
		} else if (replyDirectivePrefix) {
			transcriptTextParts.push(replyDirectivePrefix);
			content.push({
				type: "text",
				text: replyDirectivePrefix
			});
		}
		content.push(...payloadMediaBlocks);
	}
	if (!hasAudio && !hasImage) return null;
	const transcriptText = transcriptTextParts.join("\n\n").trim() || (hasAudio && hasImage ? "Media reply" : hasAudio ? "Audio reply" : "Image reply");
	if (transcriptTextParts.length === 0) content.unshift({
		type: "text",
		text: transcriptText
	});
	return {
		content,
		transcriptText
	};
}
//#endregion
//#region src/gateway/server-methods/chat.ts
function normalizeUnknownText(value) {
	return typeof value === "string" ? normalizeOptionalText(value) : void 0;
}
/** True when a reply payload carries at least one media reference (mediaUrl or mediaUrls). */
function isMediaBearingPayload(payload) {
	if (payload.isReasoning === true) return false;
	if (payload.mediaUrl?.trim()) return true;
	if (payload.mediaUrls?.some((url) => url.trim())) return true;
	return false;
}
function stripVisibleTextFromTtsSupplement(payload) {
	return isReplyPayloadTtsSupplement(payload) ? buildTtsSupplementMediaPayload(payload) : payload;
}
function resolveTtsSupplementMarkerText(text) {
	const trimmed = text.trim();
	const projected = projectChatDisplayMessage({
		role: "assistant",
		content: [{
			type: "text",
			text: trimmed
		}]
	}, { maxChars: Number.MAX_SAFE_INTEGER });
	return extractAssistantDisplayTextFromContent(Array.isArray(projected?.content) ? projected.content : void 0) ?? (typeof projected?.text === "string" ? projected.text.trim() : void 0) ?? trimmed;
}
function buildTtsSupplementTranscriptMarker(payload) {
	const supplement = getReplyPayloadTtsSupplement(payload);
	if (!supplement) return;
	const visibleText = resolveTtsSupplementMarkerText(payload.text?.trim() || supplement.spokenText.trim());
	return { textSha256: createHash("sha256").update(visibleText).digest("hex") };
}
function buildMediaOnlyTtsSupplementTranscriptMarker(payload) {
	if (payload.text?.trim()) return;
	return buildTtsSupplementTranscriptMarker(payload);
}
async function hasImageChatAttachments(attachments) {
	for (const [index, attachment] of attachments.entries()) if (await resolveChatAttachmentLooksLikeImage(attachment, index)) return true;
	return false;
}
async function buildWebchatAssistantMediaMessage(payloads, options) {
	return buildWebchatAssistantMessageFromReplyPayloads(payloads, {
		localRoots: options?.localRoots,
		onLocalAudioAccessDenied: (err) => {
			options?.onLocalAudioAccessDenied?.(formatForLog(err));
		}
	});
}
const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const MANAGED_OUTGOING_IMAGE_PATH_PREFIX = "/api/chat/media/outgoing/";
let chatHistoryPlaceholderEmitCount = 0;
const chatHistoryManagedImageCleanupState = /* @__PURE__ */ new Map();
const CHANNEL_AGNOSTIC_SESSION_SCOPES = new Set([
	"main",
	"direct",
	"dm",
	"group",
	"channel",
	"cron",
	"run",
	"subagent",
	"acp",
	"thread",
	"topic"
]);
const CHANNEL_SCOPED_SESSION_SHAPES = new Set([
	"direct",
	"dm",
	"group",
	"channel"
]);
const ACTIVE_CHAT_SEND_DEDUPE_PREFIX = "chat:active-send";
function resolveActiveChatSendRunId(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const runId = value.runId;
	return typeof runId === "string" && runId.trim() ? runId : null;
}
function buildActiveChatSendDedupeKey(params) {
	const message = params.message.trim();
	if (!message || message.startsWith("/") || params.attachmentCount > 0 || params.explicitDeliverRoute || normalizeMessageChannel(params.originatingChannel) !== "webchat") return null;
	return `${ACTIVE_CHAT_SEND_DEDUPE_PREFIX}:${createHash("sha256").update(JSON.stringify([params.sessionKey, message])).digest("hex").slice(0, 32)}`;
}
function formatAttachmentFailureForLog(err) {
	const primary = formatUncaughtError(err);
	const cause = err instanceof Error ? err.cause : void 0;
	if (cause === void 0) return primary;
	const causeText = formatUncaughtError(cause);
	if (!causeText || causeText === primary) return primary;
	return `${primary}\nCaused by: ${causeText}`;
}
function logAttachmentFailure(logGateway, label, err) {
	logGateway.error(label, {
		error: formatAttachmentFailureForLog(err),
		consoleMessage: `${label}: ${formatForLog(err)}`
	});
}
function buildTranscriptReplyText(payloads) {
	return payloads.map((payload) => {
		if (payload.isReasoning === true) return "";
		const parts = resolveSendableOutboundReplyParts(payload);
		const lines = [];
		const replyToId = sanitizeReplyDirectiveId(payload.replyToId);
		if (replyToId) lines.push(`[[reply_to:${replyToId}]]`);
		else if (payload.replyToCurrent) lines.push("[[reply_to_current]]");
		const text = payload.text?.trim();
		if (text && !isSuppressedControlReplyText(text)) lines.push(text);
		for (const mediaUrl of parts.mediaUrls) {
			if (payload.sensitiveMedia === true) continue;
			const trimmed = mediaUrl.trim();
			if (trimmed) lines.push(`MEDIA:${trimmed}`);
		}
		if (payload.audioAsVoice && parts.mediaUrls.some((mediaUrl) => isAudioFileName(mediaUrl))) lines.push("[[audio_as_voice]]");
		return lines.join("\n").trim();
	}).filter(Boolean).join("\n\n").trim();
}
function hasSensitiveMediaPayload(payloads) {
	return payloads.some((payload) => payload.sensitiveMedia === true && isMediaBearingPayload(payload));
}
function sanitizeAssistantDisplayText(value) {
	if (!value) return;
	const withoutEnvelope = stripEnvelopeFromMessage(value);
	return stripInlineDirectiveTagsForDisplay(typeof withoutEnvelope === "string" ? withoutEnvelope : value).text.trim() || void 0;
}
function extractAssistantDisplayTextFromContent(content) {
	if (!Array.isArray(content) || content.length === 0) return;
	const parts = content.map((block) => {
		if (block?.type !== "text" || typeof block.text !== "string") return "";
		return block.text.trim();
	}).filter(Boolean);
	return parts.length > 0 ? parts.join("\n\n") : void 0;
}
async function buildAssistantDisplayContentFromReplyPayloads(params) {
	const rawTextPayloadCount = params.payloads.filter((payload) => payload.isReasoning !== true && typeof payload.text === "string" && payload.text.trim().length > 0).length;
	const normalized = normalizeReplyPayloadsForDelivery(params.payloads);
	if (normalized.length === 0) return rawTextPayloadCount > 0 ? [{
		type: "text",
		text: ""
	}] : void 0;
	const content = [];
	let strippedTextPayloadCount = 0;
	for (const payload of normalized) {
		const text = sanitizeAssistantDisplayText(payload.text);
		if (text) content.push({
			type: "text",
			text
		});
		else if (typeof payload.text === "string" && payload.text.trim().length > 0) strippedTextPayloadCount += 1;
		if (params.includeSensitiveMedia === false && payload.sensitiveMedia === true) continue;
		const audioBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads([payload], {
			localRoots: Array.isArray(params.managedImageLocalRoots) ? params.managedImageLocalRoots : void 0,
			onLocalAudioAccessDenied: (err) => {
				params.onLocalAudioAccessDenied?.(formatForLog(err));
			}
		});
		content.push(...audioBlocks);
		const mediaUrls = Array.from(new Set([...Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [], ...typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []]));
		const imageBlocks = await createManagedOutgoingImageBlocks({
			sessionKey: params.sessionKey,
			mediaUrls,
			localRoots: params.managedImageLocalRoots,
			continueOnPrepareError: true,
			onPrepareError: (error) => {
				params.onManagedImagePrepareError?.(error.message);
			}
		});
		if (imageBlocks.length > 0) content.push(...imageBlocks);
	}
	if (content.length > 0) return content;
	return strippedTextPayloadCount > 0 ? [{
		type: "text",
		text: ""
	}] : void 0;
}
function replaceAssistantContentTextBlocks(content, transcriptMediaMessage) {
	const transcriptTextBlocks = (transcriptMediaMessage?.content ?? []).filter((block) => Boolean(block) && typeof block === "object" && block.type === "text" && typeof block.text === "string");
	if (transcriptTextBlocks.length === 0) return content ? [...content] : void 0;
	if (!content || content.length === 0) return [...transcriptTextBlocks];
	const merged = [];
	let transcriptTextIndex = 0;
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string" && transcriptTextIndex < transcriptTextBlocks.length) {
			merged.push(transcriptTextBlocks[transcriptTextIndex++]);
			continue;
		}
		merged.push(block);
	}
	if (transcriptTextIndex < transcriptTextBlocks.length) merged.unshift(...transcriptTextBlocks.slice(transcriptTextIndex));
	return merged;
}
function isManagedOutgoingImageUrl(value) {
	if (typeof value !== "string" || !value.trim()) return false;
	try {
		return new URL(value, "http://localhost").pathname.startsWith(MANAGED_OUTGOING_IMAGE_PATH_PREFIX);
	} catch {
		return false;
	}
}
function stripManagedOutgoingAssistantContentBlocks(content) {
	if (!content || content.length === 0) return;
	const filtered = content.filter((block) => {
		if (block?.type !== "image") return true;
		return !(isManagedOutgoingImageUrl(block.url) || isManagedOutgoingImageUrl(block.openUrl));
	});
	return filtered.length > 0 ? filtered : void 0;
}
function extractAssistantDisplayText(content) {
	if (!content || content.length === 0) return;
	return content.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n\n").trim() || void 0;
}
function hasAssistantDisplayMediaContent(content) {
	return Boolean(content?.some((block) => block?.type !== "text"));
}
function scheduleChatHistoryManagedImageCleanup(params) {
	if (chatHistoryManagedImageCleanupState.has(params.sessionKey)) return;
	const pending = cleanupManagedOutgoingImageRecords({ sessionKey: params.sessionKey }).then(() => void 0).catch((error) => {
		params.context.logGateway.debug(`chat.history managed image cleanup skipped sessionKey=${JSON.stringify(params.sessionKey)} error=${formatForLog(error)}`);
	}).finally(() => {
		if (chatHistoryManagedImageCleanupState.get(params.sessionKey) === pending) chatHistoryManagedImageCleanupState.delete(params.sessionKey);
	});
	chatHistoryManagedImageCleanupState.set(params.sessionKey, pending);
}
function resolveChatSendOriginatingRoute(params) {
	if (params.explicitOrigin?.originatingChannel && params.explicitOrigin.originatingTo) return {
		originatingChannel: params.explicitOrigin.originatingChannel,
		originatingTo: params.explicitOrigin.originatingTo,
		...params.explicitOrigin.accountId ? { accountId: params.explicitOrigin.accountId } : {},
		...params.explicitOrigin.messageThreadId ? { messageThreadId: params.explicitOrigin.messageThreadId } : {},
		explicitDeliverRoute: params.deliver === true
	};
	if (!(params.deliver === true)) return {
		originatingChannel: INTERNAL_MESSAGE_CHANNEL,
		explicitDeliverRoute: false
	};
	const sessionDeliveryContext = deliveryContextFromSession(params.entry);
	const routeChannelCandidate = normalizeMessageChannel(sessionDeliveryContext?.channel ?? params.entry?.lastChannel ?? params.entry?.origin?.provider);
	const routeToCandidate = sessionDeliveryContext?.to ?? params.entry?.lastTo;
	const routeAccountIdCandidate = sessionDeliveryContext?.accountId ?? params.entry?.lastAccountId ?? params.entry?.origin?.accountId ?? void 0;
	const routeThreadIdCandidate = sessionDeliveryContext?.threadId ?? params.entry?.lastThreadId ?? params.entry?.origin?.threadId;
	if (params.sessionKey.length > 512) return {
		originatingChannel: INTERNAL_MESSAGE_CHANNEL,
		explicitDeliverRoute: false
	};
	const sessionScopeParts = (parseAgentSessionKey(params.sessionKey)?.rest ?? params.sessionKey).split(":", 3).filter(Boolean);
	const sessionScopeHead = sessionScopeParts[0];
	const sessionChannelHint = normalizeMessageChannel(sessionScopeHead);
	const normalizedSessionScopeHead = (sessionScopeHead ?? "").trim().toLowerCase();
	const sessionPeerShapeCandidates = [sessionScopeParts[1], sessionScopeParts[2]].map((part) => (part ?? "").trim().toLowerCase()).filter(Boolean);
	const isChannelAgnosticSessionScope = CHANNEL_AGNOSTIC_SESSION_SCOPES.has(normalizedSessionScopeHead);
	const isChannelScopedSession = sessionPeerShapeCandidates.some((part) => CHANNEL_SCOPED_SESSION_SHAPES.has(part));
	const hasLegacyChannelPeerShape = !isChannelScopedSession && typeof sessionScopeParts[1] === "string" && sessionChannelHint === routeChannelCandidate;
	const isFromWebchatClient = isWebchatClient(params.client);
	const isFromGatewayCliClient = isGatewayCliClient(params.client);
	const hasClientMetadata = typeof params.client?.mode === "string" && params.client.mode.trim().length > 0 || typeof params.client?.id === "string" && params.client.id.trim().length > 0;
	const configuredMainKey = (params.mainKey ?? "main").trim().toLowerCase();
	const canInheritConfiguredMainRoute = normalizedSessionScopeHead.length > 0 && normalizedSessionScopeHead === configuredMainKey && params.hasConnectedClient && (isFromGatewayCliClient || !hasClientMetadata);
	if (!(Boolean(!isFromWebchatClient && sessionChannelHint && sessionChannelHint !== "webchat" && (!isChannelAgnosticSessionScope && (isChannelScopedSession || hasLegacyChannelPeerShape) || canInheritConfiguredMainRoute)) && routeChannelCandidate && routeChannelCandidate !== "webchat" && typeof routeToCandidate === "string" && routeToCandidate.trim().length > 0)) return {
		originatingChannel: INTERNAL_MESSAGE_CHANNEL,
		explicitDeliverRoute: false
	};
	return {
		originatingChannel: routeChannelCandidate,
		originatingTo: routeToCandidate,
		accountId: routeAccountIdCandidate,
		messageThreadId: routeThreadIdCandidate,
		explicitDeliverRoute: true
	};
}
function isAcpSessionKey(sessionKey) {
	return Boolean(sessionKey?.split(":").includes("acp"));
}
function explicitOriginTargetsAcpSession(origin) {
	if (!origin?.originatingChannel || !origin.originatingTo || !origin.accountId) return false;
	const channel = normalizeMessageChannel(origin.originatingChannel);
	if (!channel || channel === "webchat") return false;
	return isAcpSessionKey(getSessionBindingService().resolveByConversation({
		channel,
		accountId: origin.accountId,
		conversationId: origin.originatingTo
	})?.targetSessionKey);
}
function explicitOriginTargetsPluginBinding(origin) {
	if (!origin?.originatingChannel || !origin.originatingTo || !origin.accountId) return false;
	const channel = normalizeMessageChannel(origin.originatingChannel);
	if (!channel || channel === "webchat") return false;
	return isPluginOwnedSessionBindingRecord(getSessionBindingService().resolveByConversation({
		channel,
		accountId: origin.accountId,
		conversationId: origin.originatingTo
	}));
}
function stripDisallowedChatControlChars(message) {
	let output = "";
	for (const char of message) {
		const code = char.charCodeAt(0);
		if (code === 9 || code === 10 || code === 13 || code >= 32 && code !== 127) output += char;
	}
	return output;
}
function sanitizeChatSendMessageInput(message) {
	const normalized = message.normalize("NFC");
	if (normalized.includes("\0")) return {
		ok: false,
		error: "message must not contain null bytes"
	};
	return {
		ok: true,
		message: stripDisallowedChatControlChars(normalized)
	};
}
function normalizeOptionalChatSystemReceipt(value) {
	if (value == null) return { ok: true };
	if (typeof value !== "string") return {
		ok: false,
		error: "systemProvenanceReceipt must be a string"
	};
	const sanitized = sanitizeChatSendMessageInput(value);
	if (!sanitized.ok) return sanitized;
	return {
		ok: true,
		receipt: sanitized.message.trim() || void 0
	};
}
function isAcpBridgeClient(client) {
	const info = client?.connect?.client;
	return info?.id === GATEWAY_CLIENT_NAMES.CLI && info?.mode === GATEWAY_CLIENT_MODES.CLI && info?.displayName === "ACP" && info?.version === "acp";
}
function canInjectSystemProvenance(client) {
	return (Array.isArray(client?.connect?.scopes) ? client.connect.scopes : []).includes(ADMIN_SCOPE);
}
async function persistChatSendImages(params) {
	if (params.images.length === 0 && params.offloadedRefs.length === 0 || isAcpBridgeClient(params.client)) return [];
	const inlineSaved = [];
	for (const img of params.images) try {
		inlineSaved.push(await saveMediaBuffer(Buffer.from(img.data, "base64"), img.mimeType, "inbound"));
	} catch (err) {
		params.logGateway.warn(`chat.send: failed to persist inbound image (${img.mimeType}): ${formatForLog(err)}`);
	}
	const imageOffloadedSaved = [];
	const nonImageOffloadedSaved = [];
	for (const ref of params.offloadedRefs) {
		const entry = {
			id: ref.id,
			path: ref.path,
			size: 0,
			contentType: ref.mimeType
		};
		if (ref.mimeType.startsWith("image/")) imageOffloadedSaved.push(entry);
		else nonImageOffloadedSaved.push(entry);
	}
	if (params.imageOrder.length === 0) return [
		...inlineSaved,
		...imageOffloadedSaved,
		...nonImageOffloadedSaved
	];
	const saved = [];
	let inlineIndex = 0;
	let offloadedIndex = 0;
	for (const entry of params.imageOrder) {
		if (entry === "inline") {
			const inline = inlineSaved[inlineIndex++];
			if (inline) saved.push(inline);
			continue;
		}
		const offloaded = imageOffloadedSaved[offloadedIndex++];
		if (offloaded) saved.push(offloaded);
	}
	for (; inlineIndex < inlineSaved.length; inlineIndex++) {
		const inline = inlineSaved[inlineIndex];
		if (inline) saved.push(inline);
	}
	for (; offloadedIndex < imageOffloadedSaved.length; offloadedIndex++) {
		const offloaded = imageOffloadedSaved[offloadedIndex];
		if (offloaded) saved.push(offloaded);
	}
	for (const offloaded of nonImageOffloadedSaved) saved.push(offloaded);
	return saved;
}
function buildChatSendTranscriptMessage(params) {
	const mediaFields = resolveChatSendTranscriptMediaFields(params.savedImages);
	return {
		role: "user",
		content: params.message,
		timestamp: params.timestamp,
		...mediaFields
	};
}
function stripTrailingOffloadedMediaMarkers(message, refs) {
	if (refs.length === 0) return message;
	const removableRefs = new Set(refs.map((ref) => ref.mediaRef));
	const lines = message.split(/\r?\n/);
	while (lines.length > 0) {
		const last = lines[lines.length - 1]?.trim() ?? "";
		const match = /^\[media attached:\s*(media:\/\/inbound\/[^\]\s]+)\]$/.exec(last);
		if (!match?.[1] || !removableRefs.delete(match[1])) break;
		lines.pop();
	}
	return lines.join("\n").trimEnd();
}
async function prestageMediaPathOffloads(params) {
	const mediaPathRefs = params.offloadedRefs.filter((ref) => params.includeImageRefs || !ref.mimeType.startsWith("image/"));
	if (mediaPathRefs.length === 0) return {
		paths: [],
		types: []
	};
	try {
		const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
		const sandbox = await ensureSandboxWorkspaceForSession({
			config: params.cfg,
			sessionKey: params.sessionKey,
			workspaceDir
		});
		if (!sandbox) return {
			paths: mediaPathRefs.map((ref) => ref.path),
			types: mediaPathRefs.map((ref) => ref.mimeType)
		};
		const oversizedForSandbox = mediaPathRefs.filter((ref) => ref.sizeBytes > MEDIA_MAX_BYTES);
		if (oversizedForSandbox.length > 0) throw new UnsupportedAttachmentError("non-image-too-large-for-sandbox", `attachments exceed sandbox staging limit (${MEDIA_MAX_BYTES} bytes): ${oversizedForSandbox.map((ref) => `${ref.label} (${ref.sizeBytes} bytes)`).join(", ")}`);
		const stagingCtx = {
			MediaPath: mediaPathRefs[0].path,
			MediaPaths: mediaPathRefs.map((ref) => ref.path),
			MediaType: mediaPathRefs[0].mimeType,
			MediaTypes: mediaPathRefs.map((ref) => ref.mimeType)
		};
		const stagedSources = (await stageSandboxMedia({
			ctx: stagingCtx,
			sessionCtx: stagingCtx,
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			workspaceDir
		})).staged;
		const missing = mediaPathRefs.filter((ref) => !stagedSources.has(ref.path));
		if (missing.length > 0) throw new Error(`attachment staging incomplete: ${stagedSources.size}/${mediaPathRefs.length} paths staged into sandbox workspace (missing: ${missing.map((ref) => ref.path).join(", ")})`);
		return {
			paths: stagingCtx.MediaPaths ?? [],
			types: stagingCtx.MediaTypes ?? mediaPathRefs.map((ref) => ref.mimeType),
			workspaceDir: sandbox.workspaceDir
		};
	} catch (err) {
		await Promise.allSettled(params.offloadedRefs.map((ref) => deleteMediaBuffer(ref.id, "inbound")));
		if (err instanceof MediaOffloadError) throw err;
		if (err instanceof UnsupportedAttachmentError) throw err;
		throw new MediaOffloadError(`[Gateway Error] Failed to stage attachments into agent workspace: ${formatErrorMessage(err)}`, { cause: err });
	}
}
function resolveChatSendTranscriptMediaFields(savedImages) {
	const mediaPaths = savedImages.map((entry) => entry.path);
	if (mediaPaths.length === 0) return {};
	const mediaTypes = savedImages.map((entry) => entry.contentType ?? "application/octet-stream");
	return {
		MediaPath: mediaPaths[0],
		MediaPaths: mediaPaths,
		MediaType: mediaTypes[0],
		MediaTypes: mediaTypes
	};
}
function extractTranscriptUserText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return;
	const textBlocks = content.map((block) => block && typeof block === "object" && "text" in block ? block.text : void 0).filter((text) => typeof text === "string");
	return textBlocks.length > 0 ? textBlocks.join("") : void 0;
}
async function rewriteChatSendUserTurnMediaPaths(params) {
	const mediaFields = resolveChatSendTranscriptMediaFields(params.savedImages);
	if (!("MediaPath" in mediaFields)) return;
	const target = (await readSessionTranscriptIndex(params.transcriptPath))?.entries.toReversed().find((entry) => {
		const message = entry.record.message;
		if (!message || message.role !== "user") return false;
		const existingPaths = Array.isArray(message.MediaPaths) ? message.MediaPaths : void 0;
		if (typeof message.MediaPath === "string" && message.MediaPath || existingPaths && existingPaths.length > 0) return false;
		return extractTranscriptUserText(message.content) === params.message;
	});
	const targetMessage = target?.record.message;
	if (!target || !target.id || !targetMessage) return;
	const rewrittenMessage = {
		...targetMessage,
		...mediaFields
	};
	await rewriteTranscriptEntriesInSessionFile({
		sessionFile: params.transcriptPath,
		sessionKey: params.sessionKey,
		config: params.cfg,
		request: { replacements: [{
			entryId: target.id,
			message: rewrittenMessage
		}] }
	});
}
function extractChatHistoryBlockText(message) {
	if (!message || typeof message !== "object") return;
	const entry = message;
	if (typeof entry.content === "string") return entry.content;
	if (typeof entry.text === "string") return entry.text;
	if (!Array.isArray(entry.content)) return;
	const textParts = entry.content.map((block) => {
		if (!block || typeof block !== "object") return;
		const typed = block;
		return typeof typed.text === "string" ? typed.text : void 0;
	}).filter((value) => typeof value === "string");
	return textParts.length > 0 ? textParts.join("\n") : void 0;
}
function appendCanvasBlockToAssistantHistoryMessage(params) {
	const preview = params.preview;
	if (!preview || !params.message || typeof params.message !== "object") return params.message;
	const entry = params.message;
	const baseContent = Array.isArray(entry.content) ? [...entry.content] : typeof entry.content === "string" ? [{
		type: "text",
		text: entry.content
	}] : typeof entry.text === "string" ? [{
		type: "text",
		text: entry.text
	}] : [];
	if (!baseContent.some((block) => {
		if (!block || typeof block !== "object") return false;
		const typed = block;
		return typed.type === "canvas" && typed.preview && typeof typed.preview === "object" && (typed.preview.viewId && typed.preview.viewId === preview.viewId || typed.preview.url && typed.preview.url === preview.url);
	})) baseContent.push({
		type: "canvas",
		preview,
		rawText: params.rawText
	});
	return {
		...entry,
		content: baseContent
	};
}
function messageContainsToolHistoryContent(message) {
	if (!message || typeof message !== "object") return false;
	const entry = message;
	if (typeof entry.toolCallId === "string" || typeof entry.tool_call_id === "string" || typeof entry.toolName === "string" || typeof entry.tool_name === "string") return true;
	if (!Array.isArray(entry.content)) return false;
	return entry.content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return isToolHistoryBlockType(block.type);
	});
}
function augmentChatHistoryWithCanvasBlocks(messages) {
	if (messages.length === 0) return messages;
	const next = [...messages];
	let changed = false;
	let lastAssistantIndex = -1;
	let lastRenderableAssistantIndex = -1;
	const pending = [];
	for (let index = 0; index < next.length; index++) {
		const message = next[index];
		if (!message || typeof message !== "object") continue;
		const entry = message;
		if ((typeof entry.role === "string" ? entry.role.toLowerCase() : "") === "assistant") {
			lastAssistantIndex = index;
			if (!messageContainsToolHistoryContent(entry)) {
				lastRenderableAssistantIndex = index;
				if (pending.length > 0) {
					let target = next[index];
					for (const item of pending) target = appendCanvasBlockToAssistantHistoryMessage({
						message: target,
						preview: item.preview,
						rawText: item.rawText
					});
					next[index] = target;
					pending.length = 0;
					changed = true;
				}
			}
			continue;
		}
		if (!messageContainsToolHistoryContent(entry)) continue;
		const toolName = typeof entry.toolName === "string" ? entry.toolName : typeof entry.tool_name === "string" ? entry.tool_name : void 0;
		const text = extractChatHistoryBlockText(entry);
		const preview = extractCanvasFromText(text, toolName);
		if (!preview) continue;
		pending.push({
			preview,
			rawText: text ?? null
		});
	}
	if (pending.length > 0) {
		const targetIndex = lastRenderableAssistantIndex >= 0 ? lastRenderableAssistantIndex : lastAssistantIndex;
		if (targetIndex >= 0) {
			let target = next[targetIndex];
			for (const item of pending) target = appendCanvasBlockToAssistantHistoryMessage({
				message: target,
				preview: item.preview,
				rawText: item.rawText
			});
			next[targetIndex] = target;
			changed = true;
		}
	}
	return changed ? next : messages;
}
function buildOversizedHistoryPlaceholder(message) {
	return {
		role: message && typeof message === "object" && typeof message.role === "string" ? message.role : "assistant",
		timestamp: message && typeof message === "object" && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
		content: [{
			type: "text",
			text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER
		}],
		__openclaw: {
			truncated: true,
			reason: "oversized"
		}
	};
}
function replaceOversizedChatHistoryMessages(params) {
	const { messages, maxSingleMessageBytes } = params;
	if (messages.length === 0) return {
		messages,
		replacedCount: 0
	};
	let replacedCount = 0;
	const next = messages.map((message) => {
		if (jsonUtf8Bytes(message) <= maxSingleMessageBytes) return message;
		replacedCount += 1;
		return buildOversizedHistoryPlaceholder(message);
	});
	return {
		messages: replacedCount > 0 ? next : messages,
		replacedCount
	};
}
function enforceChatHistoryFinalBudget(params) {
	const { messages, maxBytes } = params;
	if (messages.length === 0) return {
		messages,
		placeholderCount: 0
	};
	if (jsonUtf8Bytes(messages) <= maxBytes) return {
		messages,
		placeholderCount: 0
	};
	const last = messages.at(-1);
	if (last && jsonUtf8Bytes([last]) <= maxBytes) return {
		messages: [last],
		placeholderCount: 0
	};
	const placeholder = buildOversizedHistoryPlaceholder(last);
	if (jsonUtf8Bytes([placeholder]) <= maxBytes) return {
		messages: [placeholder],
		placeholderCount: 1
	};
	return {
		messages: [],
		placeholderCount: 0
	};
}
function resolveTranscriptPath(params) {
	const { sessionId, storePath, sessionFile, agentId } = params;
	if (!storePath && !sessionFile) return null;
	try {
		const sessionsDir = storePath ? path.dirname(storePath) : void 0;
		return resolveSessionFilePath(sessionId, sessionFile ? { sessionFile } : void 0, sessionsDir || agentId ? {
			sessionsDir,
			agentId
		} : void 0);
	} catch {
		return null;
	}
}
function ensureTranscriptFile(params) {
	if (fs.existsSync(params.transcriptPath)) return { ok: true };
	try {
		fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: params.sessionId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			cwd: process.cwd()
		};
		fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
			encoding: "utf-8",
			mode: 384
		});
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
async function transcriptHasIdempotencyKey(transcriptPath, idempotencyKey) {
	try {
		for await (const line of streamSessionTranscriptLines(transcriptPath)) try {
			if (JSON.parse(line)?.message?.idempotencyKey === idempotencyKey) return true;
		} catch {
			continue;
		}
		return false;
	} catch {
		return false;
	}
}
async function appendAssistantTranscriptMessage(params) {
	const transcriptPath = resolveTranscriptPath({
		sessionId: params.sessionId,
		storePath: params.storePath,
		sessionFile: params.sessionFile,
		agentId: params.agentId
	});
	if (!transcriptPath) return {
		ok: false,
		error: "transcript path not resolved"
	};
	if (!fs.existsSync(transcriptPath)) {
		if (!params.createIfMissing) return {
			ok: false,
			error: "transcript file not found"
		};
		const ensured = ensureTranscriptFile({
			transcriptPath,
			sessionId: params.sessionId
		});
		if (!ensured.ok) return {
			ok: false,
			error: ensured.error ?? "failed to create transcript file"
		};
	}
	if (params.idempotencyKey && await transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) return { ok: true };
	return await appendInjectedAssistantMessageToTranscript({
		transcriptPath,
		message: params.message,
		label: params.label,
		content: params.content,
		idempotencyKey: params.idempotencyKey,
		abortMeta: params.abortMeta,
		ttsSupplement: params.ttsSupplement,
		config: params.cfg
	});
}
function collectSessionAbortPartials(params) {
	const out = [];
	for (const [runId, active] of params.chatAbortControllers) {
		if (!params.runIds.has(runId)) continue;
		const text = params.chatRunBuffers.get(runId);
		if (!text || !text.trim()) continue;
		out.push({
			runId,
			sessionId: active.sessionId,
			text,
			abortOrigin: params.abortOrigin
		});
	}
	return out;
}
async function persistAbortedPartials(params) {
	if (params.snapshots.length === 0) return;
	const { cfg, storePath, entry } = loadSessionEntry(params.sessionKey);
	for (const snapshot of params.snapshots) {
		const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
		const appended = await appendAssistantTranscriptMessage({
			message: snapshot.text,
			sessionId,
			storePath,
			sessionFile: entry?.sessionFile,
			createIfMissing: true,
			idempotencyKey: `${snapshot.runId}:assistant`,
			cfg,
			abortMeta: {
				aborted: true,
				origin: snapshot.abortOrigin,
				runId: snapshot.runId
			}
		});
		if (!appended.ok) params.context.logGateway.warn(`chat.abort transcript append failed: ${appended.error ?? "unknown error"}`);
	}
}
function createChatAbortOps(context) {
	return {
		chatAbortControllers: context.chatAbortControllers,
		chatRunBuffers: context.chatRunBuffers,
		chatDeltaSentAt: context.chatDeltaSentAt,
		chatDeltaLastBroadcastLen: context.chatDeltaLastBroadcastLen,
		chatDeltaLastBroadcastText: context.chatDeltaLastBroadcastText,
		agentDeltaSentAt: context.agentDeltaSentAt,
		bufferedAgentEvents: context.bufferedAgentEvents,
		chatAbortedRuns: context.chatAbortedRuns,
		removeChatRun: context.removeChatRun,
		agentRunSeq: context.agentRunSeq,
		broadcast: context.broadcast,
		nodeSendToSession: context.nodeSendToSession
	};
}
function normalizeOptionalText(value) {
	return value?.trim() || void 0;
}
function normalizeExplicitChatSendOrigin(params) {
	const originatingChannel = normalizeOptionalText(params.originatingChannel);
	const originatingTo = normalizeOptionalText(params.originatingTo);
	const accountId = normalizeOptionalText(params.accountId);
	const messageThreadId = normalizeOptionalText(params.messageThreadId);
	if (!Boolean(originatingChannel || originatingTo || accountId || messageThreadId)) return { ok: true };
	const normalizedChannel = normalizeMessageChannel(originatingChannel);
	if (!normalizedChannel) return {
		ok: false,
		error: "originatingChannel is required when using originating route fields"
	};
	if (!originatingTo) return {
		ok: false,
		error: "originatingTo is required when using originating route fields"
	};
	return {
		ok: true,
		value: {
			originatingChannel: normalizedChannel,
			originatingTo,
			...accountId ? { accountId } : {},
			...messageThreadId ? { messageThreadId } : {}
		}
	};
}
function resolveChatAbortRequester(client) {
	const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
	return {
		connId: normalizeOptionalText(client?.connId),
		deviceId: normalizeOptionalText(client?.connect?.device?.id),
		isAdmin: scopes.includes(ADMIN_SCOPE)
	};
}
function canRequesterAbortChatRun(entry, requester) {
	if (requester.isAdmin) return true;
	const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
	const ownerConnId = normalizeOptionalText(entry.ownerConnId);
	if (!ownerDeviceId && !ownerConnId) return true;
	if (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) return true;
	if (ownerConnId && requester.connId && ownerConnId === requester.connId) return true;
	return false;
}
function canRequesterAbortChatRunWithoutSessionMatch(entry, requester) {
	if (requester.isAdmin) return true;
	const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
	const ownerConnId = normalizeOptionalText(entry.ownerConnId);
	return Boolean(ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId || ownerConnId && requester.connId && ownerConnId === requester.connId);
}
function readPreRegisteredAgentDedupePayloadForSession(params) {
	if (!params.entry?.ok) return;
	const payload = params.entry.payload;
	if (payload?.status !== "accepted") return;
	const payloadRunId = normalizeUnknownText(payload.runId);
	if (payloadRunId && payloadRunId !== params.runId) return;
	return normalizeUnknownText(payload.sessionKey) === params.sessionKey ? payload : void 0;
}
function readPreRegisteredAgentRun(params) {
	if (!params.key.startsWith("agent:") || !params.entry?.ok) return;
	const payload = params.entry.payload;
	if (payload?.status !== "accepted") return;
	const runId = normalizeUnknownText(payload.runId) ?? normalizeOptionalText(params.key.slice(6));
	const sessionKey = normalizeUnknownText(payload.sessionKey);
	if (!runId || !sessionKey) return;
	return {
		runId,
		sessionKey,
		payload
	};
}
function canRequesterAbortPreRegisteredAgentRun(payload, requester) {
	return canRequesterAbortChatRun({
		controller: new AbortController(),
		sessionId: "",
		sessionKey: normalizeUnknownText(payload.sessionKey) ?? "",
		startedAtMs: 0,
		expiresAtMs: 0,
		ownerConnId: normalizeUnknownText(payload.ownerConnId),
		ownerDeviceId: normalizeUnknownText(payload.ownerDeviceId),
		kind: "agent"
	}, requester);
}
function resolvePreRegisteredAgentDedupeKeys(payload, runId) {
	const keys = [`agent:${runId}`];
	const payloadKeys = Array.isArray(payload.dedupeKeys) ? payload.dedupeKeys : [];
	for (const key of payloadKeys) {
		const normalized = normalizeUnknownText(key);
		if (normalized?.startsWith("agent:")) keys.push(normalized);
	}
	return [...new Set(keys)];
}
function writePreRegisteredAgentAbort(params) {
	const endedAt = params.endedAt ?? Date.now();
	for (const key of resolvePreRegisteredAgentDedupeKeys(params.payload, params.runId)) setGatewayDedupeEntry({
		dedupe: params.context.dedupe,
		key,
		entry: {
			ts: endedAt,
			ok: true,
			payload: {
				runId: params.runId,
				sessionKey: params.sessionKey,
				status: "timeout",
				summary: "aborted",
				stopReason: params.stopReason,
				endedAt
			}
		}
	});
}
function resolveAuthorizedPreRegisteredAgentRunsForSessionKeys(params) {
	const sessionKeys = new Set(Array.from(params.sessionKeys, (sessionKey) => normalizeOptionalText(sessionKey)).filter((sessionKey) => Boolean(sessionKey)));
	const authorizedByRunId = /* @__PURE__ */ new Map();
	let matchedSessionRuns = 0;
	for (const [key, entry] of params.context.dedupe) {
		const run = readPreRegisteredAgentRun({
			key,
			entry
		});
		if (!run || !sessionKeys.has(run.sessionKey)) continue;
		if (params.context.chatAbortControllers.has(run.runId)) continue;
		matchedSessionRuns += 1;
		if (canRequesterAbortPreRegisteredAgentRun(run.payload, params.requester)) authorizedByRunId.set(run.runId, run);
	}
	return {
		matchedSessionRuns,
		authorizedRuns: [...authorizedByRunId.values()]
	};
}
function resolveAuthorizedRunsForSessionKeys(params) {
	const sessionKeys = new Set(Array.from(params.sessionKeys, (sessionKey) => normalizeOptionalText(sessionKey)).filter((sessionKey) => Boolean(sessionKey)));
	const sessionIds = new Set(Array.from(params.sessionIds ?? [], (sessionId) => normalizeOptionalText(sessionId)).filter((sessionId) => Boolean(sessionId)));
	const authorizedRuns = [];
	let matchedSessionRuns = 0;
	for (const [runId, active] of params.chatAbortControllers) {
		if (!sessionKeys.has(active.sessionKey) && !sessionIds.has(active.sessionId)) continue;
		matchedSessionRuns += 1;
		if (canRequesterAbortChatRun(active, params.requester)) authorizedRuns.push({
			runId,
			sessionKey: active.sessionKey
		});
	}
	return {
		matchedSessionRuns,
		authorizedRuns
	};
}
async function abortChatRunsForSessionKeyWithPartials(params) {
	const sessionKeys = [params.sessionKey, ...params.sessionKeyAliases ?? []];
	const { matchedSessionRuns, authorizedRuns } = resolveAuthorizedRunsForSessionKeys({
		chatAbortControllers: params.context.chatAbortControllers,
		sessionKeys,
		sessionIds: [params.sessionId],
		requester: params.requester
	});
	const { matchedSessionRuns: matchedPendingAgentRuns, authorizedRuns: authorizedPendingAgentRuns } = resolveAuthorizedPreRegisteredAgentRunsForSessionKeys({
		context: params.context,
		sessionKeys,
		requester: params.requester
	});
	if (authorizedRuns.length === 0 && authorizedPendingAgentRuns.length === 0) return {
		aborted: false,
		runIds: [],
		unauthorized: matchedSessionRuns > 0 || matchedPendingAgentRuns > 0
	};
	const authorizedRunIdSet = new Set(authorizedRuns.map((run) => run.runId));
	const snapshots = collectSessionAbortPartials({
		chatAbortControllers: params.context.chatAbortControllers,
		chatRunBuffers: params.context.chatRunBuffers,
		runIds: authorizedRunIdSet,
		abortOrigin: params.abortOrigin
	});
	const runIds = [];
	for (const { runId, sessionKey } of authorizedRuns) if (abortChatRunById(params.ops, {
		runId,
		sessionKey,
		stopReason: params.stopReason
	}).aborted) runIds.push(runId);
	const endedAt = Date.now();
	const stopReason = params.stopReason ?? "rpc";
	for (const { runId, sessionKey, payload } of authorizedPendingAgentRuns) {
		writePreRegisteredAgentAbort({
			context: params.context,
			runId,
			sessionKey,
			payload,
			stopReason,
			endedAt
		});
		runIds.push(runId);
	}
	const res = {
		aborted: runIds.length > 0,
		runIds,
		unauthorized: false
	};
	if (res.aborted) await persistAbortedPartials({
		context: params.context,
		sessionKey: params.persistSessionKey ?? params.sessionKey,
		snapshots
	});
	return res;
}
function nextChatSeq(context, runId) {
	const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
	context.agentRunSeq.set(runId, next);
	return next;
}
function broadcastChatFinal(params) {
	const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
	const payload = {
		runId: params.runId,
		sessionKey: params.sessionKey,
		seq,
		state: "final",
		message: projectChatDisplayMessage(params.message)
	};
	params.context.broadcast("chat", payload);
	params.context.nodeSendToSession(params.sessionKey, "chat", payload);
	params.context.agentRunSeq.delete(params.runId);
}
function isBtwReplyPayload(payload) {
	return typeof payload?.btw?.question === "string" && payload.btw.question.trim().length > 0 && typeof payload.text === "string" && payload.text.trim().length > 0;
}
function broadcastSideResult(params) {
	const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.payload.runId);
	params.context.broadcast("chat.side_result", {
		...params.payload,
		seq
	});
	params.context.nodeSendToSession(params.payload.sessionKey, "chat.side_result", {
		...params.payload,
		seq
	});
}
function broadcastChatError(params) {
	const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
	const payload = {
		runId: params.runId,
		sessionKey: params.sessionKey,
		seq,
		state: "error",
		errorMessage: params.errorMessage
	};
	params.context.broadcast("chat", payload);
	params.context.nodeSendToSession(params.sessionKey, "chat", payload);
	params.context.agentRunSeq.delete(params.runId);
}
const chatHandlers = {
	"chat.history": async ({ params, respond, context }) => {
		if (!validateChatHistoryParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`));
			return;
		}
		const { sessionKey, limit, maxChars } = params;
		const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
		const sessionId = entry?.sessionId;
		const sessionAgentId = resolveSessionAgentId({
			sessionKey,
			config: cfg
		});
		const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
		const max = Math.min(1e3, typeof limit === "number" ? limit : 200);
		const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
		const localMessages = sessionId && storePath ? await readRecentSessionMessagesAsync(sessionId, storePath, entry?.sessionFile, {
			maxMessages: max,
			maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024)
		}) : [];
		const normalized = augmentChatHistoryWithCanvasBlocks(projectRecentChatDisplayMessages(augmentChatHistoryWithCliSessionImports({
			entry,
			provider: resolvedSessionModel.provider,
			localMessages
		}), {
			maxChars: resolveEffectiveChatHistoryMaxChars(cfg, maxChars),
			maxMessages: max
		}));
		const replaced = replaceOversizedChatHistoryMessages({
			messages: normalized,
			maxSingleMessageBytes: Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes)
		});
		scheduleChatHistoryManagedImageCleanup({
			sessionKey,
			context
		});
		const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
		const bounded = enforceChatHistoryFinalBudget({
			messages: capped,
			maxBytes: maxHistoryBytes
		});
		const placeholderCount = replaced.replacedCount + bounded.placeholderCount;
		if (placeholderCount > 0) {
			chatHistoryPlaceholderEmitCount += placeholderCount;
			logLargePayload({
				surface: "gateway.chat.history",
				action: "truncated",
				bytes: jsonUtf8Bytes(normalized),
				limitBytes: maxHistoryBytes,
				count: placeholderCount,
				reason: "chat_history_budget"
			});
			context.logGateway.debug(`chat.history omitted oversized payloads placeholders=${placeholderCount} total=${chatHistoryPlaceholderEmitCount}`);
		}
		let thinkingLevel = entry?.thinkingLevel;
		if (!thinkingLevel) thinkingLevel = resolveGatewaySessionThinkingDefault({
			cfg,
			agentId: sessionAgentId,
			provider: resolvedSessionModel.provider,
			model: resolvedSessionModel.model
		});
		const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
		respond(true, {
			sessionKey,
			sessionId,
			messages: bounded.messages,
			thinkingLevel,
			fastMode: entry?.fastMode,
			verboseLevel
		});
	},
	"chat.abort": async ({ params, respond, context, client }) => {
		if (!validateChatAbortParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`));
			return;
		}
		const { sessionKey: rawSessionKey, runId } = params;
		const ops = createChatAbortOps(context);
		const requester = resolveChatAbortRequester(client);
		if (!runId) {
			const res = await abortChatRunsForSessionKeyWithPartials({
				context,
				ops,
				sessionKey: rawSessionKey,
				abortOrigin: "rpc",
				stopReason: "rpc",
				requester
			});
			if (res.unauthorized) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
				return;
			}
			respond(true, {
				ok: true,
				aborted: res.aborted,
				runIds: res.runIds
			});
			return;
		}
		const active = context.chatAbortControllers.get(runId);
		if (!active) {
			const pendingAgentPayload = readPreRegisteredAgentDedupePayloadForSession({
				entry: context.dedupe.get(`agent:${runId}`),
				runId,
				sessionKey: rawSessionKey
			});
			if (pendingAgentPayload) {
				if (!canRequesterAbortPreRegisteredAgentRun(pendingAgentPayload, requester)) {
					respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
					return;
				}
				writePreRegisteredAgentAbort({
					context,
					runId,
					sessionKey: rawSessionKey,
					payload: pendingAgentPayload,
					stopReason: "rpc"
				});
				respond(true, {
					ok: true,
					aborted: true,
					runIds: [runId]
				});
				return;
			}
			respond(true, {
				ok: true,
				aborted: false,
				runIds: []
			});
			return;
		}
		if (active.sessionKey !== rawSessionKey && !canRequesterAbortChatRunWithoutSessionMatch(active, requester)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"));
			return;
		}
		if (!canRequesterAbortChatRun(active, requester)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
			return;
		}
		const partialText = context.chatRunBuffers.get(runId);
		const res = abortChatRunById(ops, {
			runId,
			sessionKey: active.sessionKey,
			stopReason: "rpc"
		});
		if (res.aborted && partialText && partialText.trim()) await persistAbortedPartials({
			context,
			sessionKey: active.sessionKey,
			snapshots: [{
				runId,
				sessionId: active.sessionId,
				text: partialText,
				abortOrigin: "rpc"
			}]
		});
		respond(true, {
			ok: true,
			aborted: res.aborted,
			runIds: res.aborted ? [runId] : []
		});
	},
	"chat.send": async ({ params, respond, context, client }) => {
		if (!validateChatSendParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`));
			return;
		}
		const p = params;
		const explicitOriginResult = normalizeExplicitChatSendOrigin({
			originatingChannel: p.originatingChannel,
			originatingTo: p.originatingTo,
			accountId: p.originatingAccountId,
			messageThreadId: p.originatingThreadId
		});
		if (!explicitOriginResult.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, explicitOriginResult.error));
			return;
		}
		if ((p.systemInputProvenance || p.systemProvenanceReceipt || explicitOriginResult.value) && !canInjectSystemProvenance(client)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, p.systemInputProvenance || p.systemProvenanceReceipt ? "system provenance fields require admin scope" : "originating route fields require admin scope"));
			return;
		}
		const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
		if (!sanitizedMessageResult.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error));
			return;
		}
		const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
		if (!systemReceiptResult.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, systemReceiptResult.error));
			return;
		}
		const inboundMessage = sanitizedMessageResult.message;
		const systemInputProvenance = normalizeInputProvenance(p.systemInputProvenance);
		const systemProvenanceReceipt = systemReceiptResult.receipt;
		const stopCommand = isChatStopCommandText(inboundMessage);
		const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
		const rawMessage = inboundMessage.trim();
		if (!rawMessage && normalizedAttachments.length === 0) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"));
			return;
		}
		const rawSessionKey = p.sessionKey;
		const { cfg, entry, canonicalKey: sessionKey } = measureDiagnosticsTimelineSpanSync("gateway.chat_send.load_session", () => loadSessionEntry(rawSessionKey), {
			phase: "agent-turn",
			attributes: {
				hasAttachments: normalizedAttachments.length > 0,
				hasExplicitOrigin: explicitOriginResult.value !== void 0
			}
		});
		const requestedSessionId = normalizeOptionalText(p.sessionId);
		const backingSessionId = entry?.sessionId ?? requestedSessionId;
		const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, sessionKey);
		if (deletedAgentId !== null) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `Agent "${deletedAgentId}" no longer exists in configuration`));
			return;
		}
		const agentId = resolveSessionAgentId({
			sessionKey,
			config: cfg
		});
		const resolvedConfiguredDefaultModel = resolveDefaultModelForAgent({
			cfg,
			agentId
		});
		const resolvedSessionModel = resolveSessionModelRef(cfg, entry, agentId);
		const resolvedSessionAuthProvider = resolveProviderIdForAuth(resolvedSessionModel.provider, { config: cfg });
		let parsedMessage = inboundMessage;
		let parsedImages = [];
		let imageOrder = [];
		let offloadedRefs = [];
		let mediaPathOffloadPaths = [];
		let mediaPathOffloadTypes = [];
		let mediaPathOffloadWorkspaceDir;
		const timeoutMs = resolveAgentTimeoutMs({
			cfg,
			overrideMs: p.timeoutMs
		});
		const now = Date.now();
		const clientRunId = p.idempotencyKey;
		if (resolveSendPolicy({
			cfg,
			entry,
			sessionKey,
			channel: entry?.channel,
			chatType: entry?.chatType
		}) === "deny") {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"));
			return;
		}
		if (stopCommand) {
			const res = await abortChatRunsForSessionKeyWithPartials({
				context,
				ops: createChatAbortOps(context),
				sessionKey: rawSessionKey,
				sessionKeyAliases: sessionKey === rawSessionKey ? void 0 : [sessionKey],
				sessionId: entry?.sessionId,
				persistSessionKey: sessionKey,
				abortOrigin: "stop-command",
				stopReason: "stop",
				requester: resolveChatAbortRequester(client)
			});
			if (res.unauthorized) {
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
				return;
			}
			respond(true, {
				ok: true,
				aborted: res.aborted,
				runIds: res.runIds
			});
			return;
		}
		const cached = context.dedupe.get(`chat:${clientRunId}`);
		if (cached) {
			respond(cached.ok, cached.payload, cached.error, { cached: true });
			return;
		}
		if (context.chatAbortControllers.get(clientRunId)) {
			respond(true, {
				runId: clientRunId,
				status: "in_flight"
			}, void 0, {
				cached: true,
				runId: clientRunId
			});
			return;
		}
		const clientInfo = client?.connect?.client;
		const originatingRoute = resolveChatSendOriginatingRoute({
			client: clientInfo,
			deliver: p.deliver,
			entry,
			explicitOrigin: explicitOriginResult.value,
			hasConnectedClient: client?.connect !== void 0,
			mainKey: cfg.session?.mainKey,
			sessionKey
		});
		const activeChatSendDedupeKey = buildActiveChatSendDedupeKey({
			attachmentCount: normalizedAttachments.length,
			explicitDeliverRoute: originatingRoute.explicitDeliverRoute,
			message: rawMessage,
			originatingChannel: originatingRoute.originatingChannel,
			sessionKey
		});
		if (activeChatSendDedupeKey) {
			const activeRunId = resolveActiveChatSendRunId(context.dedupe.get(activeChatSendDedupeKey)?.payload);
			if (activeRunId && context.chatAbortControllers.has(activeRunId)) {
				respond(true, {
					runId: activeRunId,
					status: "in_flight"
				}, void 0, {
					cached: true,
					runId: activeRunId
				});
				return;
			}
		}
		const explicitOriginTargetsPlugin = explicitOriginTargetsPluginBinding(explicitOriginResult.value);
		let modelOverride;
		let modelOverrideFallbacks;
		if (normalizedAttachments.length > 0) try {
			await measureDiagnosticsTimelineSpan("gateway.chat_send.prepare_attachments", async () => {
				const hasImageAttachments = await hasImageChatAttachments(normalizedAttachments);
				const supportsSessionModelImages = await resolveGatewayModelSupportsImages({
					loadGatewayModelCatalog: context.loadGatewayModelCatalog,
					provider: resolvedSessionModel.provider,
					model: resolvedSessionModel.model
				});
				const explicitOriginSupportsInlineImages = explicitOriginTargetsAcpSession(explicitOriginResult.value) || explicitOriginTargetsPlugin;
				const imageModelPlan = await resolveImageModelOverridePlan({
					cfg,
					agentId,
					defaultProvider: resolvedConfiguredDefaultModel.provider,
					defaultModel: resolvedConfiguredDefaultModel.model,
					hasImageAttachments,
					sessionModelSupportsImages: supportsSessionModelImages || explicitOriginSupportsInlineImages,
					modelSupportsImages: (ref) => resolveGatewayModelSupportsImages({
						loadGatewayModelCatalog: context.loadGatewayModelCatalog,
						provider: ref.provider,
						model: ref.model
					})
				});
				if (imageModelPlan.kind === "inline-image-model") {
					modelOverride = imageModelPlan.modelOverride;
					modelOverrideFallbacks = imageModelPlan.modelOverrideFallbacks;
				}
				const supportsImages = imageModelPlan.kind === "inline-session" || imageModelPlan.kind === "inline-image-model" || explicitOriginSupportsInlineImages;
				const routeImageOffloadsAsMediaPaths = !supportsImages;
				const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
					maxBytes: resolveChatAttachmentMaxBytes(cfg),
					log: context.logGateway,
					supportsImages,
					acceptNonImage: true
				});
				parsedMessage = stripTrailingOffloadedMediaMarkers(parsed.message, routeImageOffloadsAsMediaPaths ? parsed.offloadedRefs.filter((ref) => ref.mimeType.startsWith("image/")) : []);
				parsedImages = parsed.images;
				imageOrder = routeImageOffloadsAsMediaPaths ? [] : parsed.imageOrder;
				offloadedRefs = parsed.offloadedRefs;
				({paths: mediaPathOffloadPaths, types: mediaPathOffloadTypes, workspaceDir: mediaPathOffloadWorkspaceDir} = await prestageMediaPathOffloads({
					offloadedRefs,
					includeImageRefs: routeImageOffloadsAsMediaPaths,
					cfg,
					sessionKey,
					agentId
				}));
			}, {
				phase: "agent-turn",
				config: cfg,
				attributes: {
					attachmentCount: normalizedAttachments.length,
					hasExplicitOrigin: explicitOriginResult.value !== void 0
				}
			});
		} catch (err) {
			logAttachmentFailure(context.logGateway, "chat.send attachment parse/stage failed", err);
			respond(false, void 0, errorShape(err instanceof MediaOffloadError ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST, String(err)));
			return;
		}
		try {
			const activeRunAbort = registerChatAbortController({
				chatAbortControllers: context.chatAbortControllers,
				runId: clientRunId,
				sessionId: backingSessionId ?? clientRunId,
				sessionKey: rawSessionKey,
				timeoutMs,
				now,
				ownerConnId: normalizeOptionalText(client?.connId),
				ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
				providerId: resolvedSessionModel.provider,
				authProviderId: resolvedSessionAuthProvider,
				kind: "chat-send"
			});
			if (!activeRunAbort.registered) {
				respond(true, {
					runId: clientRunId,
					status: "in_flight"
				}, void 0, {
					cached: true,
					runId: clientRunId
				});
				return;
			}
			if (activeChatSendDedupeKey) context.dedupe.set(activeChatSendDedupeKey, {
				ts: now,
				ok: true,
				payload: { runId: clientRunId }
			});
			context.addChatRun(clientRunId, {
				sessionKey,
				clientRunId
			});
			respond(true, {
				runId: clientRunId,
				status: "started"
			}, void 0, { runId: clientRunId });
			const persistedImagesPromise = persistChatSendImages({
				images: parsedImages,
				imageOrder,
				offloadedRefs,
				client,
				logGateway: context.logGateway
			});
			const pluginBoundMediaFields = explicitOriginTargetsPlugin && parsedImages.length > 0 ? resolveChatSendTranscriptMediaFields(await persistedImagesPromise) : {};
			const trimmedMessage = parsedMessage.trim();
			const commandBody = Boolean(p.thinking && trimmedMessage && !trimmedMessage.startsWith("/")) ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
			const commandSource = trimmedMessage.startsWith("/") ? "text" : void 0;
			const messageForAgent = systemProvenanceReceipt ? [systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n") : parsedMessage;
			const { originatingChannel, originatingTo, accountId, messageThreadId, explicitDeliverRoute } = originatingRoute;
			const ctx = {
				Body: messageForAgent,
				BodyForAgent: injectTimestamp(messageForAgent, timestampOptsFromConfig(cfg)),
				BodyForCommands: commandBody,
				RawBody: parsedMessage,
				CommandBody: commandBody,
				InputProvenance: systemInputProvenance,
				SessionKey: sessionKey,
				Provider: INTERNAL_MESSAGE_CHANNEL,
				Surface: INTERNAL_MESSAGE_CHANNEL,
				OriginatingChannel: originatingChannel,
				OriginatingTo: originatingTo,
				ExplicitDeliverRoute: explicitDeliverRoute,
				AccountId: accountId,
				MessageThreadId: messageThreadId,
				ChatType: "direct",
				...commandSource ? { CommandSource: commandSource } : {},
				CommandAuthorized: true,
				CommandTurn: commandSource ? {
					kind: "text-slash",
					source: commandSource,
					authorized: true,
					body: commandBody
				} : {
					kind: "normal",
					source: "message",
					authorized: false,
					body: commandBody
				},
				MessageSid: clientRunId,
				...!isOperatorUiClient(clientInfo) ? {
					SenderId: clientInfo?.id,
					SenderName: clientInfo?.displayName,
					SenderUsername: clientInfo?.displayName
				} : {},
				GatewayClientScopes: client?.connect?.scopes ?? [],
				...pluginBoundMediaFields
			};
			if (mediaPathOffloadPaths.length > 0) {
				ctx.MediaPath = mediaPathOffloadPaths[0];
				ctx.MediaPaths = mediaPathOffloadPaths;
				ctx.MediaType = mediaPathOffloadTypes[0];
				ctx.MediaTypes = mediaPathOffloadTypes;
				ctx.MediaWorkspaceDir = mediaPathOffloadWorkspaceDir;
				ctx.MediaStaged = true;
			}
			const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
				cfg,
				agentId,
				channel: INTERNAL_MESSAGE_CHANNEL
			});
			const chatSendTraceAttributes = {
				hasAttachments: normalizedAttachments.length > 0,
				hasExplicitOrigin: explicitOriginResult.value !== void 0,
				hasConnectedClient: client?.connect !== void 0
			};
			const deliveredReplies = [];
			let appendedWebchatAgentMedia = false;
			let userTranscriptUpdatePromise = null;
			let agentRunStarted = false;
			const hasBeforeAgentRunGate = getGlobalHookRunner()?.hasHooks("before_agent_run") === true;
			const emitUserTranscriptUpdate = async () => {
				if (userTranscriptUpdatePromise) {
					await userTranscriptUpdatePromise;
					return;
				}
				userTranscriptUpdatePromise = (async () => {
					await measureDiagnosticsTimelineSpan("gateway.chat_send.emit_user_transcript", async () => {
						const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
						const resolvedSessionId = latestEntry?.sessionId ?? backingSessionId;
						if (!resolvedSessionId) return;
						const transcriptPath = resolveTranscriptPath({
							sessionId: resolvedSessionId,
							storePath: latestStorePath,
							sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
							agentId
						});
						if (!transcriptPath) return;
						const persistedImages = await persistedImagesPromise;
						emitSessionTranscriptUpdate({
							sessionFile: transcriptPath,
							sessionKey,
							message: buildChatSendTranscriptMessage({
								message: parsedMessage,
								savedImages: persistedImages,
								timestamp: now
							})
						});
					}, {
						phase: "agent-turn",
						config: cfg,
						attributes: chatSendTraceAttributes
					});
				})();
				await userTranscriptUpdatePromise;
			};
			const emitUserTranscriptUpdateAfterAgentRun = async () => {
				await emitUserTranscriptUpdate().catch((transcriptErr) => {
					context.logGateway.warn(`webchat user transcript update failed after agent run: ${formatForLog(transcriptErr)}`);
				});
			};
			let transcriptMediaRewriteDone = false;
			const rewriteUserTranscriptMedia = async () => {
				if (transcriptMediaRewriteDone) return;
				const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
				const resolvedSessionId = latestEntry?.sessionId ?? backingSessionId;
				if (!resolvedSessionId) return;
				const transcriptPath = resolveTranscriptPath({
					sessionId: resolvedSessionId,
					storePath: latestStorePath,
					sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
					agentId
				});
				if (!transcriptPath) return;
				transcriptMediaRewriteDone = true;
				await rewriteChatSendUserTurnMediaPaths({
					transcriptPath,
					sessionKey,
					message: parsedMessage,
					savedImages: await persistedImagesPromise,
					cfg
				});
			};
			const appendWebchatAgentMediaTranscriptIfNeeded = async (payload) => {
				if (!agentRunStarted || appendedWebchatAgentMedia || !isMediaBearingPayload(payload)) return;
				const ttsSupplementMarker = buildTtsSupplementTranscriptMarker(payload);
				const [transcriptPayload] = await normalizeWebchatReplyMediaPathsForDisplay({
					cfg,
					sessionKey,
					agentId,
					accountId,
					payloads: [stripVisibleTextFromTtsSupplement(payload)]
				});
				if (!transcriptPayload) return;
				const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
				const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
				const resolvedTranscriptPath = resolveTranscriptPath({
					sessionId,
					storePath: latestStorePath,
					sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
					agentId
				});
				const mediaLocalRoots = appendLocalMediaParentRoots(getAgentScopedMediaLocalRoots(cfg, agentId), resolvedTranscriptPath ? [resolvedTranscriptPath] : void 0);
				const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
					sessionKey,
					payloads: [transcriptPayload],
					managedImageLocalRoots: mediaLocalRoots,
					includeSensitiveMedia: transcriptPayload.sensitiveMedia !== true,
					onLocalAudioAccessDenied: (message) => {
						context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
					},
					onManagedImagePrepareError: (message) => {
						context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
					}
				});
				const mediaMessage = await buildWebchatAssistantMediaMessage([transcriptPayload], {
					localRoots: mediaLocalRoots,
					onLocalAudioAccessDenied: (message) => {
						context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
					}
				});
				const persistedAssistantContent = replaceAssistantContentTextBlocks(assistantContent, mediaMessage);
				const persistedContentForAppend = hasAssistantDisplayMediaContent(persistedAssistantContent) ? persistedAssistantContent : void 0;
				if (!persistedContentForAppend?.length) return;
				const transcriptReply = mediaMessage?.transcriptText ?? extractAssistantDisplayTextFromContent(assistantContent) ?? buildTranscriptReplyText([transcriptPayload]);
				if (!transcriptReply && !persistedAssistantContent?.length && !assistantContent?.length) return;
				const appended = await appendAssistantTranscriptMessage({
					message: transcriptReply,
					...persistedContentForAppend?.length ? { content: persistedContentForAppend } : {},
					sessionId,
					storePath: latestStorePath,
					sessionFile: latestEntry?.sessionFile,
					agentId,
					createIfMissing: true,
					idempotencyKey: `${clientRunId}:assistant-media`,
					ttsSupplement: ttsSupplementMarker,
					cfg
				});
				if (appended.ok) {
					if (appended.messageId && assistantContent?.length) await attachManagedOutgoingImagesToMessage({
						messageId: appended.messageId,
						blocks: assistantContent
					});
					appendedWebchatAgentMedia = true;
					return;
				}
				context.logGateway.warn(`webchat transcript append failed for media reply: ${appended.error ?? "unknown error"}`);
			};
			const dispatcher = createReplyDispatcher({
				...replyPipeline,
				onError: (err) => {
					context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
				},
				deliver: async (payload, info) => {
					switch (info.kind) {
						case "block":
						case "final":
							deliveredReplies.push({
								payload,
								kind: info.kind
							});
							await appendWebchatAgentMediaTranscriptIfNeeded(payload);
							break;
						case "tool":
							if (isMediaBearingPayload(payload)) deliveredReplies.push({
								payload: {
									...payload,
									text: void 0
								},
								kind: "final"
							});
							break;
					}
				}
			});
			measureDiagnosticsTimelineSpan("gateway.chat_send.dispatch_inbound", () => dispatchInboundMessage({
				ctx,
				cfg,
				dispatcher,
				replyOptions: {
					runId: clientRunId,
					abortSignal: activeRunAbort.controller.signal,
					images: parsedImages.length > 0 ? parsedImages : void 0,
					imageOrder: imageOrder.length > 0 ? imageOrder : void 0,
					modelOverride,
					modelOverrideFallbacks,
					thinkingLevelOverride: p.thinking,
					fastModeOverride: p.fastMode,
					onAgentRunStart: (runId) => {
						agentRunStarted = true;
						if (!hasBeforeAgentRunGate) emitUserTranscriptUpdate();
						const connId = typeof client?.connId === "string" ? client.connId : void 0;
						const wantsToolEvents = hasGatewayClientCap(client?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS);
						if (connId && wantsToolEvents) {
							context.registerToolEventRecipient(runId, connId);
							for (const [activeRunId, active] of context.chatAbortControllers) if (activeRunId !== runId && active.sessionKey === p.sessionKey) context.registerToolEventRecipient(activeRunId, connId);
						}
					},
					onModelSelected: (modelSelection) => {
						updateChatRunProvider(context.chatAbortControllers, {
							runId: clientRunId,
							providerId: modelSelection.provider,
							authProviderId: resolveProviderIdForAuth(modelSelection.provider, { config: cfg })
						});
						onModelSelected(modelSelection);
					}
				}
			}), {
				phase: "agent-turn",
				config: cfg,
				attributes: chatSendTraceAttributes
			}).then(async () => {
				await measureDiagnosticsTimelineSpan("gateway.chat_send.post_dispatch", async () => {
					await rewriteUserTranscriptMedia();
					const returnedAgentErrorPayloads = agentRunStarted ? deliveredReplies.map((entry) => entry.payload).filter((payload) => payload.isError) : [];
					const returnedAgentErrorMessage = returnedAgentErrorPayloads.map((payload) => payload.text?.trim()).filter((text) => Boolean(text)).join(" | ") || void 0;
					if (!agentRunStarted) {
						await emitUserTranscriptUpdate();
						const btwReplies = deliveredReplies.map((entry) => entry.payload).filter(isBtwReplyPayload);
						const btwText = btwReplies.map((payload) => payload.text.trim()).filter(Boolean).join("\n\n").trim();
						if (btwReplies.length > 0 && btwText) {
							broadcastSideResult({
								context,
								payload: {
									kind: "btw",
									runId: clientRunId,
									sessionKey,
									question: btwReplies[0].btw.question.trim(),
									text: btwText,
									isError: btwReplies.some((payload) => payload.isError),
									ts: Date.now()
								}
							});
							broadcastChatFinal({
								context,
								runId: clientRunId,
								sessionKey
							});
						} else {
							const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
								cfg,
								sessionKey,
								agentId,
								accountId,
								payloads: appendedWebchatAgentMedia ? [] : deliveredReplies.filter((entry) => entry.kind === "final").map((entry) => entry.payload)
							});
							const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey);
							const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
							const resolvedTranscriptPath = resolveTranscriptPath({
								sessionId,
								storePath: latestStorePath,
								sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
								agentId
							});
							const mediaLocalRoots = appendLocalMediaParentRoots(getAgentScopedMediaLocalRoots(cfg, agentId), resolvedTranscriptPath ? [resolvedTranscriptPath] : void 0);
							const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
								sessionKey,
								payloads: finalPayloads,
								managedImageLocalRoots: mediaLocalRoots,
								includeSensitiveMedia: false,
								onLocalAudioAccessDenied: (message) => {
									context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
								},
								onManagedImagePrepareError: (message) => {
									context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
								}
							});
							const mediaMessage = await buildWebchatAssistantMediaMessage(finalPayloads, {
								localRoots: mediaLocalRoots,
								onLocalAudioAccessDenied: (message) => {
									context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
								}
							});
							const hasSensitiveMedia = hasSensitiveMediaPayload(finalPayloads);
							const ttsSupplementMarker = finalPayloads.map((payload) => buildMediaOnlyTtsSupplementTranscriptMarker(payload)).find((marker) => Boolean(marker));
							const persistedAssistantContent = replaceAssistantContentTextBlocks(hasSensitiveMedia ? await buildAssistantDisplayContentFromReplyPayloads({
								sessionKey,
								payloads: finalPayloads,
								managedImageLocalRoots: mediaLocalRoots,
								includeSensitiveMedia: false,
								onLocalAudioAccessDenied: (message) => {
									context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
								},
								onManagedImagePrepareError: (message) => {
									context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
								}
							}) : assistantContent, mediaMessage);
							const persistedContentForAppend = hasAssistantDisplayMediaContent(persistedAssistantContent) ? persistedAssistantContent : void 0;
							const broadcastAssistantContent = hasAssistantDisplayMediaContent(assistantContent) ? assistantContent : hasAssistantDisplayMediaContent(mediaMessage?.content) ? mediaMessage?.content : assistantContent;
							const displayReply = extractAssistantDisplayTextFromContent(assistantContent) ?? buildTranscriptReplyText(finalPayloads);
							const transcriptReply = mediaMessage?.transcriptText || buildTranscriptReplyText(finalPayloads) || displayReply;
							let message;
							if (transcriptReply || persistedContentForAppend?.length || assistantContent?.length) {
								const appended = await appendAssistantTranscriptMessage({
									message: transcriptReply,
									...persistedContentForAppend?.length ? { content: persistedContentForAppend } : {},
									sessionId,
									storePath: latestStorePath,
									sessionFile: latestEntry?.sessionFile,
									agentId,
									createIfMissing: true,
									idempotencyKey: clientRunId,
									ttsSupplement: ttsSupplementMarker,
									cfg
								});
								if (appended.ok) {
									if (appended.messageId && assistantContent?.length) await attachManagedOutgoingImagesToMessage({
										messageId: appended.messageId,
										blocks: assistantContent
									});
									message = broadcastAssistantContent?.length ? {
										...appended.message,
										content: broadcastAssistantContent
									} : appended.message;
								} else {
									context.logGateway.warn(`webchat transcript append failed: ${appended.error ?? "unknown error"}`);
									const fallbackAssistantContent = stripManagedOutgoingAssistantContentBlocks(persistedAssistantContent) ?? stripManagedOutgoingAssistantContentBlocks(assistantContent);
									const fallbackText = extractAssistantDisplayText(fallbackAssistantContent) ?? displayReply;
									const now = Date.now();
									message = {
										role: "assistant",
										...fallbackAssistantContent?.length ? { content: fallbackAssistantContent } : fallbackText ? { content: [{
											type: "text",
											text: fallbackText
										}] } : {},
										...fallbackText ? { text: fallbackText } : {},
										timestamp: now,
										...ttsSupplementMarker ? { openclawTtsSupplement: ttsSupplementMarker } : {},
										stopReason: "stop",
										usage: {
											input: 0,
											output: 0,
											totalTokens: 0
										}
									};
								}
							}
							broadcastChatFinal({
								context,
								runId: clientRunId,
								sessionKey,
								message
							});
						}
					} else if (returnedAgentErrorPayloads.length > 0) {
						if (!hasBeforeAgentRunGate) await emitUserTranscriptUpdateAfterAgentRun();
						broadcastChatError({
							context,
							runId: clientRunId,
							sessionKey,
							errorMessage: returnedAgentErrorMessage
						});
					} else if (!hasBeforeAgentRunGate) await emitUserTranscriptUpdateAfterAgentRun();
					if (!context.chatAbortedRuns.has(clientRunId)) {
						const returnedAgentError = returnedAgentErrorPayloads.length > 0 ? errorShape(ErrorCodes.UNAVAILABLE, returnedAgentErrorMessage ?? "agent returned an error payload") : void 0;
						setGatewayDedupeEntry({
							dedupe: context.dedupe,
							key: `chat:${clientRunId}`,
							entry: {
								ts: Date.now(),
								ok: returnedAgentErrorPayloads.length === 0,
								payload: returnedAgentErrorPayloads.length > 0 ? {
									runId: clientRunId,
									status: "error",
									summary: returnedAgentErrorMessage ?? "agent returned an error payload"
								} : {
									runId: clientRunId,
									status: "ok"
								},
								...returnedAgentError ? { error: returnedAgentError } : {}
							}
						});
					}
				}, {
					phase: "agent-turn",
					config: cfg,
					attributes: chatSendTraceAttributes
				});
			}).catch(async (err) => {
				rewriteUserTranscriptMedia().catch((rewriteErr) => {
					context.logGateway.warn(`webchat transcript media rewrite failed after error: ${formatForLog(rewriteErr)}`);
				});
				await (agentRunStarted && hasBeforeAgentRunGate ? Promise.resolve() : emitUserTranscriptUpdate()).catch((transcriptErr) => {
					context.logGateway.warn(`webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`);
				});
				const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
				setGatewayDedupeEntry({
					dedupe: context.dedupe,
					key: `chat:${clientRunId}`,
					entry: {
						ts: Date.now(),
						ok: false,
						payload: {
							runId: clientRunId,
							status: "error",
							summary: String(err)
						},
						error
					}
				});
				broadcastChatError({
					context,
					runId: clientRunId,
					sessionKey,
					errorMessage: String(err)
				});
			}).finally(() => {
				activeRunAbort.cleanup();
				context.removeChatRun(clientRunId, clientRunId, sessionKey);
			});
		} catch (err) {
			context.chatAbortControllers.delete(clientRunId);
			context.removeChatRun(clientRunId, clientRunId, sessionKey);
			const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
			const payload = {
				runId: clientRunId,
				status: "error",
				summary: String(err)
			};
			setGatewayDedupeEntry({
				dedupe: context.dedupe,
				key: `chat:${clientRunId}`,
				entry: {
					ts: Date.now(),
					ok: false,
					payload,
					error
				}
			});
			respond(false, payload, error, {
				runId: clientRunId,
				error: formatForLog(err)
			});
		}
	},
	"chat.inject": async ({ params, respond, context }) => {
		if (!validateChatInjectParams(params)) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`));
			return;
		}
		const p = params;
		const rawSessionKey = p.sessionKey;
		const { cfg, storePath, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
		const sessionId = entry?.sessionId;
		if (!sessionId || !storePath) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
			return;
		}
		const appended = await appendAssistantTranscriptMessage({
			message: p.message,
			label: p.label,
			sessionId,
			storePath,
			sessionFile: entry?.sessionFile,
			agentId: resolveSessionAgentId({
				sessionKey,
				config: cfg
			}),
			createIfMissing: true,
			cfg
		});
		if (!appended.ok || !appended.messageId || !appended.message) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `failed to write transcript: ${appended.error ?? "unknown error"}`));
			return;
		}
		const message = projectChatDisplayMessage(appended.message, { maxChars: resolveEffectiveChatHistoryMaxChars(cfg) });
		const chatPayload = {
			runId: `inject-${appended.messageId}`,
			sessionKey,
			seq: 0,
			state: "final",
			message
		};
		context.broadcast("chat", chatPayload);
		context.nodeSendToSession(sessionKey, "chat", chatPayload);
		respond(true, {
			ok: true,
			messageId: appended.messageId
		});
	}
};
//#endregion
export { replaceOversizedChatHistoryMessages as a, waitForTerminalGatewayDedupe as c, enforceChatHistoryFinalBudget as i, augmentChatHistoryWithCanvasBlocks as n, readTerminalSnapshotFromGatewayDedupe as o, chatHandlers as r, setGatewayDedupeEntry as s, CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES as t };
