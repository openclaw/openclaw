import type { LocationMessageEventContent } from "../sdk.js";
import { RelationType } from "../send/types.js";
import type { createDirectRoomTracker } from "./direct.js";
import { hasBundledMatrixReplacementRelation } from "./handler-helpers.js";
import type { MatrixInboundEventDeduper } from "./inbound-dedupe.js";
import { resolveMatrixLocation, type MatrixLocationPayload } from "./location.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";
import { EventType } from "./types.js";
import { isMatrixVerificationRoomMessage } from "./verification-utils.js";

type ReplayClaimHandle = import("openclaw/plugin-sdk/persistent-dedupe").ChannelReplayClaimHandle;

type MatrixIngressPrefixConfig = {
  client: { getUserId: () => Promise<string> };
  senderId: string;
  dropPreStartupMessages: boolean;
  eventTs?: number;
  eventAge?: number;
  startupMs: number;
  event: MatrixRawEvent;
  eventType: string;
  eventId: string;
  inboundDeduper?: Pick<MatrixInboundEventDeduper, "claim">;
  roomId: string;
  logVerboseMessage: (message: string) => void;
  directTracker: Pick<ReturnType<typeof createDirectRoomTracker>, "isDirectMessage">;
  claimInboundReplay: (handle: ReplayClaimHandle) => void;
  /** Events folded into this one (a held attachment); they share its replay claim. */
  absorbedEventIds?: readonly string[];
};

function combineReplayClaims(
  handles: readonly [ReplayClaimHandle, ...ReplayClaimHandle[]],
): ReplayClaimHandle {
  if (handles.length === 1) {
    return handles[0];
  }
  return {
    keys: [handles[0].keys[0], ...handles.flatMap((handle) => handle.keys).slice(1)],
    commit: async (options) =>
      (await Promise.all(handles.map((handle) => handle.commit(options)))).every(Boolean),
    release: (options) => {
      for (const handle of handles) {
        handle.release(options);
      }
    },
  };
}

export async function readMatrixIngressPrefix(config: MatrixIngressPrefixConfig) {
  const {
    client,
    senderId,
    dropPreStartupMessages,
    eventTs,
    eventAge,
    startupMs,
    event,
    eventType,
    eventId,
    inboundDeduper,
    roomId,
    logVerboseMessage,
    directTracker,
    claimInboundReplay,
    absorbedEventIds = [],
  } = config;
  const selfUserId = await client.getUserId();
  if (senderId === selfUserId) {
    return undefined;
  }
  if (dropPreStartupMessages) {
    if (typeof eventTs === "number" && eventTs < startupMs) {
      return undefined;
    }
    if (typeof eventTs !== "number" && typeof eventAge === "number" && eventAge > 0) {
      return undefined;
    }
  }

  const content = event.content as RoomMessageEventContent;

  if (
    eventType === EventType.RoomMessage &&
    isMatrixVerificationRoomMessage({
      msgtype: (content as { msgtype?: unknown }).msgtype,
      body: content.body,
    })
  ) {
    logVerboseMessage(`matrix: skip verification/system room message room=${roomId}`);
    return undefined;
  }

  const locationPayload: MatrixLocationPayload | null = resolveMatrixLocation({
    eventType,
    content: content as LocationMessageEventContent,
  });

  const relates = content["m.relates_to"];
  if (relates && "rel_type" in relates && relates.rel_type === RelationType.Replace) {
    return undefined;
  }
  if (hasBundledMatrixReplacementRelation(event)) {
    return undefined;
  }
  if (eventId && inboundDeduper) {
    const claim = await inboundDeduper.claim({ roomId, eventId });
    // Missing identifiers fail open; committed and in-flight events do not.
    if (claim.kind === "claimed") {
      const handles: [ReplayClaimHandle, ...ReplayClaimHandle[]] = [claim.handle];
      for (const absorbedEventId of absorbedEventIds) {
        const absorbed = await inboundDeduper.claim({ roomId, eventId: absorbedEventId });
        if (absorbed.kind === "claimed") {
          handles.push(absorbed.handle);
        }
      }
      // Committing or releasing the turn settles every event it carries, so a replay
      // after an unclean stop cannot resurrect the attachment as its own turn.
      claimInboundReplay(combineReplayClaims(handles));
    } else if (claim.kind !== "invalid") {
      logVerboseMessage(`matrix: skip duplicate inbound event room=${roomId} id=${eventId}`);
      return undefined;
    }
  }

  const isDirectMessage = await directTracker.isDirectMessage({
    roomId,
    senderId,
    selfUserId,
  });
  return { content, isDirectMessage, locationPayload, selfUserId };
}
