import { createDraftStreamLoop } from "openclaw/plugin-sdk/channel-lifecycle";
import type { CoreConfig } from "../types.js";
import type { MatrixClient } from "./sdk.js";
import {
	editMessageMatrix,
	prepareMatrixSingleText,
	sendSingleTextMessageMatrix,
} from "./send.js";

const DEFAULT_THROTTLE_MS = 1000;

export type MatrixDraftStream = {
	/** Update the draft with the latest accumulated text for the current block. */
	update: (text: string) => void;
	/** Ensure the last pending update has been sent. */
	flush: () => Promise<void>;
	/** Flush and mark this block as done. Returns the event ID if a message was sent. */
	stop: () => Promise<string | undefined>;
	/** Reset state for the next text block (after tool calls). */
	reset: () => void;
	/** The event ID of the current draft message, if any. */
	eventId: () => string | undefined;
	/** The last text successfully sent or edited. */
	lastSentText: () => string;
	/** True when preview streaming must fall back to normal final delivery. */
	mustDeliverFinalNormally: () => boolean;
};

export function createMatrixDraftStream(params: {
	roomId: string;
	client: MatrixClient;
	cfg: CoreConfig;
	threadId?: string;
	replyToId?: string;
	/** When true, reset() restores the original replyToId instead of clearing it. */
	preserveReplyId?: boolean;
	accountId?: string;
	log?: (message: string) => void;
}): MatrixDraftStream {
	const { roomId, client, cfg, threadId, accountId, log } = params;

	let currentEventId: string | undefined;
	let lastSentText = "";
	let stopped = false;
	let sendFailed = false;
	let finalizeInPlaceBlocked = false;
	let replyToId = params.replyToId;

	const sendOrEdit = async (text: string): Promise<boolean> => {
		const trimmed = text.trimEnd();
		if (!trimmed) {
			return false;
		}
		const preparedText = prepareMatrixSingleText(trimmed, { cfg, accountId });
		if (!preparedText.fitsInSingleEvent) {
			finalizeInPlaceBlocked = true;
			if (!currentEventId) {
				sendFailed = true;
			}
			stopped = true;
			log?.(
				`draft-stream: preview exceeded single-event limit (${preparedText.convertedText.length} > ${preparedText.singleEventLimit})`,
			);
			return false;
		}
		// If the initial send failed, stop trying for this block.  The deliver
		// callback will fall back to deliverMatrixReplies.
		if (sendFailed) {
			return false;
		}
		if (preparedText.trimmedText === lastSentText) {
			return true;
		}
		try {
			if (!currentEventId) {
				const result = await sendSingleTextMessageMatrix(
					roomId,
					preparedText.trimmedText,
					{
						client,
						cfg,
						replyToId,
						threadId,
						accountId,
					},
				);
				currentEventId = result.messageId;
				lastSentText = preparedText.trimmedText;
				log?.(`draft-stream: created message ${currentEventId}`);
			} else {
				await editMessageMatrix(
					roomId,
					currentEventId,
					preparedText.trimmedText,
					{
						client,
						cfg,
						threadId,
						accountId,
					},
				);
				lastSentText = preparedText.trimmedText;
			}
			return true;
		} catch (err) {
			log?.(`draft-stream: send/edit failed: ${String(err)}`);
			const isPreviewLimitError =
				err instanceof Error &&
				err.message.startsWith("Matrix single-message text exceeds limit");
			if (isPreviewLimitError) {
				// Once the preview no longer fits in one editable event, preserve the
				// current preview as-is and fall back to normal final delivery.
				finalizeInPlaceBlocked = true;
			}
			if (!currentEventId) {
				// First send failed — give up for this block so the deliver callback
				// falls through to normal delivery.
				sendFailed = true;
			}
			// Signal failure so the loop stops retrying.
			stopped = true;
			return false;
		}
	};

	const loop = createDraftStreamLoop({
		throttleMs: DEFAULT_THROTTLE_MS,
		isStopped: () => stopped,
		sendOrEditStreamMessage: sendOrEdit,
	});

	log?.(`draft-stream: ready (throttleMs=${DEFAULT_THROTTLE_MS})`);

	const stop = async (): Promise<string | undefined> => {
		// Flush before marking stopped so the loop can drain pending text.
		await loop.flush();
		stopped = true;
		return currentEventId;
	};

	const reset = (): void => {
		// Clear reply context unless preserveReplyId is set (replyToMode "all"),
		// in which case subsequent blocks should keep replying to the original.
		replyToId = params.preserveReplyId ? params.replyToId : undefined;
		currentEventId = undefined;
		lastSentText = "";
		stopped = false;
		sendFailed = false;
		finalizeInPlaceBlocked = false;
		loop.resetPending();
		loop.resetThrottleWindow();
	};

	return {
		update: (text: string) => {
			if (stopped) {
				return;
			}
			loop.update(text);
		},
		flush: loop.flush,
		stop,
		reset,
		eventId: () => currentEventId,
		lastSentText: () => lastSentText,
		mustDeliverFinalNormally: () => sendFailed || finalizeInPlaceBlocked,
	};
}
