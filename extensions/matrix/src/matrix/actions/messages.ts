import {
	fetchMatrixPollMessageSummary,
	resolveMatrixPollRootEventId,
} from "../poll-summary.js";
import { isPollEventType } from "../poll-types.js";
import { sendMessageMatrix } from "../send.js";
import { withResolvedRoomAction } from "./client.js";
import { resolveMatrixActionLimit } from "./limits.js";
import { summarizeMatrixRawEvent } from "./summary.js";
import {
	EventType,
	type MatrixActionClientOpts,
	type MatrixMessageSummary,
	type MatrixRawEvent,
	MsgType,
	RelationType,
	type RoomMessageEventContent,
} from "./types.js";

export async function sendMatrixMessage(
	to: string,
	content: string | undefined,
	opts: MatrixActionClientOpts & {
		mediaUrl?: string;
		replyToId?: string;
		threadId?: string;
		audioAsVoice?: boolean;
	} = {},
) {
	return await sendMessageMatrix(to, content, {
		cfg: opts.cfg,
		mediaUrl: opts.mediaUrl,
		mediaLocalRoots: opts.mediaLocalRoots,
		replyToId: opts.replyToId,
		threadId: opts.threadId,
		audioAsVoice: opts.audioAsVoice,
		accountId: opts.accountId ?? undefined,
		client: opts.client,
		timeoutMs: opts.timeoutMs,
	});
}

export async function editMatrixMessage(
	roomId: string,
	messageId: string,
	content: string,
	opts: MatrixActionClientOpts = {},
) {
	const trimmed = content.trim();
	if (!trimmed) {
		throw new Error("Matrix edit requires content");
	}
	return await withResolvedRoomAction(
		roomId,
		opts,
		async (client, resolvedRoom) => {
			const newContent = {
				msgtype: MsgType.Text,
				body: trimmed,
			} satisfies RoomMessageEventContent;
			const payload: RoomMessageEventContent = {
				msgtype: MsgType.Text,
				body: `* ${trimmed}`,
				"m.new_content": newContent,
				"m.relates_to": {
					rel_type: RelationType.Replace,
					event_id: messageId,
				},
			};
			const eventId = await client.sendMessage(resolvedRoom, payload);
			return { eventId: eventId ?? null };
		},
	);
}

export async function deleteMatrixMessage(
	roomId: string,
	messageId: string,
	opts: MatrixActionClientOpts & { reason?: string } = {},
) {
	await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
		await client.redactEvent(resolvedRoom, messageId, opts.reason);
	});
}

export async function readMatrixMessages(
	roomId: string,
	opts: MatrixActionClientOpts & {
		limit?: number;
		before?: string;
		after?: string;
	} = {},
): Promise<{
	messages: MatrixMessageSummary[];
	nextBatch?: string | null;
	prevBatch?: string | null;
}> {
	return await withResolvedRoomAction(
		roomId,
		opts,
		async (client, resolvedRoom) => {
			const limit = resolveMatrixActionLimit(opts.limit, 20);
			const token = opts.before?.trim() || opts.after?.trim() || undefined;
			const dir = opts.after ? "f" : "b";
			// Room history is queried via the low-level endpoint for compatibility.
			const res = (await client.doRequest(
				"GET",
				`/_matrix/client/v3/rooms/${encodeURIComponent(resolvedRoom)}/messages`,
				{
					dir,
					limit,
					from: token,
				},
			)) as { chunk: MatrixRawEvent[]; start?: string; end?: string };
			const hydratedChunk = await client.hydrateEvents(resolvedRoom, res.chunk);
			const seenPollRoots = new Set<string>();
			const messages: MatrixMessageSummary[] = [];
			for (const event of hydratedChunk) {
				if (event.unsigned?.redacted_because) {
					continue;
				}
				if (event.type === EventType.RoomMessage) {
					messages.push(summarizeMatrixRawEvent(event));
					continue;
				}
				if (!isPollEventType(event.type)) {
					continue;
				}
				const pollRootId = resolveMatrixPollRootEventId(event);
				if (!pollRootId || seenPollRoots.has(pollRootId)) {
					continue;
				}
				seenPollRoots.add(pollRootId);
				const pollSummary = await fetchMatrixPollMessageSummary(
					client,
					resolvedRoom,
					event,
				);
				if (pollSummary) {
					messages.push(pollSummary);
				}
			}
			return {
				messages,
				nextBatch: res.end ?? null,
				prevBatch: res.start ?? null,
			};
		},
	);
}
