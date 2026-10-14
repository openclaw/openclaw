import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixClient } from "../sdk.js";
import { setBoundedMap } from "./bounded-cache.js";
import {
  summarizeMatrixMessageContextEvent,
  truncateMatrixContextBody,
} from "./context-summary.js";

type MatrixEventContext = {
  summary?: string;
  senderId?: string;
  senderLabel?: string;
  threadStarterBody?: string;
};

export function createMatrixEventContextResolver(params: {
  kind: "reply" | "thread";
  client: MatrixClient;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
  logVerboseMessage: (message: string) => void;
}) {
  const cache = new Map<string, MatrixEventContext>();
  const isThread = params.kind === "thread";

  return async (input: { roomId: string; eventId: string }): Promise<MatrixEventContext> => {
    const cacheKey = `${input.roomId}:${input.eventId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      // Replies use LRU; thread roots retain their original FIFO lifetime.
      if (!isThread) {
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
      }
      return cached;
    }

    const event = await params.client
      .getEvent(input.roomId, input.eventId)
      .catch((err: unknown) => {
        params.logVerboseMessage(
          `matrix: failed resolving ${isThread ? "thread root" : "reply context"} room=${input.roomId} id=${input.eventId}: ${String(err)}`,
        );
        return null;
      });
    // Thread senders also prove mention-policy ownership; mismatched roots cannot supply it.
    // Failed lookups stay uncached so later references retry the homeserver.
    if (
      !event ||
      (isThread &&
        (event.event_id !== input.eventId || (event.room_id && event.room_id !== input.roomId)))
    ) {
      return isThread ? { threadStarterBody: `Matrix thread root ${input.eventId}` } : {};
    }

    const context: MatrixEventContext = {};
    if (isThread || !event.unsigned?.redacted_because) {
      const body = summarizeMatrixMessageContextEvent(event);
      let summary = body ? truncateMatrixContextBody(body) : undefined;
      if (isThread && !summary) {
        const msgtype = normalizeOptionalString(event.content.msgtype);
        const eventType = normalizeOptionalString(event.type);
        summary = msgtype
          ? `Matrix ${msgtype} message`
          : eventType
            ? `Matrix ${eventType} event`
            : undefined;
      }
      if (isThread || summary) {
        const senderId = normalizeOptionalString(event.sender);
        const senderName =
          senderId &&
          (await params.getMemberDisplayName(input.roomId, senderId).catch(() => undefined));
        Object.assign(context, { summary, senderId, senderLabel: senderName ?? senderId });
        if (isThread) {
          const lines = [
            `Matrix thread root ${input.eventId} from ${senderName ?? senderId ?? "unknown sender"}:`,
          ];
          if (summary) {
            lines.push(summary);
          }
          context.threadStarterBody = lines.join("\n");
        }
      }
    }
    setBoundedMap(cache, cacheKey, context, 256);
    return context;
  };
}
