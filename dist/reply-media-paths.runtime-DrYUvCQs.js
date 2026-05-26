import { p as resolveSessionAgentId } from "./agent-scope-C1Fl7gAf.js";
import { r as logVerbose } from "./globals-CouSpJO4.js";
import { o as resolveSandboxedMediaSource, r as resolveAllowedManagedMediaPath, t as assertMediaNotDataUrl } from "./sandbox-paths-BOOkw4YG.js";
import { t as isPassThroughRemoteMediaSource } from "./media-source-url-CdJEUGM2.js";
import { a as toRelativeWorkspacePath, r as resolvePathFromInput } from "./workspace-dir-DPcc1MHX.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-BOrd8HRU.js";
import { t as resolveChannelAccountMediaMaxMb } from "./configured-max-bytes-DDkiBYMh.js";
import { t as MEDIA_MAX_BYTES } from "./store-b792nN7l.js";
import { t as resolveAgentScopedOutboundMediaAccess } from "./read-capability-BF1olyJZ.js";
import { a as ensureSandboxWorkspaceForSession } from "./sandbox-DIHI_0fY.js";
import { t as resolveOutboundAttachmentFromUrl } from "./outbound-attachment-kr1-eQfF.js";
import path from "node:path";
//#region src/auto-reply/reply/reply-media-paths.ts
const FILE_URL_RE = /^file:\/\//i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT_RE = /\.\w{1,10}$/;
function isLikelyLocalMediaSource(media) {
	return FILE_URL_RE.test(media) || media.startsWith("/") || media.startsWith("./") || media.startsWith("../") || media.startsWith("~") || WINDOWS_DRIVE_RE.test(media) || media.startsWith("\\\\") || !SCHEME_RE.test(media) && (media.includes("/") || media.includes("\\") || HAS_FILE_EXT_RE.test(media));
}
function getPayloadMediaList(payload) {
	return resolveSendableOutboundReplyParts(payload).mediaUrls;
}
function resolveReplyMediaMaxBytes(params) {
	const limitMb = resolveChannelAccountMediaMaxMb(params) ?? params.cfg.agents?.defaults?.mediaMaxMb;
	return typeof limitMb === "number" && Number.isFinite(limitMb) && limitMb > 0 ? Math.floor(limitMb * 1024 * 1024) : MEDIA_MAX_BYTES;
}
function formatBlockedReplyMediaWarning() {
	return "⚠️ Media failed.";
}
function createReplyMediaPathNormalizer(params) {
	const agentId = params.agentId ?? (params.sessionKey ? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	}) : void 0);
	const maxBytes = resolveReplyMediaMaxBytes({
		cfg: params.cfg,
		channel: params.messageProvider,
		accountId: params.accountId
	});
	let sandboxRootPromise;
	const persistedMediaBySource = /* @__PURE__ */ new Map();
	const resolveSandboxRoot = async () => {
		if (!sandboxRootPromise) sandboxRootPromise = ensureSandboxWorkspaceForSession({
			config: params.cfg,
			sessionKey: params.sessionKey,
			workspaceDir: params.workspaceDir
		}).then((sandbox) => sandbox?.workspaceDir);
		return await sandboxRootPromise;
	};
	const resolveMediaAccessForSource = (media) => resolveAgentScopedOutboundMediaAccess({
		cfg: params.cfg,
		agentId,
		workspaceDir: params.workspaceDir,
		mediaSources: [media],
		sessionKey: params.sessionKey,
		messageProvider: params.sessionKey ? void 0 : params.messageProvider,
		accountId: params.accountId,
		requesterSenderId: params.requesterSenderId,
		requesterSenderName: params.requesterSenderName,
		requesterSenderUsername: params.requesterSenderUsername,
		requesterSenderE164: params.requesterSenderE164,
		groupId: params.groupId,
		groupChannel: params.groupChannel,
		groupSpace: params.groupSpace
	});
	const persistLocalReplyMedia = async (media) => {
		if (!isLikelyLocalMediaSource(media)) return media;
		const managedMediaPath = await resolveAllowedManagedMediaPath(media);
		if (managedMediaPath) return managedMediaPath;
		const cached = persistedMediaBySource.get(media);
		if (cached) return await cached;
		const persistPromise = resolveOutboundAttachmentFromUrl(media, maxBytes, { mediaAccess: resolveMediaAccessForSource(media) }).then((saved) => saved.path).catch((err) => {
			persistedMediaBySource.delete(media);
			throw err;
		});
		persistedMediaBySource.set(media, persistPromise);
		return await persistPromise;
	};
	const resolveWorkspaceRelativeMedia = (media) => {
		return resolvePathFromInput(toRelativeWorkspacePath(params.workspaceDir, media, { cwd: params.workspaceDir }), params.workspaceDir);
	};
	const normalizeMediaSource = async (raw) => {
		const media = raw.trim();
		if (!media) return media;
		assertMediaNotDataUrl(media);
		if (isPassThroughRemoteMediaSource(media)) return media;
		const isRelativeLocalMedia = isLikelyLocalMediaSource(media) && !FILE_URL_RE.test(media) && !media.startsWith("~") && !path.isAbsolute(media) && !WINDOWS_DRIVE_RE.test(media);
		const sandboxRoot = await resolveSandboxRoot();
		if (sandboxRoot) {
			let sandboxResolvedMedia;
			try {
				sandboxResolvedMedia = await resolveSandboxedMediaSource({
					media,
					sandboxRoot
				});
			} catch (err) {
				if (FILE_URL_RE.test(media)) throw new Error("Host-local MEDIA file URLs are blocked in normal replies. Use a safe path or the message tool.", { cause: err });
				throw err;
			}
			return await persistLocalReplyMedia(sandboxResolvedMedia);
		}
		if (isRelativeLocalMedia) return await persistLocalReplyMedia(resolveWorkspaceRelativeMedia(media));
		if (!isLikelyLocalMediaSource(media)) return media;
		if (FILE_URL_RE.test(media)) throw new Error("Host-local MEDIA file URLs are blocked in normal replies. Use a safe path or the message tool.");
		return await persistLocalReplyMedia(media);
	};
	return async (payload) => {
		const mediaList = getPayloadMediaList(payload);
		if (mediaList.length === 0) return payload;
		const normalizedMedia = [];
		const seen = /* @__PURE__ */ new Set();
		let firstMediaDropError;
		for (const media of mediaList) {
			let normalized;
			try {
				normalized = await normalizeMediaSource(media);
			} catch (err) {
				firstMediaDropError ??= err;
				logVerbose(`dropping blocked reply media ${media}: ${String(err)}`);
				continue;
			}
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			normalizedMedia.push(normalized);
		}
		if (normalizedMedia.length === 0) {
			const warning = firstMediaDropError ? formatBlockedReplyMediaWarning() : void 0;
			return {
				...payload,
				text: warning ? payload.text ? `${payload.text}\n${warning}` : warning : payload.text,
				mediaUrl: void 0,
				mediaUrls: void 0
			};
		}
		return {
			...payload,
			mediaUrl: normalizedMedia[0],
			mediaUrls: normalizedMedia
		};
	};
}
function createReplyMediaContext(params) {
	return { normalizePayload: createReplyMediaPathNormalizer(params) };
}
//#endregion
export { createReplyMediaPathNormalizer as n, createReplyMediaContext as t };
