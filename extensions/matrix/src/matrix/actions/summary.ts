import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import {
  EventType,
  type MatrixMessageSummary,
  type MatrixRawEvent,
  type RoomMessageEventContent,
  type RoomPinnedEventsEventContent,
} from "./types.js";

type EventSummaryOptions = {
  includeMedia?: boolean;
  client?: Pick<MatrixClient, "mxcToHttp">;
};

/**
 * Summarizes a raw Matrix event into a simplified structure.
 *
 * CAUTION: This function must remain synchronous to be used in array.map()
 * within readMatrixMessages. Do not introduce async calls here.
 */
export function summarizeMatrixRawEvent(
  event: MatrixRawEvent,
  opts: EventSummaryOptions = {},
): MatrixMessageSummary {
  const content = event.content as RoomMessageEventContent;
  const relates = content["m.relates_to"];
  let relType: string | undefined;
  let eventId: string | undefined;
  if (relates) {
    if ("rel_type" in relates) {
      relType = relates.rel_type;
      eventId = relates.event_id;
    } else if ("m.in_reply_to" in relates) {
      eventId = relates["m.in_reply_to"]?.event_id;
    }
  }
  const relatesTo =
    relType || eventId
      ? {
          relType,
          eventId,
        }
      : undefined;

  let media: MatrixMessageSummary["media"];
  if (opts.includeMedia) {
    const plainMxc = typeof content.url === "string" ? content.url : undefined;
    const encryptedFile =
      content.file && typeof content.file === "object"
        ? (content.file as { url?: unknown })
        : undefined;
    const encryptedMxc =
      encryptedFile && typeof encryptedFile.url === "string" ? encryptedFile.url : undefined;
    const mxcUrl = plainMxc ?? encryptedMxc;
    if (mxcUrl) {
      const info =
        content.info && typeof content.info === "object"
          ? (content.info as { mimetype?: unknown; size?: unknown; duration?: unknown })
          : undefined;
      media = {
        mxcUrl,
        downloadUrl: opts.client?.mxcToHttp(mxcUrl),
        encrypted: mxcUrl === encryptedMxc,
        contentType: typeof info?.mimetype === "string" ? info.mimetype : undefined,
        sizeBytes: typeof info?.size === "number" ? info.size : undefined,
        durationMs: typeof info?.duration === "number" ? info.duration : undefined,
      };
    }
  }

  return {
    eventId: event.event_id,
    sender: event.sender,
    body: content.body,
    msgtype: content.msgtype,
    timestamp: event.origin_server_ts,
    media,
    relatesTo,
  };
}

export async function readPinnedEvents(client: MatrixClient, roomId: string): Promise<string[]> {
  try {
    const content = (await client.getRoomStateEvent(
      roomId,
      EventType.RoomPinnedEvents,
      "",
    )) as RoomPinnedEventsEventContent;
    const pinned = content.pinned;
    return pinned.filter((id) => id.trim().length > 0);
  } catch (err: unknown) {
    const errObj = err as { statusCode?: number; body?: { errcode?: string } };
    const httpStatus = errObj.statusCode;
    const errcode = errObj.body?.errcode;
    if (httpStatus === 404 || errcode === "M_NOT_FOUND") {
      return [];
    }
    throw err;
  }
}

export async function fetchEventSummary(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<MatrixMessageSummary | null> {
  try {
    const raw = (await client.getEvent(roomId, eventId)) as unknown as MatrixRawEvent;
    if (raw.unsigned?.redacted_because) {
      return null;
    }
    return summarizeMatrixRawEvent(raw);
  } catch {
    // Event not found, redacted, or inaccessible - return null
    return null;
  }
}
