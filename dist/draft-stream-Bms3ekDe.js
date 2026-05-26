import { s as createDraftStreamLoop } from "./channel-lifecycle-B7VOl7bW.js";
import { c as sendSingleTextMessageMatrix, n as editMessageMatrix, r as prepareMatrixSingleText } from "./send-xdKxcj70.js";
import { c as MsgType } from "./direct-management-WVUkEVTK.js";
//#region extensions/matrix/src/matrix/draft-stream.ts
const DEFAULT_THROTTLE_MS = 1e3;
function resolveDraftPreviewOptions(mode) {
	if (mode === "quiet") return {
		msgtype: MsgType.Notice,
		includeMentions: false
	};
	return { msgtype: MsgType.Text };
}
function createMatrixDraftStream(params) {
	const { roomId, client, cfg, threadId, accountId, log } = params;
	const preview = resolveDraftPreviewOptions(params.mode ?? "partial");
	const useLive = params.mode !== "quiet";
	let currentEventId;
	let lastSentText = "";
	let stopped = false;
	let sendFailed = false;
	let finalizeInPlaceBlocked = false;
	let liveFinalized = false;
	let replyToId = params.replyToId;
	const sendOrEdit = async (text) => {
		const trimmed = text.trimEnd();
		if (!trimmed) return false;
		const preparedText = prepareMatrixSingleText(trimmed, {
			cfg,
			accountId
		});
		if (!preparedText.fitsInSingleEvent) {
			finalizeInPlaceBlocked = true;
			if (!currentEventId) sendFailed = true;
			stopped = true;
			log?.(`draft-stream: preview exceeded single-event limit (${preparedText.convertedText.length} > ${preparedText.singleEventLimit})`);
			return false;
		}
		if (sendFailed) return false;
		if (preparedText.trimmedText === lastSentText) return true;
		try {
			if (!currentEventId) {
				currentEventId = (await sendSingleTextMessageMatrix(roomId, preparedText.trimmedText, {
					client,
					cfg,
					replyToId,
					threadId,
					accountId,
					msgtype: preview.msgtype,
					includeMentions: preview.includeMentions,
					live: useLive
				})).messageId;
				lastSentText = preparedText.trimmedText;
				log?.(`draft-stream: created message ${currentEventId}${useLive ? " (MSC4357 live)" : ""}`);
			} else {
				await editMessageMatrix(roomId, currentEventId, preparedText.trimmedText, {
					client,
					cfg,
					threadId,
					accountId,
					msgtype: preview.msgtype,
					includeMentions: preview.includeMentions,
					live: useLive
				});
				lastSentText = preparedText.trimmedText;
			}
			return true;
		} catch (err) {
			log?.(`draft-stream: send/edit failed: ${String(err)}`);
			if (err instanceof Error && err.message.startsWith("Matrix single-message text exceeds limit")) finalizeInPlaceBlocked = true;
			if (!currentEventId) sendFailed = true;
			stopped = true;
			return false;
		}
	};
	const loop = createDraftStreamLoop({
		throttleMs: DEFAULT_THROTTLE_MS,
		isStopped: () => stopped,
		sendOrEditStreamMessage: sendOrEdit
	});
	log?.(`draft-stream: ready (throttleMs=${DEFAULT_THROTTLE_MS})`);
	const finalizeLive = async () => {
		if (useLive && !liveFinalized && currentEventId && lastSentText) {
			liveFinalized = true;
			try {
				await editMessageMatrix(roomId, currentEventId, lastSentText, {
					client,
					cfg,
					threadId,
					accountId,
					msgtype: preview.msgtype,
					includeMentions: preview.includeMentions,
					live: false
				});
				log?.(`draft-stream: finalized ${currentEventId} (MSC4357 stream ended)`);
				return true;
			} catch (err) {
				log?.(`draft-stream: finalize edit failed: ${String(err)}`);
				finalizeInPlaceBlocked = true;
				return false;
			}
		}
		return true;
	};
	const stop = async () => {
		await loop.flush();
		stopped = true;
		return currentEventId;
	};
	const discardPending = async () => {
		stopped = true;
		loop.stop();
		await loop.waitForInFlight();
	};
	const reset = () => {
		replyToId = params.preserveReplyId ? params.replyToId : void 0;
		currentEventId = void 0;
		lastSentText = "";
		stopped = false;
		sendFailed = false;
		finalizeInPlaceBlocked = false;
		liveFinalized = false;
		loop.resetPending();
		loop.resetThrottleWindow();
	};
	return {
		update: (text) => {
			if (stopped) return;
			loop.update(text);
		},
		flush: loop.flush,
		stop,
		discardPending,
		finalizeLive,
		reset,
		eventId: () => currentEventId,
		matchesPreparedText: (text) => prepareMatrixSingleText(text, {
			cfg,
			accountId
		}).trimmedText === lastSentText,
		mustDeliverFinalNormally: () => sendFailed || finalizeInPlaceBlocked
	};
}
//#endregion
export { createMatrixDraftStream };
