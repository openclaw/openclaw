import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexEventProjection } from "./event-projector-events.js";
import {
  itemStatus,
  matchesCodexSnapshotTurn,
  shouldSynthesizeToolProgressForItem,
} from "./event-projector-items.js";
import type { CodexThreadItem, JsonObject } from "./protocol.js";

export async function emitSnapshotOnlyNativeToolProgress(params: {
  activeItemIds: Set<string>;
  completedItemIds: Set<string>;
  eventProjection: CodexEventProjection;
  isProjectionClosed: () => boolean;
  item: CodexThreadItem;
  turnId: string;
}): Promise<void> {
  const { item } = params;
  if (
    !shouldSynthesizeToolProgressForItem(item) ||
    !matchesCodexSnapshotTurn(item, params.turnId) ||
    params.completedItemIds.has(item.id) ||
    itemStatus(item) === "running"
  ) {
    return;
  }
  const wasStarted = params.activeItemIds.has(item.id);
  if (!wasStarted) {
    params.eventProjection.emitStandardItemEvent({ phase: "start", item });
    await params.eventProjection.emitNormalizedToolItemEvent({ phase: "start", item });
  }
  if (params.isProjectionClosed()) {
    return;
  }
  params.activeItemIds.delete(item.id);
  params.eventProjection.emitStandardItemEvent({ phase: "end", item });
  await params.eventProjection.emitNormalizedToolItemEvent({ phase: "result", item });
  params.completedItemIds.add(item.id);
}

export function isHookNotificationForCurrentThread(
  params: JsonObject,
  threadId: string,
  turnId: string,
): boolean {
  const notificationThreadId = readString(params, "threadId");
  return notificationThreadId === threadId && (params.turnId === turnId || params.turnId === null);
}
