import { ConnectionError, HTTPError, Method } from "matrix-js-sdk/lib/http-api/index.js";
import {
  EventType,
  MatrixError,
  MatrixEvent,
  type MatrixClient,
} from "matrix-js-sdk/lib/matrix.js";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { LogService } from "./logger.js";

// A single startup budget owns the lookup, this pool, and non-abortable crypto replay.
const ROOM_CONCURRENCY = 4;

export async function reconcileJoinedRoomEncryption(
  client: MatrixClient,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) {
    return;
  }
  if (!(crypto instanceof RustCrypto)) {
    throw new Error("Matrix room encryption recovery requires the Rust crypto backend");
  }
  const checkActive = () => {
    signal.throwIfAborted();
    assertCurrent();
  };
  checkActive();
  let joinedRooms: string[];
  try {
    ({ joined_rooms: joinedRooms } = await client.http.authedRequest<{ joined_rooms: string[] }>(
      Method.Get,
      "/joined_rooms",
      undefined,
      undefined,
      { abortSignal: signal },
    ));
  } catch (error) {
    checkActive();
    if (
      error instanceof ConnectionError ||
      (error instanceof HTTPError &&
        (error.httpStatus === 408 || error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500))
    ) {
      // Discovery is best effort: healthy cached rooms can still send, while
      // the send owner continues to reject unknown or unrecovered encryption.
      LogService.warn(
        "MatrixClientLite",
        "Skipping room encryption recovery: joined-room discovery failed",
        error,
      );
      return;
    }
    throw error;
  }
  checkActive();
  if (!Array.isArray(joinedRooms) || !joinedRooms.every((room) => typeof room === "string")) {
    throw new Error("Matrix homeserver returned invalid joined rooms");
  }
  const rooms = [...new Set(joinedRooms)];
  let next = 0;
  const worker = async () => {
    while (next < rooms.length) {
      checkActive();
      const roomId = rooms[next++];
      if (!roomId) {
        continue;
      }
      const room = client.getRoom(roomId);
      // /joined_rooms is authoritative, but membership may change during recovery.
      // Do not manufacture a Room without its sync-owned membership/timeline state.
      if (!room || room.getMyMembership() !== "join") {
        continue;
      }
      try {
        let event = room.currentState.getStateEvents(EventType.RoomEncryption, "");
        if (!event) {
          const content = await client.http.authedRequest<Record<string, unknown>>(
            Method.Get,
            `/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`,
            undefined,
            undefined,
            { abortSignal: signal },
          );
          checkActive();
          // The state endpoint returns content, not a full event. Use the SDK's
          // real event model, as classic sync does, never a callback-shaped facade.
          event = new MatrixEvent({
            room_id: roomId,
            type: EventType.RoomEncryption,
            state_key: "",
            content,
          });
        }
        checkActive();
        if (client.getRoom(roomId) !== room || room.getMyMembership() !== "join") {
          continue;
        }
        // Match SyncApi's ordering: configure crypto before publishing room state.
        // This SDK call cannot be aborted; the lifecycle must join it before stop.
        await crypto.onCryptoEvent(room, event);
        checkActive();
        if (client.getRoom(roomId) === room && room.getMyMembership() === "join") {
          room.currentState.setStateEvents([event]);
        }
      } catch (error) {
        checkActive();
        if (
          error instanceof MatrixError &&
          error.httpStatus === 404 &&
          error.errcode === "M_NOT_FOUND"
        ) {
          continue;
        }
        // One unavailable room must not prevent recovery in other rooms. Sending
        // still uses the authoritative fail-closed encryption/readiness checks.
        LogService.warn("MatrixClientLite", `Failed to recover encryption for ${roomId}:`, error);
      }
    }
  };
  // Do not abandon sibling replays when cancellation rejects the first worker.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(ROOM_CONCURRENCY, rooms.length) }, worker),
  );
  checkActive();
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}
