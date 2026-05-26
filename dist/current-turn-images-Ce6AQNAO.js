import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { n as resolveAgentTurnAttachments } from "./agent-turn-attachments-BM8XhuOm.js";
//#region src/shared/silent-reply-policy.ts
const DEFAULT_SILENT_REPLY_POLICY = {
	direct: "disallow",
	group: "allow",
	internal: "allow"
};
function classifySilentReplyConversationType(params) {
	if (params.conversationType) return params.conversationType;
	const normalizedSessionKey = normalizeLowercaseStringOrEmpty(params.sessionKey);
	if (normalizedSessionKey.includes(":group:") || normalizedSessionKey.includes(":channel:")) return "group";
	if (normalizedSessionKey.includes(":direct:") || normalizedSessionKey.includes(":dm:")) return "direct";
	if (normalizeLowercaseStringOrEmpty(params.surface) === "webchat") return "direct";
	return "internal";
}
function resolveSilentReplyPolicyFromPolicies(params) {
	if (params.conversationType === "direct") return "disallow";
	return params.surfacePolicy?.[params.conversationType] ?? params.defaultPolicy?.[params.conversationType] ?? DEFAULT_SILENT_REPLY_POLICY[params.conversationType];
}
//#endregion
//#region src/config/silent-reply.ts
function resolveSilentReplyConversationContext(params) {
	const conversationType = classifySilentReplyConversationType({
		sessionKey: params.sessionKey,
		surface: params.surface,
		conversationType: params.conversationType
	});
	const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
	const surface = normalizedSurface ? params.cfg?.surfaces?.[normalizedSurface] : void 0;
	return {
		conversationType,
		defaultPolicy: params.cfg?.agents?.defaults?.silentReply,
		surfacePolicy: surface?.silentReply
	};
}
function resolveSilentReplySettings(params) {
	return { policy: resolveSilentReplyPolicyFromPolicies(resolveSilentReplyConversationContext(params)) };
}
function resolveSilentReplyPolicy(params) {
	return resolveSilentReplySettings(params).policy;
}
//#endregion
//#region src/auto-reply/reply/current-turn-images.ts
function countCurrentImageAttachmentCandidates(ctx) {
	const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : void 0;
	const paths = pathsFromArray && pathsFromArray.length > 0 ? pathsFromArray : normalizeOptionalString(ctx.MediaPath) ? [ctx.MediaPath] : [];
	if (paths.length === 0) return 0;
	const types = Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length ? ctx.MediaTypes : void 0;
	let count = 0;
	for (const [index, pathValue] of paths.entries()) {
		const mediaPath = normalizeOptionalString(pathValue);
		const mediaType = normalizeOptionalString(types?.[index] ?? ctx.MediaType);
		if (mediaPath && mediaType?.startsWith("image/")) count++;
	}
	return count;
}
async function resolveCurrentTurnImages(params) {
	if (Array.isArray(params.images) && params.images.length > 0) return {
		images: params.images,
		imageOrder: params.imageOrder
	};
	const currentImageCandidateCount = countCurrentImageAttachmentCandidates(params.ctx);
	if (currentImageCandidateCount === 0) return {
		images: params.images,
		imageOrder: params.imageOrder
	};
	try {
		const images = (await resolveAgentTurnAttachments({
			ctx: params.ctx,
			cfg: params.cfg,
			includeRecentHistoryImages: false
		})).attachments.map((attachment) => ({
			type: "image",
			data: attachment.data,
			mimeType: attachment.mediaType
		}));
		if (images.length < currentImageCandidateCount) {
			logVerbose(`agent-runner: native PI media resolution produced ${images.length}/${currentImageCandidateCount} current image attachment(s); falling back to prompt image refs`);
			return {
				images: params.images,
				imageOrder: params.imageOrder
			};
		}
		return images.length > 0 ? {
			images,
			imageOrder: images.map(() => "inline")
		} : {
			images: params.images,
			imageOrder: params.imageOrder
		};
	} catch (error) {
		logVerbose(`agent-runner: media attachment image resolution failed, proceeding without native images: ${formatErrorMessage(error)}`);
		return {
			images: params.images,
			imageOrder: params.imageOrder
		};
	}
}
//#endregion
export { resolveSilentReplyPolicy as n, resolveSilentReplySettings as r, resolveCurrentTurnImages as t };
