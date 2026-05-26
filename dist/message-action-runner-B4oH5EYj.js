import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { x as basenameFromMediaSource } from "./fs-safe-CV86zY9G.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { r as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-core-BoUoCGOD.js";
import { s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { a as actionHasTarget, o as actionRequiresTarget, r as applyTargetToParams, s as hasPotentialPluginActionParam } from "./channel-target-Nug_hTy8.js";
import { o as resolveSandboxedMediaSource, t as assertMediaNotDataUrl } from "./sandbox-paths-BTYunIeX.js";
import "./local-file-access-CBe_wA_B.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { F as resolveSessionStoreEntry, t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
import "./plugins-DYTHbmt7.js";
import "./sessions-CQHHcgC_.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { t as appendAssistantMessageToSessionTranscript } from "./transcript-BA0Ngd-A.js";
import { u as stripReasoningTagsFromText } from "./assistant-visible-text-BoF6Ixue.js";
import { t as extractToolPayload } from "./tool-payload-Gp3uQTKH.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { a as hasReplyPayloadContent, c as normalizeInteractiveReply, l as normalizeMessagePresentation, n as hasMessagePresentationBlocks, t as hasInteractiveReplyBlocks } from "./payload-BDV15CYA.js";
import { t as basenameFromAnyPath } from "./file-name-r4prf02z.js";
import { a as resolveChannelMessageToolMediaSourceParamKeys } from "./message-action-discovery-C_vRmQ0H.js";
import { b as resolveSnakeCaseParamKey, f as readNumberParam, g as readStringParam, m as readStringArrayParam, y as readSnakeCaseParamRaw } from "./common-E9YpX7pB.js";
import { o as normalizeTargetForProvider } from "./target-id-resolution-DVSHqxJ3.js";
import { d as parseReplyDirectives, u as stripUnsupportedCitationControlMarkers } from "./payloads-BOM5t2O4.js";
import { t as resolveChannelAccountMediaMaxMb } from "./configured-max-bytes-CNKFB65A.js";
import { r as getAgentScopedMediaLocalRoots } from "./local-roots-Pi6a9oaK.js";
import { t as loadWebMedia } from "./web-media-GlH39bZn.js";
import { r as shouldAttemptTtsPayload } from "./tts-config-WOpwhkHq.js";
import { i as throwIfAborted } from "./deliver-WPtVqUMT.js";
import { t as resolveAgentScopedOutboundMediaAccess } from "./read-capability-CUZ0OarG.js";
import { r as resolveOutboundChannelPlugin } from "./channel-resolution-Ecs0HEdK.js";
import { r as resolvePollMaxSelections } from "./polls-C-v11_tu.js";
import { n as resolveMessageChannelSelection, t as listConfiguredMessageChannels } from "./channel-selection-DQG3SYlu.js";
import { n as sendPoll, t as sendMessage } from "./message-CZZW9OgM.js";
import { t as resolveFirstBoundAccountId } from "./bound-account-read-qnHEyAzX.js";
import { n as resolveOutboundMediaAccess, r as resolveOutboundMediaLocalRoots, t as buildOutboundMediaLoadOptions } from "./load-options-LnfEFXDj.js";
import { t as readBooleanParam$1 } from "./boolean-param-Ch5dc2FQ.js";
import { i as resolveChannelTarget, n as lookupDirectoryDisplay, t as formatTargetDisplay } from "./target-resolver-8NiS43Zp.js";
import { n as resolveOutboundSessionRoute, t as ensureOutboundSessionEntry } from "./outbound-session-DKXWYF4a.js";
//#region src/channels/plugins/message-action-dispatch.ts
function requiresTrustedRequesterSender(ctx) {
	const plugin = getChannelPlugin(ctx.channel);
	return Boolean(plugin?.actions?.requiresTrustedRequesterSender?.({
		action: ctx.action,
		toolContext: ctx.toolContext
	}));
}
async function dispatchChannelMessageAction(ctx) {
	if (requiresTrustedRequesterSender(ctx) && !ctx.requesterSenderId?.trim()) throw new Error(`Trusted sender identity is required for ${ctx.channel}:${ctx.action} in tool-driven contexts.`);
	const plugin = getChannelPlugin(ctx.channel);
	if (!plugin?.actions?.handleAction) return null;
	if (plugin.actions.supportsAction && !plugin.actions.supportsAction({ action: ctx.action })) return null;
	return await plugin.actions.handleAction(ctx);
}
//#endregion
//#region src/poll-params.ts
const SHARED_POLL_CREATION_PARAM_DEFS = {
	pollQuestion: { kind: "string" },
	pollOption: { kind: "stringArray" },
	pollDurationHours: { kind: "number" },
	pollMulti: { kind: "boolean" }
};
const POLL_CREATION_PARAM_DEFS = SHARED_POLL_CREATION_PARAM_DEFS;
const SHARED_POLL_CREATION_PARAM_NAMES = Object.keys(SHARED_POLL_CREATION_PARAM_DEFS);
const SHARED_POLL_CREATION_PARAM_KEY_SET = new Set(SHARED_POLL_CREATION_PARAM_NAMES.map(normalizePollParamKey));
const POLL_VOTE_PARAM_KEY_SET = new Set([
	"pollId",
	"pollOptionId",
	"pollOptionIds",
	"pollOptionIndex",
	"pollOptionIndexes"
].map(normalizePollParamKey));
function readPollParamRaw(params, key) {
	return readSnakeCaseParamRaw(params, key);
}
function normalizePollParamKey(key) {
	return normalizeLowercaseStringOrEmpty(key.replaceAll("_", ""));
}
function isChannelPollCreationParamName(key) {
	const normalized = normalizePollParamKey(key);
	return normalized.startsWith("poll") && !SHARED_POLL_CREATION_PARAM_KEY_SET.has(normalized) && !POLL_VOTE_PARAM_KEY_SET.has(normalized);
}
function hasExplicitUnknownPollValue(key, value) {
	if (value === true) return true;
	if (typeof value === "number") return Number.isFinite(value) && value !== 0;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return false;
		if (normalizePollParamKey(key).includes("duration")) {
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) && parsed !== 0;
		}
		const normalized = normalizeLowercaseStringOrEmpty(trimmed);
		return normalized !== "false" && normalized !== "0";
	}
	if (Array.isArray(value)) return value.some((entry) => hasExplicitUnknownPollValue(key, entry));
	return false;
}
function hasPollCreationParams(params) {
	for (const key of SHARED_POLL_CREATION_PARAM_NAMES) {
		const def = POLL_CREATION_PARAM_DEFS[key];
		const value = readPollParamRaw(params, key);
		if (def.kind === "string" && typeof value === "string" && value.trim().length > 0) return true;
		if (def.kind === "stringArray") {
			if (Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim())) return true;
			if (typeof value === "string" && value.trim().length > 0) return true;
		}
		if (def.kind === "number") {
			if (typeof value === "number" && Number.isFinite(value) && value !== 0) return true;
			if (typeof value === "string") {
				const trimmed = value.trim();
				const parsed = Number(trimmed);
				if (trimmed.length > 0 && Number.isFinite(parsed) && parsed !== 0) return true;
			}
		}
		if (def.kind === "boolean") {
			if (value === true) return true;
			if (typeof value === "string" && normalizeLowercaseStringOrEmpty(value) === "true") return true;
		}
	}
	for (const [key, value] of Object.entries(params)) if (isChannelPollCreationParamName(key) && hasExplicitUnknownPollValue(key, value)) return true;
	return false;
}
//#endregion
//#region src/shared/text/formatted-reasoning-message.ts
function stripFormattedReasoningMessage(text) {
	const stripped = stripReasoningTagsFromText(text);
	const lines = stripped.split(/\r?\n/u);
	const prefix = lines[0]?.trim();
	if (prefix !== "Reasoning:" && !/^Thinking\.{0,3}$/u.test(prefix ?? "")) return stripped;
	if (/^Thinking\.{0,3}$/u.test(prefix ?? "")) {
		const trimmedBodyLine = lines.slice(1).find((line) => line.trim())?.trim() ?? "";
		if (!trimmedBodyLine || !(trimmedBodyLine.startsWith("_") && trimmedBodyLine.endsWith("_") && trimmedBodyLine.length >= 2)) return stripped;
	}
	let index = 1;
	while (index < lines.length) {
		const trimmed = lines[index]?.trim() ?? "";
		if (!trimmed || trimmed.startsWith("_") && trimmed.endsWith("_") && trimmed.length >= 2) {
			index += 1;
			continue;
		}
		break;
	}
	return lines.slice(index).join("\n").trim();
}
//#endregion
//#region src/infra/outbound/message-action-normalization.ts
function normalizeMessageActionInput(params) {
	const normalizedArgs = { ...params.args };
	const { action, toolContext } = params;
	const explicitChannel = normalizeOptionalString(normalizedArgs.channel) ?? "";
	const inferredChannel = explicitChannel || normalizeMessageChannel(toolContext?.currentChannelProvider) || "";
	const explicitTarget = normalizeOptionalString(normalizedArgs.target) ?? "";
	const hasLegacyTargetFields = typeof normalizedArgs.to === "string" || typeof normalizedArgs.channelId === "string";
	const hasLegacyTarget = (normalizeOptionalString(normalizedArgs.to) ?? "").length > 0 || (normalizeOptionalString(normalizedArgs.channelId) ?? "").length > 0;
	if (explicitTarget && hasLegacyTargetFields) {
		delete normalizedArgs.to;
		delete normalizedArgs.channelId;
	}
	if (!explicitTarget && !hasLegacyTarget && actionRequiresTarget(action) && !actionHasTarget(action, normalizedArgs, { channel: inferredChannel })) {
		const inferredTarget = normalizeOptionalString(toolContext?.currentChannelId);
		if (inferredTarget) normalizedArgs.target = inferredTarget;
	}
	if (!explicitTarget && actionRequiresTarget(action) && hasLegacyTarget) {
		const legacyTo = normalizeOptionalString(normalizedArgs.to) ?? "";
		const legacyChannelId = normalizeOptionalString(normalizedArgs.channelId) ?? "";
		const legacyTarget = legacyTo || legacyChannelId;
		if (legacyTarget) {
			normalizedArgs.target = legacyTarget;
			delete normalizedArgs.to;
			delete normalizedArgs.channelId;
		}
	}
	if (!explicitChannel) {
		if (inferredChannel && isDeliverableMessageChannel(inferredChannel)) normalizedArgs.channel = inferredChannel;
	}
	applyTargetToParams({
		action,
		args: normalizedArgs
	});
	if (actionRequiresTarget(action) && !actionHasTarget(action, normalizedArgs, { channel: inferredChannel })) throw new Error(`Action ${action} requires a target.`);
	return normalizedArgs;
}
//#endregion
//#region src/infra/outbound/message-action-params.ts
const readBooleanParam = readBooleanParam$1;
const BASE_ACTION_MEDIA_SOURCE_PARAM_KEYS = [
	"media",
	"path",
	"filePath",
	"mediaUrl",
	"fileUrl",
	"image"
];
function readMediaParam(args, key) {
	return readStringParam(args, key, { trim: false });
}
function resolveMediaParamEntry(args, key) {
	const resolvedKey = resolveSnakeCaseParamKey(args, key);
	if (!resolvedKey) return;
	const value = readMediaParam(args, key);
	if (!value) return;
	return {
		key: resolvedKey,
		value
	};
}
function buildActionMediaSourceParamKeys(extraParamKeys) {
	const keys = new Set(BASE_ACTION_MEDIA_SOURCE_PARAM_KEYS);
	extraParamKeys?.forEach((key) => keys.add(key));
	return Array.from(keys);
}
function resolveExtraActionMediaSourceParamKeys(params) {
	if (!hasPotentialPluginActionParam(params.args)) return [];
	return resolveChannelMessageToolMediaSourceParamKeys({
		cfg: params.cfg,
		action: params.action,
		channel: params.channel,
		accountId: params.accountId,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId: params.agentId,
		requesterSenderId: params.requesterSenderId,
		senderIsOwner: params.senderIsOwner
	});
}
function collectActionMediaSourceHints(args, extraParamKeys) {
	const sources = [];
	for (const key of buildActionMediaSourceParamKeys(extraParamKeys)) {
		const entry = resolveMediaParamEntry(args, key);
		if (entry && normalizeOptionalString(entry.value)) sources.push(entry.value);
	}
	return sources;
}
function readAttachmentMediaHint(args) {
	return readMediaParam(args, "media") ?? readMediaParam(args, "mediaUrl");
}
function readAttachmentFileHint(args) {
	return readMediaParam(args, "path") ?? readMediaParam(args, "filePath") ?? readMediaParam(args, "fileUrl");
}
function resolveAttachmentMaxBytes(params) {
	const limitMb = resolveChannelAccountMediaMaxMb(params) ?? params.cfg.agents?.defaults?.mediaMaxMb;
	return typeof limitMb === "number" ? limitMb * 1024 * 1024 : void 0;
}
function inferAttachmentFilename(params) {
	const mediaHint = params.mediaHint?.trim();
	if (mediaHint) {
		const base = basenameFromMediaSource(mediaHint);
		const safeBase = base ? basenameFromAnyPath(base) : void 0;
		if (safeBase) return safeBase;
	}
	const ext = params.contentType ? extensionForMime(params.contentType) : void 0;
	return ext ? `attachment${ext}` : "attachment";
}
function normalizeBase64Payload(params) {
	if (!params.base64) return {
		base64: params.base64,
		contentType: params.contentType
	};
	const match = /^data:([^;]+);base64,(.*)$/i.exec(params.base64.trim());
	if (!match) return {
		base64: params.base64,
		contentType: params.contentType
	};
	const [, mime, payload] = match;
	return {
		base64: payload,
		contentType: params.contentType ?? mime
	};
}
function resolveAttachmentMediaPolicy(params) {
	const sandboxRoot = params.sandboxRoot?.trim();
	if (sandboxRoot) return {
		mode: "sandbox",
		sandboxRoot
	};
	const explicitLocalRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
	return {
		mode: "host",
		mediaAccess: resolveOutboundMediaAccess({
			mediaAccess: params.mediaAccess,
			mediaLocalRoots: explicitLocalRoots === "any" ? void 0 : explicitLocalRoots,
			mediaReadFile: params.mediaAccess?.readFile ? void 0 : params.mediaReadFile
		}),
		...explicitLocalRoots !== void 0 ? { mediaLocalRoots: explicitLocalRoots } : {},
		...params.mediaAccess?.readFile ? {} : params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}
	};
}
function buildAttachmentMediaLoadOptions(params) {
	if (params.policy.mode === "sandbox") {
		const sandboxRoot = params.policy.sandboxRoot.trim();
		let sandboxFsPromise;
		const readSandboxFile = async (filePath) => {
			sandboxFsPromise ??= root(sandboxRoot);
			return await (await sandboxFsPromise).readBytes(filePath);
		};
		return {
			maxBytes: params.maxBytes,
			...params.optimizeImages !== void 0 ? { optimizeImages: params.optimizeImages } : {},
			sandboxValidated: true,
			readFile: readSandboxFile
		};
	}
	return buildOutboundMediaLoadOptions({
		maxBytes: params.maxBytes,
		mediaAccess: params.policy.mediaAccess,
		mediaLocalRoots: params.policy.mediaLocalRoots,
		mediaReadFile: params.policy.mediaReadFile,
		optimizeImages: params.optimizeImages
	});
}
async function hydrateAttachmentPayload(params) {
	const contentTypeParam = params.contentTypeParam ?? void 0;
	const rawBuffer = readStringParam(params.args, "buffer", { trim: false });
	const normalized = normalizeBase64Payload({
		base64: rawBuffer,
		contentType: contentTypeParam ?? void 0
	});
	if (normalized.base64 !== rawBuffer && normalized.base64) {
		params.args.buffer = normalized.base64;
		if (normalized.contentType && !contentTypeParam) params.args.contentType = normalized.contentType;
	}
	const filename = readStringParam(params.args, "filename");
	const mediaSource = (params.mediaHint ?? void 0) || (params.fileHint ?? void 0);
	if (!params.dryRun && !readStringParam(params.args, "buffer", { trim: false }) && mediaSource) {
		const maxBytes = resolveAttachmentMaxBytes({
			cfg: params.cfg,
			channel: params.channel,
			accountId: params.accountId
		});
		const media = await loadWebMedia(mediaSource, buildAttachmentMediaLoadOptions({
			policy: params.mediaPolicy,
			maxBytes,
			optimizeImages: params.optimizeImages
		}));
		params.args.buffer = media.buffer.toString("base64");
		if (!contentTypeParam && media.contentType) params.args.contentType = media.contentType;
		if (!filename) params.args.filename = inferAttachmentFilename({
			mediaHint: media.fileName ?? mediaSource,
			contentType: media.contentType ?? contentTypeParam ?? void 0
		});
	} else if (!filename) params.args.filename = inferAttachmentFilename({
		mediaHint: mediaSource,
		contentType: contentTypeParam ?? void 0
	});
}
async function normalizeSandboxMediaParams(params) {
	const sandboxRoot = params.mediaPolicy.mode === "sandbox" ? params.mediaPolicy.sandboxRoot.trim() : void 0;
	for (const key of buildActionMediaSourceParamKeys(params.extraParamKeys)) {
		const entry = resolveMediaParamEntry(params.args, key);
		if (!entry) continue;
		assertMediaNotDataUrl(entry.value);
		if (!sandboxRoot) continue;
		const normalized = await resolveSandboxedMediaSource({
			media: entry.value,
			sandboxRoot
		});
		if (normalized !== entry.value) params.args[entry.key] = normalized;
	}
}
async function normalizeSandboxMediaList(params) {
	const sandboxRoot = params.sandboxRoot?.trim();
	const normalized = [];
	const seen = /* @__PURE__ */ new Set();
	for (const value of params.values) {
		const raw = value?.trim();
		if (!raw) continue;
		assertMediaNotDataUrl(raw);
		const resolved = sandboxRoot ? await resolveSandboxedMediaSource({
			media: raw,
			sandboxRoot
		}) : raw;
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		normalized.push(resolved);
	}
	return normalized;
}
async function hydrateAttachmentActionPayload(params) {
	const mediaHint = readAttachmentMediaHint(params.args);
	const fileHint = readAttachmentFileHint(params.args);
	const contentTypeParam = readStringParam(params.args, "contentType") ?? readStringParam(params.args, "mimeType");
	if (params.allowMessageCaptionFallback) {
		const caption = readStringParam(params.args, "caption", { allowEmpty: true })?.trim();
		const message = readStringParam(params.args, "message", { allowEmpty: true })?.trim();
		if (!caption && message) params.args.caption = message;
	}
	await hydrateAttachmentPayload({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		args: params.args,
		dryRun: params.dryRun,
		contentTypeParam,
		mediaHint,
		fileHint,
		mediaPolicy: params.mediaPolicy,
		optimizeImages: params.optimizeImages
	});
}
async function hydrateAttachmentParamsForAction(params) {
	const shouldHydrateUploadFile = params.action === "upload-file";
	if (params.action !== "sendAttachment" && params.action !== "setGroupIcon" && params.action !== "reply" && !shouldHydrateUploadFile) return;
	const forceDocument = readBooleanParam$1(params.args, "forceDocument") ?? readBooleanParam$1(params.args, "asDocument") ?? false;
	await hydrateAttachmentActionPayload({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		args: params.args,
		dryRun: params.dryRun,
		mediaPolicy: params.mediaPolicy,
		optimizeImages: shouldHydrateUploadFile && forceDocument ? false : void 0,
		allowMessageCaptionFallback: params.action === "sendAttachment" || shouldHydrateUploadFile
	});
}
function parseJsonMessageParam(params, key) {
	const raw = params[key];
	if (typeof raw !== "string") return;
	const trimmed = raw.trim();
	if (!trimmed) {
		delete params[key];
		return;
	}
	try {
		params[key] = JSON.parse(trimmed);
	} catch {
		throw new Error(`--${key} must be valid JSON`);
	}
}
function parseInteractiveParam(params) {
	const raw = params.interactive;
	if (typeof raw !== "string") return;
	const trimmed = raw.trim();
	if (!trimmed) {
		delete params.interactive;
		return;
	}
	try {
		params.interactive = JSON.parse(trimmed);
	} catch {
		throw new Error("--interactive must be valid JSON");
	}
}
//#endregion
//#region src/infra/outbound/message-action-threading.ts
function suppressesImplicitThreading(actionParams) {
	return actionParams.topLevel === true || actionParams.threadId === null;
}
function resolveAndApplyOutboundThreadId(actionParams, context) {
	const threadId = readStringParam(actionParams, "threadId");
	if (!threadId && suppressesImplicitThreading(actionParams)) return;
	const resolved = threadId ?? context.resolveAutoThreadId?.({
		cfg: context.cfg,
		accountId: context.accountId,
		to: context.to,
		toolContext: context.toolContext,
		replyToId: readStringParam(actionParams, "replyTo")
	});
	if (resolved && !actionParams.threadId) actionParams.threadId = resolved;
	return resolved ?? void 0;
}
function isSameConversationTarget(actionParams, channel, toolContext) {
	const currentChannelId = toolContext?.currentChannelId?.trim();
	if (!currentChannelId) return false;
	const currentChannelProvider = toolContext?.currentChannelProvider?.trim();
	if (currentChannelProvider && currentChannelProvider !== channel) return false;
	const explicitTarget = readStringParam(actionParams, "target") ?? readStringParam(actionParams, "to") ?? readStringParam(actionParams, "channelId");
	if (!explicitTarget) return true;
	return explicitTarget.trim() === currentChannelId;
}
function resolveAndApplyOutboundReplyToId(actionParams, context) {
	const explicitReplyToId = readStringParam(actionParams, "replyTo");
	if (explicitReplyToId) {
		if (context.toolContext?.replyToMode === "first") {
			const hasRepliedRef = context.toolContext.hasRepliedRef;
			if (hasRepliedRef) hasRepliedRef.value = true;
		}
		return explicitReplyToId;
	}
	if (suppressesImplicitThreading(actionParams)) return;
	if (!isSameConversationTarget(actionParams, context.channel, context.toolContext)) return;
	const currentMessageId = context.toolContext?.currentMessageId;
	if (currentMessageId == null) return;
	const mode = context.toolContext?.replyToMode ?? "off";
	if (mode === "off" || mode === "batched") return;
	if (mode === "first") {
		const hasRepliedRef = context.toolContext?.hasRepliedRef;
		if (hasRepliedRef?.value) return;
		if (hasRepliedRef) hasRepliedRef.value = true;
	}
	const resolvedReplyToId = typeof currentMessageId === "number" ? String(currentMessageId) : currentMessageId.trim();
	if (!resolvedReplyToId) return;
	actionParams.replyTo = resolvedReplyToId;
	return resolvedReplyToId;
}
async function prepareOutboundMirrorRoute(params) {
	const replyToId = readStringParam(params.actionParams, "replyTo");
	const resolvedThreadId = resolveAndApplyOutboundThreadId(params.actionParams, {
		cfg: params.cfg,
		to: params.to,
		accountId: params.accountId,
		toolContext: params.toolContext,
		resolveAutoThreadId: params.resolveAutoThreadId
	});
	const outboundRoute = params.agentId && !params.dryRun ? await params.resolveOutboundSessionRoute({
		cfg: params.cfg,
		channel: params.channel,
		agentId: params.agentId,
		accountId: params.accountId,
		target: params.to,
		currentSessionKey: params.currentSessionKey,
		resolvedTarget: params.resolvedTarget,
		replyToId,
		threadId: resolvedThreadId
	}) : null;
	if (outboundRoute && params.agentId && !params.dryRun) await params.ensureOutboundSessionEntry({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		route: outboundRoute
	});
	if (outboundRoute && !params.dryRun) params.actionParams["__sessionKey"] = outboundRoute.sessionKey;
	if (params.agentId) params.actionParams["__agentId"] = params.agentId;
	return {
		resolvedThreadId,
		outboundRoute
	};
}
//#endregion
//#region src/infra/outbound/message-action-tts.ts
let ttsRuntimePromise = null;
function loadMessageActionTtsRuntime() {
	ttsRuntimePromise ??= import("./tts.runtime-hD3depa3.js");
	return ttsRuntimePromise;
}
function resolveMessageActionSessionTtsAuto(params) {
	const sessionKey = params.sessionKey?.trim();
	if (!sessionKey) return;
	try {
		return resolveSessionStoreEntry({
			store: loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: params.agentId })),
			sessionKey
		}).existing?.ttsAuto;
	} catch {
		return;
	}
}
async function maybeApplyTtsToMessageActionSendPayload(params) {
	if (params.dryRun) return params.payload;
	const ttsAuto = resolveMessageActionSessionTtsAuto({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		agentId: params.agentId
	});
	if (!shouldAttemptTtsPayload({
		cfg: params.cfg,
		ttsAuto,
		agentId: params.agentId,
		channelId: params.channel,
		accountId: params.accountId ?? void 0
	})) return params.payload;
	const { maybeApplyTtsToPayload } = await loadMessageActionTtsRuntime();
	return await maybeApplyTtsToPayload({
		payload: params.payload,
		cfg: params.cfg,
		channel: params.channel,
		kind: "final",
		inboundAudio: params.inboundAudio,
		ttsAuto,
		agentId: params.agentId,
		accountId: params.accountId ?? void 0
	});
}
//#endregion
//#region src/infra/outbound/outbound-policy.ts
const CONTEXT_GUARDED_ACTIONS = new Set([
	"send",
	"poll",
	"reply",
	"sendWithEffect",
	"sendAttachment",
	"upload-file",
	"thread-create",
	"thread-reply",
	"sticker"
]);
const CONTEXT_MARKER_ACTIONS = new Set([
	"send",
	"poll",
	"reply",
	"sendWithEffect",
	"sendAttachment",
	"upload-file",
	"thread-reply",
	"sticker"
]);
function resolveContextGuardTarget(action, params) {
	if (!CONTEXT_GUARDED_ACTIONS.has(action)) return;
	if (action === "thread-reply" || action === "thread-create") {
		if (typeof params.channelId === "string") return params.channelId;
		if (typeof params.to === "string") return params.to;
		return;
	}
	if (typeof params.to === "string") return params.to;
	if (typeof params.channelId === "string") return params.channelId;
}
function normalizeTarget(channel, raw) {
	return normalizeTargetForProvider(channel, raw) ?? raw.trim();
}
function isCrossContextTarget(params) {
	const currentTarget = params.toolContext?.currentChannelId?.trim();
	if (!currentTarget) return false;
	const normalizedTarget = normalizeTarget(params.channel, params.target);
	const normalizedCurrent = normalizeTarget(params.channel, currentTarget);
	if (!normalizedTarget || !normalizedCurrent) return false;
	return normalizedTarget !== normalizedCurrent;
}
function resolveAgentMessageToolsConfig(cfg, agentId) {
	const trimmedAgentId = agentId?.trim();
	const globalConfig = cfg.tools?.message;
	if (!trimmedAgentId) return globalConfig;
	const agentConfig = cfg.agents?.list?.find((entry) => entry.id === trimmedAgentId)?.tools?.message;
	if (!agentConfig) return globalConfig;
	return {
		...globalConfig,
		...agentConfig,
		crossContext: globalConfig?.crossContext || agentConfig.crossContext ? {
			...globalConfig?.crossContext,
			...agentConfig.crossContext,
			marker: globalConfig?.crossContext?.marker || agentConfig.crossContext?.marker ? {
				...globalConfig?.crossContext?.marker,
				...agentConfig.crossContext?.marker
			} : void 0
		} : void 0,
		broadcast: globalConfig?.broadcast || agentConfig.broadcast ? {
			...globalConfig?.broadcast,
			...agentConfig.broadcast
		} : void 0,
		actions: globalConfig?.actions || agentConfig.actions ? {
			...globalConfig?.actions,
			...agentConfig.actions
		} : void 0
	};
}
function resolveEffectiveMessageToolsConfig(params) {
	return resolveAgentMessageToolsConfig(params.cfg, params.agentId);
}
function resolveAllowedMessageActions(params) {
	const allow = resolveEffectiveMessageToolsConfig(params)?.actions?.allow;
	if (!allow) return;
	const normalized = allow.map((entry) => entry.trim()).filter(Boolean);
	return normalized.length > 0 ? Array.from(new Set(normalized)) : void 0;
}
function enforceMessageActionAllowlist(params) {
	const allowed = resolveAllowedMessageActions(params);
	if (!allowed || allowed.includes(params.action)) return;
	throw new Error(`Message action "${params.action}" is disabled for this agent.`);
}
function enforceCrossContextPolicy(params) {
	const currentTarget = params.toolContext?.currentChannelId?.trim();
	if (!currentTarget) return;
	if (!CONTEXT_GUARDED_ACTIONS.has(params.action)) return;
	const messageConfig = resolveEffectiveMessageToolsConfig({
		cfg: params.cfg,
		agentId: params.agentId
	});
	if (messageConfig?.allowCrossContextSend) return;
	const currentProvider = params.toolContext?.currentChannelProvider;
	const allowWithinProvider = messageConfig?.crossContext?.allowWithinProvider !== false;
	const allowAcrossProviders = messageConfig?.crossContext?.allowAcrossProviders === true;
	if (currentProvider && currentProvider !== params.channel) {
		if (!allowAcrossProviders) throw new Error(`Cross-context messaging denied: action=${params.action} target provider "${params.channel}" while bound to "${currentProvider}".`);
		return;
	}
	if (allowWithinProvider) return;
	const target = resolveContextGuardTarget(params.action, params.args);
	if (!target) return;
	if (!isCrossContextTarget({
		channel: params.channel,
		target,
		toolContext: params.toolContext
	})) return;
	throw new Error(`Cross-context messaging denied: action=${params.action} target="${target}" while bound to "${currentTarget}" (channel=${params.channel}).`);
}
async function buildCrossContextDecoration(params) {
	if (!params.toolContext?.currentChannelId) return null;
	if (params.toolContext.skipCrossContextDecoration) return null;
	if (!isCrossContextTarget(params)) return null;
	const markerConfig = resolveEffectiveMessageToolsConfig({
		cfg: params.cfg,
		agentId: params.agentId
	})?.crossContext?.marker;
	if (markerConfig?.enabled === false) return null;
	const currentName = await lookupDirectoryDisplay({
		cfg: params.cfg,
		channel: params.channel,
		targetId: params.toolContext.currentChannelId,
		accountId: params.accountId ?? void 0
	}) ?? params.toolContext.currentChannelId;
	const originLabel = formatTargetDisplay({
		channel: params.channel,
		target: params.toolContext.currentChannelId,
		display: currentName
	});
	const prefixTemplate = markerConfig?.prefix ?? "[from {channel}] ";
	const suffixTemplate = markerConfig?.suffix ?? "";
	const prefix = prefixTemplate.replaceAll("{channel}", originLabel);
	const suffix = suffixTemplate.replaceAll("{channel}", originLabel);
	const buildPresentation = getChannelPlugin(params.channel)?.messaging?.buildCrossContextPresentation;
	return {
		prefix,
		suffix,
		presentationBuilder: buildPresentation ? (message) => buildPresentation({
			originLabel,
			message,
			cfg: params.cfg,
			accountId: params.accountId ?? void 0
		}) : void 0
	};
}
function shouldApplyCrossContextMarker(action) {
	return CONTEXT_MARKER_ACTIONS.has(action);
}
function applyCrossContextDecoration(params) {
	if (params.preferPresentation && params.decoration.presentationBuilder) return {
		message: params.message,
		presentation: params.decoration.presentationBuilder?.(params.message),
		usedPresentation: true
	};
	return {
		message: `${params.decoration.prefix}${params.message}${params.decoration.suffix}`,
		usedPresentation: false
	};
}
//#endregion
//#region src/infra/outbound/outbound-send-service.ts
async function sendCoreMessage(params) {
	return await sendMessage({
		cfg: params.ctx.cfg,
		to: params.to,
		content: params.message,
		...params.payloads ? { payloads: params.payloads } : {},
		agentId: params.ctx.agentId,
		requesterSessionKey: params.ctx.sessionKey,
		requesterAccountId: params.ctx.requesterAccountId ?? params.ctx.accountId ?? void 0,
		requesterSenderId: params.ctx.requesterSenderId,
		requesterSenderName: params.ctx.requesterSenderName,
		requesterSenderUsername: params.ctx.requesterSenderUsername,
		requesterSenderE164: params.ctx.requesterSenderE164,
		mediaUrl: params.mediaUrl || void 0,
		mediaUrls: params.mediaUrls,
		asVoice: params.asVoice,
		channel: params.ctx.channel || void 0,
		accountId: params.ctx.accountId ?? void 0,
		replyToId: params.replyToId,
		threadId: params.threadId,
		gifPlayback: params.gifPlayback,
		forceDocument: params.forceDocument,
		dryRun: params.ctx.dryRun,
		bestEffort: params.bestEffort ?? void 0,
		queuePolicy: params.queuePolicy,
		deps: params.ctx.deps,
		gateway: params.ctx.gateway,
		mirror: params.ctx.mirror,
		abortSignal: params.ctx.abortSignal,
		silent: params.ctx.silent,
		mediaAccess: params.ctx.mediaAccess
	});
}
function collectActionMediaSources(params) {
	const sources = [];
	for (const key of [
		"media",
		"mediaUrl",
		"path",
		"filePath",
		"fileUrl"
	]) {
		const value = params[key];
		if (typeof value === "string" && value.trim()) sources.push(value);
	}
	return sources;
}
async function tryHandleWithPluginAction(params) {
	if (params.ctx.dryRun) return null;
	const mediaAccess = resolveAgentScopedOutboundMediaAccess({
		cfg: params.ctx.cfg,
		agentId: params.ctx.agentId ?? params.ctx.mirror?.agentId,
		mediaSources: collectActionMediaSources(params.ctx.params),
		sessionKey: params.ctx.sessionKey,
		messageProvider: params.ctx.sessionKey ? void 0 : params.ctx.channel,
		accountId: (params.ctx.sessionKey ? params.ctx.requesterAccountId ?? params.ctx.accountId : params.ctx.accountId) ?? void 0,
		requesterSenderId: params.ctx.requesterSenderId,
		requesterSenderName: params.ctx.requesterSenderName,
		requesterSenderUsername: params.ctx.requesterSenderUsername,
		requesterSenderE164: params.ctx.requesterSenderE164,
		mediaAccess: params.ctx.mediaAccess,
		mediaReadFile: params.ctx.mediaReadFile
	});
	const handled = await dispatchChannelMessageAction({
		channel: params.ctx.channel,
		action: params.action,
		cfg: params.ctx.cfg,
		params: params.ctx.params,
		mediaAccess,
		mediaLocalRoots: mediaAccess.localRoots,
		mediaReadFile: mediaAccess.readFile,
		accountId: params.ctx.accountId ?? void 0,
		requesterSenderId: params.ctx.requesterSenderId,
		senderIsOwner: params.ctx.senderIsOwner,
		sessionKey: params.ctx.sessionKey,
		sessionId: params.ctx.sessionId,
		inboundEventKind: params.ctx.inboundEventKind,
		agentId: params.ctx.agentId,
		gateway: params.ctx.gateway,
		toolContext: params.ctx.toolContext,
		dryRun: params.ctx.dryRun
	});
	if (!handled) return null;
	await params.onHandled?.();
	return {
		handledBy: "plugin",
		payload: extractToolPayload(handled),
		toolResult: handled
	};
}
function createChannelActionContext(params) {
	const mediaAccess = params.mediaAccess ?? params.ctx.mediaAccess;
	return {
		channel: params.ctx.channel,
		action: params.action,
		cfg: params.ctx.cfg,
		params: params.ctx.params,
		...mediaAccess ? { mediaAccess } : {},
		mediaLocalRoots: mediaAccess?.localRoots ?? params.ctx.mediaAccess?.localRoots,
		mediaReadFile: mediaAccess?.readFile ?? params.ctx.mediaReadFile,
		accountId: params.ctx.accountId ?? void 0,
		requesterSenderId: params.ctx.requesterSenderId,
		senderIsOwner: params.ctx.senderIsOwner,
		sessionKey: params.ctx.sessionKey,
		sessionId: params.ctx.sessionId,
		inboundEventKind: params.ctx.inboundEventKind,
		agentId: params.ctx.agentId,
		gateway: params.ctx.gateway,
		toolContext: params.ctx.toolContext,
		dryRun: params.ctx.dryRun
	};
}
async function tryPreparePluginSendPayload(params) {
	const plugin = resolveOutboundChannelPlugin({
		channel: params.ctx.channel,
		cfg: params.ctx.cfg
	});
	if (!plugin?.outbound) return null;
	const prepareSendPayload = plugin?.actions?.prepareSendPayload;
	if (!prepareSendPayload) return null;
	return await prepareSendPayload({
		ctx: createChannelActionContext({
			ctx: params.ctx,
			action: "send"
		}),
		to: params.to,
		payload: params.payload,
		replyToId: params.replyToId,
		threadId: params.threadId
	}) ?? null;
}
async function executeSendAction(params) {
	throwIfAborted(params.ctx.abortSignal);
	const defaultPayload = params.payload ?? {
		text: params.message,
		mediaUrl: params.mediaUrl,
		mediaUrls: params.mediaUrls,
		audioAsVoice: params.asVoice === true
	};
	const queuePolicy = params.bestEffort === false ? "required" : "best_effort";
	const preparedPayload = await tryPreparePluginSendPayload({
		ctx: params.ctx,
		to: params.to,
		payload: defaultPayload,
		replyToId: params.replyToId,
		threadId: params.threadId
	});
	if (preparedPayload) {
		throwIfAborted(params.ctx.abortSignal);
		const result = await sendCoreMessage({
			...params,
			queuePolicy,
			payloads: [preparedPayload]
		});
		return {
			handledBy: "core",
			payload: result,
			sendResult: result
		};
	}
	const pluginHandled = await tryHandleWithPluginAction({
		ctx: params.ctx,
		action: "send",
		onHandled: async () => {
			if (!params.ctx.mirror) return;
			const mirrorText = params.ctx.mirror.text ?? params.message;
			const mirrorMediaUrls = params.ctx.mirror.mediaUrls ?? params.mediaUrls ?? (params.mediaUrl ? [params.mediaUrl] : void 0);
			await appendAssistantMessageToSessionTranscript({
				agentId: params.ctx.mirror.agentId,
				sessionKey: params.ctx.mirror.sessionKey,
				text: mirrorText,
				mediaUrls: mirrorMediaUrls,
				idempotencyKey: params.ctx.mirror.idempotencyKey,
				config: params.ctx.cfg
			});
		}
	});
	if (pluginHandled) return pluginHandled;
	throwIfAborted(params.ctx.abortSignal);
	const result = await sendCoreMessage({
		...params,
		queuePolicy
	});
	return {
		handledBy: "core",
		payload: result,
		sendResult: result
	};
}
async function executePollAction(params) {
	const pluginHandled = await tryHandleWithPluginAction({
		ctx: params.ctx,
		action: "poll"
	});
	if (pluginHandled) return pluginHandled;
	const corePoll = params.resolveCorePoll();
	const result = await sendPoll({
		cfg: params.ctx.cfg,
		to: corePoll.to,
		question: corePoll.question,
		options: corePoll.options,
		maxSelections: corePoll.maxSelections,
		durationSeconds: corePoll.durationSeconds ?? void 0,
		durationHours: corePoll.durationHours ?? void 0,
		channel: params.ctx.channel,
		accountId: params.ctx.accountId ?? void 0,
		threadId: corePoll.threadId ?? void 0,
		silent: params.ctx.silent ?? void 0,
		isAnonymous: corePoll.isAnonymous ?? void 0,
		dryRun: params.ctx.dryRun,
		gateway: params.ctx.gateway
	});
	return {
		handledBy: "core",
		payload: result,
		pollResult: result
	};
}
//#endregion
//#region src/infra/outbound/message-action-runner.ts
let messageActionGatewayRuntimePromise = null;
function loadMessageActionGatewayRuntime() {
	messageActionGatewayRuntimePromise ??= import("./message.gateway.runtime.js");
	return messageActionGatewayRuntimePromise;
}
function getToolResult(result) {
	return "toolResult" in result ? result.toolResult : void 0;
}
function resolveGatewayActionOptions(gateway) {
	return {
		url: gateway?.mode === GATEWAY_CLIENT_MODES.BACKEND || gateway?.clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT ? void 0 : gateway?.url,
		token: gateway?.token,
		timeoutMs: typeof gateway?.timeoutMs === "number" && Number.isFinite(gateway.timeoutMs) ? Math.max(1, Math.floor(gateway.timeoutMs)) : 1e4,
		clientName: gateway?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
		clientDisplayName: gateway?.clientDisplayName,
		mode: gateway?.mode ?? GATEWAY_CLIENT_MODES.CLI
	};
}
async function callGatewayMessageAction(params) {
	const { callGatewayLeastPrivilege } = await loadMessageActionGatewayRuntime();
	const gateway = resolveGatewayActionOptions(params.gateway);
	return await callGatewayLeastPrivilege({
		url: gateway.url,
		token: gateway.token,
		method: "message.action",
		params: params.actionParams,
		timeoutMs: gateway.timeoutMs,
		clientName: gateway.clientName,
		clientDisplayName: gateway.clientDisplayName,
		mode: gateway.mode
	});
}
async function resolveGatewayActionIdempotencyKey(idempotencyKey) {
	if (idempotencyKey) return idempotencyKey;
	const { randomIdempotencyKey } = await loadMessageActionGatewayRuntime();
	return randomIdempotencyKey();
}
function applyCrossContextMessageDecoration({ params, message, decoration, preferPresentation }) {
	const applied = applyCrossContextDecoration({
		message,
		decoration,
		preferPresentation
	});
	params.message = applied.message;
	if (applied.presentation) {
		const existing = normalizeMessagePresentation(params.presentation);
		params.presentation = existing ? {
			...existing,
			blocks: [...applied.presentation.blocks, ...existing.blocks]
		} : applied.presentation;
	}
	return applied.message;
}
async function maybeApplyCrossContextMarker(params) {
	if (!shouldApplyCrossContextMarker(params.action) || !params.toolContext) return params.message;
	const decoration = await buildCrossContextDecoration({
		cfg: params.cfg,
		channel: params.channel,
		target: params.target,
		toolContext: params.toolContext,
		accountId: params.accountId ?? void 0,
		agentId: params.agentId ?? void 0
	});
	if (!decoration) return params.message;
	return applyCrossContextMessageDecoration({
		params: params.args,
		message: params.message,
		decoration,
		preferPresentation: params.preferPresentation
	});
}
async function resolveChannel(cfg, params, toolContext) {
	const selection = await resolveMessageChannelSelection({
		cfg,
		channel: readStringParam(params, "channel"),
		fallbackChannel: toolContext?.currentChannelProvider
	});
	if (selection.source === "tool-context-fallback") params.channel = selection.channel;
	return selection.channel;
}
function addCandidateAndUnprefixedAlias(candidates, value) {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return;
	candidates.add(normalized);
	const unprefixed = normalized.replace(/^(channel|group|user):/i, "").trim();
	if (unprefixed && unprefixed !== normalized) candidates.add(unprefixed);
}
function normalizeTargetForAccountBinding(channel, target) {
	try {
		return normalizeTargetForProvider(channel, target);
	} catch {
		return;
	}
}
function inferPeerKindForAccountBinding(channel, target) {
	const inferred = normalizeChatType(getChannelPlugin(channel)?.messaging?.inferTargetChatType?.({ to: target }));
	if (inferred) return inferred;
	const candidates = [target, normalizeTargetForAccountBinding(channel, target)].filter((value) => Boolean(value));
	if (candidates.some((value) => /^user:/i.test(value))) return "direct";
	if (candidates.some((value) => /^(channel|group):/i.test(value))) return "channel";
}
function resolveTargetBoundAccountId(params) {
	if (!params.agentId) return;
	const target = normalizeOptionalString(params.args.to) ?? normalizeOptionalString(params.args.channelId) ?? "";
	if (!target) return resolveFirstBoundAccountId({
		cfg: params.cfg,
		channelId: params.channel,
		agentId: params.agentId
	});
	const candidates = /* @__PURE__ */ new Set();
	addCandidateAndUnprefixedAlias(candidates, target);
	addCandidateAndUnprefixedAlias(candidates, normalizeTargetForAccountBinding(params.channel, target));
	const [peerId, ...exactPeerIdAliases] = Array.from(candidates);
	return resolveFirstBoundAccountId({
		cfg: params.cfg,
		channelId: params.channel,
		agentId: params.agentId,
		peerId,
		exactPeerIdAliases,
		peerKind: inferPeerKindForAccountBinding(params.channel, target)
	});
}
async function resolveActionTarget(params) {
	let resolvedTarget;
	const toRaw = normalizeOptionalString(params.args.to) ?? "";
	if (toRaw) {
		const resolved = await resolveResolvedTargetOrThrow({
			cfg: params.cfg,
			channel: params.channel,
			input: toRaw,
			accountId: params.accountId ?? void 0
		});
		params.args.to = resolved.to;
		resolvedTarget = resolved;
	}
	const channelIdRaw = normalizeOptionalString(params.args.channelId) ?? "";
	if (channelIdRaw) {
		const resolved = await resolveResolvedTargetOrThrow({
			cfg: params.cfg,
			channel: params.channel,
			input: channelIdRaw,
			accountId: params.accountId ?? void 0,
			preferredKind: "group",
			validateResolvedTarget: (target) => target.kind === "user" ? `Channel id "${channelIdRaw}" resolved to a user target.` : void 0
		});
		params.args.channelId = sanitizeGroupTargetId(resolved.to);
	}
	return resolvedTarget;
}
function sanitizeGroupTargetId(target) {
	return target.replace(/^(channel|group):/i, "");
}
async function resolveResolvedTargetOrThrow(params) {
	const resolved = await resolveChannelTarget({
		cfg: params.cfg,
		channel: params.channel,
		input: params.input,
		accountId: params.accountId,
		preferredKind: params.preferredKind
	});
	if (!resolved.ok) throw resolved.error;
	const validationError = params.validateResolvedTarget?.(resolved.target);
	if (validationError) throw new Error(validationError);
	return resolved.target;
}
function updateSendPayloadPartsFromReplyPayload(parts, payload) {
	const sendable = resolveSendableOutboundReplyParts(payload);
	const mediaUrls = sendable.mediaUrls.length > 0 ? sendable.mediaUrls : void 0;
	return {
		...parts,
		message: payload.text ?? "",
		payload,
		mediaUrl: mediaUrls?.[0],
		mediaUrls,
		asVoice: payload.audioAsVoice === true
	};
}
function applySendPayloadPartsToActionParams(actionParams, parts) {
	actionParams.message = parts.message;
	actionParams.media = parts.mediaUrl;
	actionParams.mediaUrl = parts.mediaUrl;
	actionParams.mediaUrls = parts.mediaUrls;
	actionParams.asVoice = parts.asVoice || void 0;
	actionParams.audioAsVoice = parts.asVoice || void 0;
}
function collectMessageAttachmentMediaHints(value) {
	if (!Array.isArray(value)) return [];
	const mediaUrls = [];
	const seen = /* @__PURE__ */ new Set();
	const pushMedia = (entry) => {
		const normalized = normalizeOptionalString(entry);
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		mediaUrls.push(normalized);
	};
	for (const attachment of value) {
		if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) continue;
		const record = attachment;
		pushMedia(record.media);
		pushMedia(record.mediaUrl);
		pushMedia(record.path);
		pushMedia(record.filePath);
		pushMedia(record.fileUrl);
		pushMedia(record.url);
	}
	return mediaUrls;
}
function hasExplicitRouteParam(params) {
	for (const key of [
		"channel",
		"target",
		"to",
		"channelId"
	]) if (normalizeOptionalString(params[key])) return true;
	return Array.isArray(params.targets) && params.targets.some((value) => normalizeOptionalString(value));
}
function shouldUseInternalSourceReplySink(input, params) {
	return input.action === "send" && input.sourceReplyDeliveryMode === "message_tool_only" && normalizeOptionalLowercaseString(input.toolContext?.currentChannelProvider) === "webchat" && Boolean(input.sessionKey?.trim()) && !hasExplicitRouteParam(params);
}
async function runGatewayPluginMessageActionOrNull(params) {
	if (params.dryRun || !params.gateway) return null;
	const plugin = resolveOutboundChannelPlugin({
		channel: params.channel,
		cfg: params.cfg
	});
	if (!plugin?.actions?.handleAction) return null;
	if ((plugin.actions.resolveExecutionMode?.({ action: params.action }) ?? "local") !== "gateway") return null;
	const payload = await callGatewayMessageAction({
		gateway: params.gateway,
		actionParams: {
			channel: params.channel,
			action: params.action,
			params: params.params,
			accountId: params.accountId ?? void 0,
			requesterSenderId: params.input.requesterSenderId ?? void 0,
			senderIsOwner: params.input.senderIsOwner,
			sessionKey: params.input.sessionKey,
			sessionId: params.input.sessionId,
			inboundTurnKind: params.input.inboundEventKind,
			agentId: params.agentId,
			toolContext: params.input.toolContext,
			idempotencyKey: await resolveGatewayActionIdempotencyKey(normalizeOptionalString(params.params.idempotencyKey))
		}
	});
	return params.result(payload);
}
function resolveGateway(input) {
	if (!input.gateway) return;
	return {
		url: input.gateway.url,
		token: input.gateway.token,
		timeoutMs: input.gateway.timeoutMs,
		clientName: input.gateway.clientName,
		clientDisplayName: input.gateway.clientDisplayName,
		mode: input.gateway.mode
	};
}
async function handleBroadcastAction(input, params) {
	throwIfAborted(input.abortSignal);
	if (!(resolveEffectiveMessageToolsConfig({
		cfg: input.cfg,
		agentId: input.agentId
	})?.broadcast?.enabled !== false)) throw new Error("Broadcast is disabled. Set tools.message.broadcast.enabled to true.");
	const rawTargets = readStringArrayParam(params, "targets", { required: true });
	if (rawTargets.length === 0) throw new Error("Broadcast requires at least one target in --targets.");
	const channelHint = readStringParam(params, "channel");
	const targetChannels = channelHint && normalizeOptionalLowercaseString(channelHint) !== "all" ? [await resolveChannel(input.cfg, { channel: channelHint }, input.toolContext)] : await (async () => {
		const configured = await listConfiguredMessageChannels(input.cfg);
		if (configured.length === 0) throw new Error("Broadcast requires at least one configured channel.");
		return configured;
	})();
	const results = [];
	const isAbortError = (err) => err instanceof Error && err.name === "AbortError";
	for (const targetChannel of targetChannels) {
		throwIfAborted(input.abortSignal);
		for (const target of rawTargets) {
			throwIfAborted(input.abortSignal);
			try {
				const resolved = await resolveResolvedTargetOrThrow({
					cfg: input.cfg,
					channel: targetChannel,
					input: target
				});
				const sendResult = await runMessageAction({
					...input,
					action: "send",
					params: {
						...params,
						channel: targetChannel,
						target: resolved.to
					}
				});
				results.push({
					channel: targetChannel,
					to: resolved.to,
					ok: true,
					result: sendResult.kind === "send" ? sendResult.sendResult : void 0
				});
			} catch (err) {
				if (isAbortError(err)) throw err;
				results.push({
					channel: targetChannel,
					to: target,
					ok: false,
					error: formatErrorMessage(err)
				});
			}
		}
	}
	return {
		kind: "broadcast",
		channel: targetChannels[0] ?? normalizeOptionalLowercaseString(channelHint) ?? "unknown",
		action: "broadcast",
		handledBy: input.dryRun ? "dry-run" : "core",
		payload: { results },
		dryRun: Boolean(input.dryRun)
	};
}
async function handleInternalSourceReplySendAction(input, params) {
	throwIfAborted(input.abortSignal);
	const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
	const sourceReply = await buildSendPayloadParts({
		cfg: input.cfg,
		actionParams: params,
		input,
		agentId: input.agentId ?? (input.sessionKey ? resolveSessionAgentId({
			sessionKey: input.sessionKey,
			config: input.cfg
		}) : void 0)
	});
	return {
		kind: "send",
		channel: INTERNAL_MESSAGE_CHANNEL,
		action: "send",
		to: "current-run",
		handledBy: "internal-source",
		payload: {
			status: "ok",
			deliveryStatus: dryRun ? "dry_run" : "sent",
			channel: INTERNAL_MESSAGE_CHANNEL,
			target: "current-run",
			sourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
			...dryRun ? {} : { sourceReplySink: "internal-ui" },
			sourceReply: sourceReply.payload,
			...sourceReply.message ? { message: sourceReply.message } : {},
			...sourceReply.mediaUrl ? { mediaUrl: sourceReply.mediaUrl } : {},
			...sourceReply.mediaUrls?.length ? { mediaUrls: sourceReply.mediaUrls } : {},
			dryRun
		},
		dryRun
	};
}
async function buildSendPayloadParts(params) {
	const { actionParams, input } = params;
	if (actionParams.pin === true && actionParams.delivery == null) actionParams.delivery = { pin: { enabled: true } };
	if (typeof actionParams.message !== "string" || !actionParams.message.trim()) for (const alias of [
		"SendMessage",
		"content",
		"text"
	]) {
		const value = actionParams[alias];
		if (typeof value === "string" && value.trim()) {
			actionParams.message = stripFormattedReasoningMessage(value);
			console.warn(`[message-tool] normalized alias "${alias}" to "message" for send action`);
			break;
		}
	}
	const mediaHint = readStringParam(actionParams, "media", { trim: false }) ?? readStringParam(actionParams, "mediaUrl", { trim: false }) ?? readStringParam(actionParams, "path", { trim: false }) ?? readStringParam(actionParams, "filePath", { trim: false }) ?? readStringParam(actionParams, "fileUrl", { trim: false });
	const attachmentMediaHints = collectMessageAttachmentMediaHints(actionParams.attachments);
	const hasMediaHint = Boolean(mediaHint) || attachmentMediaHints.length > 0;
	const hasPresentation = hasMessagePresentationBlocks(actionParams.presentation);
	const hasInteractive = hasInteractiveReplyBlocks(actionParams.interactive);
	const caption = readStringParam(actionParams, "caption", { allowEmpty: true }) ?? "";
	let message = readStringParam(actionParams, "message", {
		required: !hasMediaHint && !hasPresentation && !hasInteractive,
		allowEmpty: true
	}) ?? "";
	if (message.includes("\\n")) message = message.replaceAll("\\n", "\n");
	if (!message.trim() && caption.trim()) message = caption;
	const parsed = parseReplyDirectives(message);
	const mergedMediaUrls = [];
	const seenMedia = /* @__PURE__ */ new Set();
	const pushMedia = (value) => {
		const trimmed = normalizeOptionalString(value);
		if (!trimmed || seenMedia.has(trimmed)) return;
		seenMedia.add(trimmed);
		mergedMediaUrls.push(trimmed);
	};
	pushMedia(mediaHint);
	for (const attachmentMediaHint of attachmentMediaHints) pushMedia(attachmentMediaHint);
	for (const url of parsed.mediaUrls ?? []) pushMedia(url);
	pushMedia(parsed.mediaUrl);
	const normalizedMediaUrls = await normalizeSandboxMediaList({
		values: mergedMediaUrls,
		sandboxRoot: input.sandboxRoot
	});
	mergedMediaUrls.length = 0;
	mergedMediaUrls.push(...normalizedMediaUrls);
	message = stripUnsupportedCitationControlMarkers(parsed.text);
	actionParams.message = message;
	if (!actionParams.replyTo && parsed.replyToId) actionParams.replyTo = parsed.replyToId;
	if (!actionParams.media) actionParams.media = mergedMediaUrls[0] || void 0;
	if (params.channel && params.target) message = await maybeApplyCrossContextMarker({
		cfg: params.cfg,
		channel: params.channel,
		action: "send",
		target: params.target,
		toolContext: input.toolContext,
		accountId: params.accountId,
		agentId: params.agentId,
		args: actionParams,
		message,
		preferPresentation: true
	});
	const mediaUrl = readStringParam(actionParams, "media", { trim: false });
	if (!hasReplyPayloadContent({
		text: message,
		mediaUrl,
		mediaUrls: mergedMediaUrls,
		presentation: actionParams.presentation,
		interactive: actionParams.interactive
	})) throw new Error("send requires text or media");
	actionParams.message = message;
	const gifPlayback = readBooleanParam(actionParams, "gifPlayback") ?? false;
	const forceDocument = readBooleanParam(actionParams, "forceDocument") ?? readBooleanParam(actionParams, "asDocument") ?? false;
	const asVoice = readBooleanParam(actionParams, "asVoice") ?? readBooleanParam(actionParams, "audioAsVoice") ?? parsed.audioAsVoice ?? false;
	const bestEffort = readBooleanParam(actionParams, "bestEffort");
	const silent = readBooleanParam(actionParams, "silent");
	const mirrorMediaUrls = mergedMediaUrls.length > 0 ? mergedMediaUrls : mediaUrl ? [mediaUrl] : void 0;
	const rawDelivery = actionParams.delivery;
	const delivery = rawDelivery && typeof rawDelivery === "object" && !Array.isArray(rawDelivery) ? rawDelivery : void 0;
	const rawChannelData = actionParams.channelData;
	const channelData = rawChannelData && typeof rawChannelData === "object" && !Array.isArray(rawChannelData) ? rawChannelData : void 0;
	const presentation = normalizeMessagePresentation(actionParams.presentation);
	const interactive = normalizeInteractiveReply(actionParams.interactive);
	return {
		message,
		payload: {
			text: message,
			...mediaUrl ? { mediaUrl } : {},
			...mergedMediaUrls.length ? { mediaUrls: mergedMediaUrls } : {},
			...asVoice ? { audioAsVoice: true } : {},
			...presentation ? { presentation } : {},
			...interactive ? { interactive } : {},
			...delivery ? { delivery } : {},
			...channelData ? { channelData } : {}
		},
		...mediaUrl ? { mediaUrl } : {},
		...mirrorMediaUrls ? { mediaUrls: mirrorMediaUrls } : {},
		asVoice,
		gifPlayback,
		forceDocument,
		...bestEffort !== void 0 ? { bestEffort } : {},
		...silent !== void 0 ? { silent } : {}
	};
}
async function handleSendAction(ctx) {
	const { cfg, params, channel, accountId, dryRun, gateway, input, agentId, resolvedTarget, abortSignal } = ctx;
	throwIfAborted(abortSignal);
	const action = "send";
	const to = readStringParam(params, "to", { required: true });
	let sendPayload = await buildSendPayloadParts({
		cfg,
		actionParams: params,
		input,
		channel,
		target: to,
		accountId,
		agentId
	});
	const replyToId = resolveAndApplyOutboundReplyToId(params, {
		channel,
		toolContext: input.toolContext
	});
	const { resolvedThreadId, outboundRoute } = await prepareOutboundMirrorRoute({
		cfg,
		channel,
		to,
		actionParams: params,
		accountId,
		toolContext: input.toolContext,
		agentId,
		currentSessionKey: input.sessionKey,
		dryRun,
		resolvedTarget,
		resolveAutoThreadId: getChannelPlugin(channel)?.threading?.resolveAutoThreadId,
		resolveOutboundSessionRoute,
		ensureOutboundSessionEntry
	});
	throwIfAborted(abortSignal);
	const ttsPayload = await maybeApplyTtsToMessageActionSendPayload({
		payload: sendPayload.payload,
		cfg,
		channel,
		accountId,
		agentId,
		sessionKey: input.sessionKey,
		dryRun
	});
	if (ttsPayload !== sendPayload.payload) {
		sendPayload = updateSendPayloadPartsFromReplyPayload(sendPayload, ttsPayload);
		applySendPayloadPartsToActionParams(params, sendPayload);
	}
	throwIfAborted(abortSignal);
	const gatewayPluginAction = await runGatewayPluginMessageActionOrNull({
		cfg,
		params,
		channel,
		action,
		accountId,
		dryRun,
		gateway,
		input,
		agentId,
		result: (payload) => ({
			kind: "send",
			channel,
			action,
			to,
			handledBy: "plugin",
			payload,
			dryRun
		})
	});
	if (gatewayPluginAction) return gatewayPluginAction;
	const send = await executeSendAction({
		ctx: {
			cfg,
			channel,
			params,
			agentId,
			sessionKey: input.sessionKey,
			requesterAccountId: input.requesterAccountId ?? void 0,
			requesterSenderId: input.requesterSenderId ?? void 0,
			requesterSenderName: input.requesterSenderName ?? void 0,
			requesterSenderUsername: input.requesterSenderUsername ?? void 0,
			requesterSenderE164: input.requesterSenderE164 ?? void 0,
			senderIsOwner: input.senderIsOwner,
			mediaAccess: ctx.mediaAccess,
			accountId: accountId ?? void 0,
			sessionId: input.sessionId,
			inboundEventKind: input.inboundEventKind,
			gateway,
			toolContext: input.toolContext,
			deps: input.deps,
			dryRun,
			mirror: outboundRoute && !dryRun ? {
				sessionKey: outboundRoute.sessionKey,
				agentId,
				text: sendPayload.message,
				mediaUrls: sendPayload.mediaUrls,
				idempotencyKey: normalizeOptionalString(params.idempotencyKey) ?? void 0
			} : void 0,
			abortSignal,
			silent: sendPayload.silent ?? void 0
		},
		to,
		message: sendPayload.message,
		payload: sendPayload.payload,
		mediaUrl: sendPayload.mediaUrl,
		mediaUrls: sendPayload.mediaUrls,
		asVoice: sendPayload.asVoice,
		gifPlayback: sendPayload.gifPlayback,
		forceDocument: sendPayload.forceDocument,
		bestEffort: sendPayload.bestEffort,
		replyToId: replyToId ?? void 0,
		threadId: resolvedThreadId ?? void 0
	});
	return {
		kind: "send",
		channel,
		action,
		to,
		handledBy: send.handledBy,
		payload: send.payload,
		toolResult: send.toolResult,
		sendResult: send.sendResult,
		dryRun
	};
}
async function handlePollAction(ctx) {
	const { cfg, params, channel, accountId, dryRun, gateway, input, agentId, abortSignal } = ctx;
	throwIfAborted(abortSignal);
	const action = "poll";
	const to = readStringParam(params, "to", { required: true });
	const silent = readBooleanParam(params, "silent");
	const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
		cfg,
		to,
		accountId,
		toolContext: input.toolContext,
		resolveAutoThreadId: getChannelPlugin(channel)?.threading?.resolveAutoThreadId
	});
	const base = typeof params.message === "string" ? params.message : "";
	await maybeApplyCrossContextMarker({
		cfg,
		channel,
		action,
		target: to,
		toolContext: input.toolContext,
		accountId,
		agentId,
		args: params,
		message: base,
		preferPresentation: false
	});
	const gatewayPluginAction = await runGatewayPluginMessageActionOrNull({
		cfg,
		params,
		channel,
		action,
		accountId,
		dryRun,
		gateway,
		input,
		agentId,
		result: (payload) => ({
			kind: "poll",
			channel,
			action,
			to,
			handledBy: "plugin",
			payload,
			dryRun
		})
	});
	if (gatewayPluginAction) return gatewayPluginAction;
	const poll = await executePollAction({
		ctx: {
			cfg,
			channel,
			params,
			accountId: accountId ?? void 0,
			agentId,
			requesterSenderId: input.requesterSenderId ?? void 0,
			sessionKey: input.sessionKey,
			sessionId: input.sessionId,
			inboundEventKind: input.inboundEventKind,
			gateway,
			toolContext: input.toolContext,
			dryRun,
			silent: silent ?? void 0
		},
		resolveCorePoll: () => {
			const question = readStringParam(params, "pollQuestion", { required: true });
			const options = readStringArrayParam(params, "pollOption", { required: true });
			if (options.length < 2) throw new Error("pollOption requires at least two values");
			const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
			const durationHours = readNumberParam(params, "pollDurationHours", {
				integer: true,
				strict: true
			});
			return {
				to,
				question,
				options,
				maxSelections: resolvePollMaxSelections(options.length, allowMultiselect),
				durationHours: durationHours ?? void 0,
				threadId: resolvedThreadId ?? void 0
			};
		}
	});
	return {
		kind: "poll",
		channel,
		action,
		to,
		handledBy: poll.handledBy,
		payload: poll.payload,
		toolResult: poll.toolResult,
		pollResult: poll.pollResult,
		dryRun
	};
}
async function handlePluginAction(ctx) {
	const { cfg, params, channel, mediaAccess, accountId, dryRun, gateway, input, abortSignal, agentId } = ctx;
	throwIfAborted(abortSignal);
	const action = input.action;
	if (dryRun) return {
		kind: "action",
		channel,
		action,
		handledBy: "dry-run",
		payload: {
			ok: true,
			dryRun: true,
			channel,
			action
		},
		dryRun: true
	};
	if (!resolveOutboundChannelPlugin({
		channel,
		cfg
	})?.actions?.handleAction) throw new Error(`Channel ${channel} is unavailable for message actions (plugin not loaded).`);
	const gatewayPluginAction = await runGatewayPluginMessageActionOrNull({
		cfg,
		params,
		channel,
		action,
		accountId,
		dryRun,
		gateway,
		input,
		agentId,
		result: (payload) => ({
			kind: "action",
			channel,
			action,
			handledBy: "plugin",
			payload,
			dryRun
		})
	});
	if (gatewayPluginAction) return gatewayPluginAction;
	const handled = await dispatchChannelMessageAction({
		channel,
		action,
		cfg,
		params,
		mediaAccess,
		mediaLocalRoots: mediaAccess.localRoots,
		mediaReadFile: mediaAccess.readFile,
		accountId: accountId ?? void 0,
		requesterSenderId: input.requesterSenderId ?? void 0,
		senderIsOwner: input.senderIsOwner,
		sessionKey: input.sessionKey,
		sessionId: input.sessionId,
		inboundEventKind: input.inboundEventKind,
		agentId,
		gateway,
		toolContext: input.toolContext,
		dryRun
	});
	if (!handled) throw new Error(`Message action ${action} not supported for channel ${channel}.`);
	return {
		kind: "action",
		channel,
		action,
		handledBy: "plugin",
		payload: extractToolPayload(handled),
		toolResult: handled,
		dryRun
	};
}
async function runMessageAction(input) {
	const cfg = input.cfg;
	let params = { ...input.params };
	const resolvedAgentId = input.agentId ?? (input.sessionKey ? resolveSessionAgentId({
		sessionKey: input.sessionKey,
		config: cfg
	}) : void 0);
	parseJsonMessageParam(params, "presentation");
	parseJsonMessageParam(params, "delivery");
	parseInteractiveParam(params);
	const action = input.action;
	enforceMessageActionAllowlist({
		cfg,
		agentId: resolvedAgentId,
		action
	});
	if (action === "broadcast") return handleBroadcastAction(input, params);
	if (action === "send" && hasPollCreationParams(params)) throw new Error("Poll fields require action \"poll\"; use action \"poll\" instead of \"send\".");
	if (shouldUseInternalSourceReplySink(input, params)) return handleInternalSourceReplySendAction({
		...input,
		agentId: resolvedAgentId
	}, params);
	params = normalizeMessageActionInput({
		action,
		args: params,
		toolContext: input.toolContext
	});
	const channel = await resolveChannel(cfg, params, input.toolContext);
	let accountId = readStringParam(params, "accountId") ?? input.defaultAccountId;
	if (!accountId && resolvedAgentId) accountId = resolveTargetBoundAccountId({
		cfg,
		channel,
		args: params,
		agentId: resolvedAgentId
	});
	if (accountId) params.accountId = accountId;
	const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
	const normalizationPolicy = resolveAttachmentMediaPolicy({
		sandboxRoot: input.sandboxRoot,
		mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, resolvedAgentId)
	});
	const extraActionMediaSourceParamKeys = resolveExtraActionMediaSourceParamKeys({
		cfg,
		action,
		args: params,
		channel,
		accountId,
		sessionKey: input.sessionKey,
		sessionId: input.sessionId,
		agentId: resolvedAgentId,
		requesterSenderId: input.requesterSenderId,
		senderIsOwner: input.senderIsOwner
	});
	await normalizeSandboxMediaParams({
		args: params,
		mediaPolicy: normalizationPolicy,
		extraParamKeys: extraActionMediaSourceParamKeys
	});
	const mediaAccess = resolveAgentScopedOutboundMediaAccess({
		cfg,
		agentId: resolvedAgentId,
		mediaSources: collectActionMediaSourceHints(params, extraActionMediaSourceParamKeys),
		sessionKey: input.sessionKey,
		messageProvider: input.sessionKey ? void 0 : channel,
		accountId: input.sessionKey ? input.requesterAccountId ?? accountId : accountId,
		requesterSenderId: input.requesterSenderId,
		requesterSenderName: input.requesterSenderName,
		requesterSenderUsername: input.requesterSenderUsername,
		requesterSenderE164: input.requesterSenderE164
	});
	const mediaPolicy = resolveAttachmentMediaPolicy({
		sandboxRoot: input.sandboxRoot,
		mediaAccess
	});
	await hydrateAttachmentParamsForAction({
		cfg,
		channel,
		accountId,
		args: params,
		action,
		dryRun,
		mediaPolicy
	});
	const resolvedTarget = await resolveActionTarget({
		cfg,
		channel,
		action,
		args: params,
		accountId
	});
	enforceCrossContextPolicy({
		channel,
		action,
		args: params,
		toolContext: input.toolContext,
		cfg,
		agentId: resolvedAgentId
	});
	const gateway = resolveGateway(input);
	if (action === "send") return handleSendAction({
		cfg,
		params,
		channel,
		mediaAccess,
		accountId,
		dryRun,
		gateway,
		input,
		agentId: resolvedAgentId,
		resolvedTarget,
		abortSignal: input.abortSignal
	});
	if (action === "poll") return handlePollAction({
		cfg,
		params,
		channel,
		mediaAccess,
		accountId,
		dryRun,
		gateway,
		input,
		abortSignal: input.abortSignal
	});
	return handlePluginAction({
		cfg,
		params,
		channel,
		mediaAccess,
		accountId,
		dryRun,
		gateway,
		input,
		agentId: resolvedAgentId,
		abortSignal: input.abortSignal
	});
}
//#endregion
export { POLL_CREATION_PARAM_DEFS as a, stripFormattedReasoningMessage as i, runMessageAction as n, SHARED_POLL_CREATION_PARAM_NAMES as o, resolveAllowedMessageActions as r, dispatchChannelMessageAction as s, getToolResult as t };
