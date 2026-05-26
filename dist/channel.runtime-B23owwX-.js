import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { p as resolvePayloadMediaUrls, w as createReplyToFanout } from "./reply-payload-BOrd8HRU.js";
import { f as renderMessagePresentationFallbackText } from "./payload-BGXKFAMn.js";
import { n as resolveOutboundSendDep } from "./send-deps-jTRjIYIm.js";
import "./error-runtime-BnVeBNYa.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./outbound-runtime-HTtq1b9m.js";
import { t as chunkTextForOutbound } from "./text-chunking-3_9rfiI8.js";
import { a as sendMessageMatrix, l as sendTypingMatrix, o as sendPollMatrix } from "./send-COLF00ag.js";
import { t as isBunRuntime } from "./runtime-DfKVX18N.js";
import { n as resolveMatrixAuth } from "./config-Bt4AG3yX.js";
import "./client-5kTc_gY6.js";
import { n as listMatrixDirectoryPeersLive, t as listMatrixDirectoryGroupsLive } from "./directory-live-DPqb51Wq.js";
import "./runtime-api-D4X9QNMf.js";
import { t as resolveMatrixTargets } from "./resolve-targets-CAdI9W66.js";
//#region extensions/matrix/src/matrix/probe.ts
let matrixProbeRuntimeDepsPromise;
async function loadMatrixProbeRuntimeDeps() {
	matrixProbeRuntimeDepsPromise ??= import("./probe.runtime-NPqxgh43.js").then((runtimeModule) => ({ createMatrixClient: runtimeModule.createMatrixClient }));
	return await matrixProbeRuntimeDepsPromise;
}
async function probeMatrix(params) {
	const started = Date.now();
	const result = {
		ok: false,
		status: null,
		error: null,
		elapsedMs: 0
	};
	if (isBunRuntime()) return {
		...result,
		error: "Matrix probe requires Node (bun runtime not supported)",
		elapsedMs: Date.now() - started
	};
	if (!params.homeserver?.trim()) return {
		...result,
		error: "missing homeserver",
		elapsedMs: Date.now() - started
	};
	if (!params.accessToken?.trim()) return {
		...result,
		error: "missing access token",
		elapsedMs: Date.now() - started
	};
	try {
		const { createMatrixClient } = await loadMatrixProbeRuntimeDeps();
		const inputUserId = normalizeOptionalString(params.userId);
		const userId = await (await createMatrixClient({
			homeserver: params.homeserver,
			userId: inputUserId,
			accessToken: params.accessToken,
			deviceId: params.deviceId,
			persistStorage: false,
			localTimeoutMs: params.timeoutMs,
			accountId: params.accountId,
			allowPrivateNetwork: params.allowPrivateNetwork,
			ssrfPolicy: params.ssrfPolicy,
			dispatcherPolicy: params.dispatcherPolicy
		})).getUserId();
		result.ok = true;
		result.userId = userId ?? null;
		result.elapsedMs = Date.now() - started;
		return result;
	} catch (err) {
		return {
			...result,
			status: typeof err === "object" && err && "statusCode" in err ? Number(err.statusCode) : result.status,
			error: formatErrorMessage(err),
			elapsedMs: Date.now() - started
		};
	}
}
//#endregion
//#region extensions/matrix/src/outbound.ts
const MATRIX_OPENCLAW_PRESENTATION_KEY = "com.openclaw.presentation";
const MATRIX_OPENCLAW_PRESENTATION_TYPE = "message.presentation";
const MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT = "---";
function toRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function resolveMatrixChannelData(payload) {
	const raw = toRecord(payload.channelData)?.matrix;
	return toRecord(raw) ?? {};
}
function buildMatrixPresentationContent(presentation) {
	return {
		...presentation,
		version: 1,
		type: MATRIX_OPENCLAW_PRESENTATION_TYPE
	};
}
function resolveMatrixPresentationContent(payload) {
	const presentation = toRecord(toRecord(resolveMatrixChannelData(payload).extraContent)?.[MATRIX_OPENCLAW_PRESENTATION_KEY]);
	if (!presentation || presentation.version !== 1 || presentation.type !== MATRIX_OPENCLAW_PRESENTATION_TYPE) return;
	return presentation;
}
function renderMatrixPresentationPayload(params) {
	const matrixData = resolveMatrixChannelData(params.payload);
	const fallbackText = renderMessagePresentationFallbackText({
		text: params.payload.text,
		presentation: params.presentation,
		emptyFallback: MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT
	});
	return {
		...params.payload,
		text: fallbackText,
		channelData: {
			...params.payload.channelData,
			matrix: {
				...matrixData,
				extraContent: { [MATRIX_OPENCLAW_PRESENTATION_KEY]: buildMatrixPresentationContent(params.presentation) }
			}
		}
	};
}
function resolveMatrixPayloadText(payload) {
	const text = payload.text ?? "";
	if (text.trim() || !resolveMatrixPresentationContent(payload)) return text;
	return MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT;
}
function resolveMatrixExtraContent(payload) {
	const presentation = resolveMatrixPresentationContent(payload);
	return presentation ? { [MATRIX_OPENCLAW_PRESENTATION_KEY]: presentation } : void 0;
}
//#endregion
//#region extensions/matrix/src/channel.runtime.ts
const matrixChannelRuntime = {
	listMatrixDirectoryGroupsLive,
	listMatrixDirectoryPeersLive,
	matrixOutbound: {
		deliveryMode: "direct",
		chunker: chunkTextForOutbound,
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		presentationCapabilities: {
			supported: true,
			buttons: true,
			selects: true,
			context: true,
			divider: true
		},
		renderPresentation: ({ payload, presentation }) => renderMatrixPresentationPayload({
			payload,
			presentation
		}),
		sendPayload: async ({ cfg, to, payload, mediaLocalRoots, mediaReadFile, mediaAccess, deps, replyToId, replyToIdSource, replyToMode, threadId, accountId, audioAsVoice }) => {
			const send = resolveOutboundSendDep(deps, "matrix") ?? sendMessageMatrix;
			const resolvedThreadId = threadId !== void 0 && threadId !== null ? String(threadId) : void 0;
			const resolveReplyToId = createReplyToFanout({
				...replyToId != null ? { replyToId } : {},
				...replyToIdSource !== void 0 ? { replyToIdSource } : {},
				...replyToMode !== void 0 ? { replyToMode } : {}
			});
			const urls = resolvePayloadMediaUrls(payload);
			const payloadText = resolveMatrixPayloadText(payload);
			if (urls.length > 0) {
				let lastResult;
				for (let i = 0; i < urls.length; i++) {
					const isFirst = i === 0;
					lastResult = await send(to, isFirst ? payloadText : "", {
						cfg,
						mediaUrl: urls[i],
						mediaAccess,
						mediaLocalRoots,
						mediaReadFile,
						replyToId: resolveReplyToId(),
						threadId: resolvedThreadId,
						accountId: accountId ?? void 0,
						audioAsVoice: payload.audioAsVoice ?? audioAsVoice,
						extraContent: isFirst ? resolveMatrixExtraContent(payload) : void 0
					});
				}
				return {
					channel: "matrix",
					messageId: lastResult.messageId,
					roomId: lastResult.roomId
				};
			}
			const result = await send(to, payloadText, {
				cfg,
				mediaUrl: payload.mediaUrl,
				mediaAccess,
				mediaLocalRoots,
				mediaReadFile,
				replyToId: resolveReplyToId(),
				threadId: resolvedThreadId,
				accountId: accountId ?? void 0,
				audioAsVoice: payload.audioAsVoice ?? audioAsVoice,
				extraContent: resolveMatrixExtraContent(payload)
			});
			return {
				channel: "matrix",
				messageId: result.messageId,
				roomId: result.roomId
			};
		},
		sendText: async ({ cfg, to, text, deps, replyToId, threadId, accountId, audioAsVoice }) => {
			const result = await (resolveOutboundSendDep(deps, "matrix") ?? sendMessageMatrix)(to, text, {
				cfg,
				replyToId: replyToId ?? void 0,
				threadId: threadId !== void 0 && threadId !== null ? String(threadId) : void 0,
				accountId: accountId ?? void 0,
				audioAsVoice
			});
			return {
				channel: "matrix",
				messageId: result.messageId,
				roomId: result.roomId
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, mediaReadFile, deps, replyToId, threadId, accountId, audioAsVoice }) => {
			const result = await (resolveOutboundSendDep(deps, "matrix") ?? sendMessageMatrix)(to, text, {
				cfg,
				mediaUrl,
				mediaLocalRoots,
				mediaReadFile,
				replyToId: replyToId ?? void 0,
				threadId: threadId !== void 0 && threadId !== null ? String(threadId) : void 0,
				accountId: accountId ?? void 0,
				audioAsVoice
			});
			return {
				channel: "matrix",
				messageId: result.messageId,
				roomId: result.roomId
			};
		},
		sendPoll: async ({ cfg, to, poll, threadId, accountId }) => {
			const result = await sendPollMatrix(to, poll, {
				cfg,
				threadId: threadId !== void 0 && threadId !== null ? threadId : void 0,
				accountId: accountId ?? void 0
			});
			return {
				channel: "matrix",
				messageId: result.eventId,
				roomId: result.roomId,
				pollId: result.eventId
			};
		}
	},
	probeMatrix,
	resolveMatrixAuth,
	resolveMatrixTargets,
	sendMessageMatrix,
	sendTypingMatrix
};
//#endregion
export { matrixChannelRuntime };
