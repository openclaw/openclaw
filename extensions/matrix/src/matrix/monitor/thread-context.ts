import {
  formatMatrixMessageText,
  resolveMatrixMessageAttachment,
  resolveMatrixMessageBody,
} from "../media-text.js";
import type { MatrixClient } from "../sdk.js";
import type { MatrixRawEvent } from "./types.js";

const MAX_TRACKED_THREAD_STARTERS = 256;
const MAX_THREAD_STARTER_BODY_LENGTH = 500;

type MatrixThreadContext = {
  threadStarterBody?: string;
};

function trimMaybeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function truncateThreadStarterBody(value: string): string {
  if (value.length <= MAX_THREAD_STARTER_BODY_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_THREAD_STARTER_BODY_LENGTH - 3)}...`;
}

export function summarizeMatrixThreadStarterEvent(event: MatrixRawEvent): string | undefined {
  const content = event.content as { body?: unknown; filename?: unknown; msgtype?: unknown };
  const body = formatMatrixMessageText({
    body: resolveMatrixMessageBody({
      body: trimMaybeString(content.body),
      filename: trimMaybeString(content.filename),
      msgtype: trimMaybeString(content.msgtype),
    }),
    attachment: resolveMatrixMessageAttachment({
      body: trimMaybeString(content.body),
      filename: trimMaybeString(content.filename),
      msgtype: trimMaybeString(content.msgtype),
    }),
  });
  if (body) {
    return truncateThreadStarterBody(body);
  }
  const msgtype = trimMaybeString(content.msgtype);
  if (msgtype) {
    return `Matrix ${msgtype} message`;
  }
  const eventType = trimMaybeString(event.type);
  return eventType ? `Matrix ${eventType} event` : undefined;
}

function formatMatrixThreadStarterBody(params: {
  threadRootId: string;
  senderName?: string;
  senderId?: string;
  summary?: string;
}): string {
  const senderLabel = params.senderName ?? params.senderId ?? "unknown sender";
  const lines = [`Matrix thread root ${params.threadRootId} from ${senderLabel}:`];
  if (params.summary) {
    lines.push(params.summary);
  }
  return lines.join("\n");
}

export function createMatrixThreadContextResolver(params: {
  client: MatrixClient;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
  logVerboseMessage: (message: string) => void;
}) {
  const cache = new Map<string, MatrixThreadContext>();

  const remember = (key: string, value: MatrixThreadContext): MatrixThreadContext => {
    cache.set(key, value);
    if (cache.size > MAX_TRACKED_THREAD_STARTERS) {
      const oldest = cache.keys().next().value;
      if (typeof oldest === "string") {
        cache.delete(oldest);
      }
    }
    return value;
  };

  return async (input: { roomId: string; threadRootId: string }): Promise<MatrixThreadContext> => {
    const cacheKey = `${input.roomId}:${input.threadRootId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const rootEvent = await params.client
      .getEvent(input.roomId, input.threadRootId)
      .catch((err) => {
        params.logVerboseMessage(
          `matrix: failed resolving thread root room=${input.roomId} id=${input.threadRootId}: ${String(err)}`,
        );
        return null;
      });
    if (!rootEvent) {
      return {
        threadStarterBody: `Matrix thread root ${input.threadRootId}`,
      };
    }

    const rawEvent = rootEvent as MatrixRawEvent;
    const senderId = trimMaybeString(rawEvent.sender);
    const senderName =
      senderId &&
      (await params.getMemberDisplayName(input.roomId, senderId).catch(() => undefined));
    return remember(cacheKey, {
      threadStarterBody: formatMatrixThreadStarterBody({
        threadRootId: input.threadRootId,
        senderId,
        senderName,
        summary: summarizeMatrixThreadStarterEvent(rawEvent),
      }),
    });
  };
}
