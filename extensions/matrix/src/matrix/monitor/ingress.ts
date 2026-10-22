import {
  createChannelIngressError,
  createChannelIngressMonitor,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixSyncIngressHandler } from "../client/file-sync-store.js";
import { isPollEventType } from "../poll-types.js";
import type { MatrixClient, MatrixRawEvent } from "../sdk.js";
import { getMatrixEventProjection } from "../sdk/event-helpers.js";
import { EventType } from "./types.js";

type MatrixIngressEvent = {
  roomId: string;
  event: MatrixRawEvent;
  historical?: boolean;
};

type MatrixIngressPayload = MatrixIngressEvent & { version: 1 };

const MatrixIngressPayloadError = createChannelIngressError("MatrixIngressPayloadError");

function inspectMatrixIngressEvent(raw: MatrixIngressEvent) {
  if (
    !raw ||
    typeof raw.roomId !== "string" ||
    !raw.roomId.trim() ||
    !raw.event ||
    typeof raw.event.event_id !== "string" ||
    !raw.event.event_id.trim()
  ) {
    throw new MatrixIngressPayloadError("Matrix ingress event is missing its room or event ID");
  }
  return { eventId: raw.event.event_id, laneKey: `room:${raw.roomId}` };
}

function isMessageEvent(event: MatrixRawEvent): boolean {
  return (
    event.type === EventType.RoomMessage ||
    event.type === EventType.RoomMessageEncrypted ||
    event.type === EventType.Location ||
    event.type === EventType.Reaction ||
    isPollEventType(event.type)
  );
}

export function createMatrixIngressMonitor(params: {
  accountId: string;
  client: Pick<MatrixClient, "hydrateEvents" | "crypto">;
  startupMs: number;
  dispatch: (
    roomId: string,
    event: MatrixRawEvent,
    lifecycle: ChannelIngressMonitorLifecycle,
  ) => Promise<ChannelIngressMonitorDeliveryResult | void>;
  onError?: (error: unknown) => void;
  queue?: ChannelIngressQueue<MatrixIngressPayload>;
}) {
  let queue = params.queue;
  const getQueue = () =>
    (queue ??= getMatrixRuntime().state.openChannelIngressQueue<MatrixIngressPayload>({
      accountId: params.accountId,
    }));
  let lastReceivedAt = 0;
  let initializeOrder: Promise<void> | undefined;
  const monitor = createChannelIngressMonitor<
    MatrixIngressEvent,
    MatrixIngressEvent,
    MatrixIngressPayload
  >({
    queue: getQueue,
    inspect: inspectMatrixIngressEvent,
    payload: {
      version: 1,
      serialize: (raw) => raw,
      deserialize: (body) => body,
      encode: ({ body }) => ({ version: 1, ...body }),
      decode: (payload) => {
        inspectMatrixIngressEvent(payload);
        return { version: payload.version, body: payload };
      },
      createClaimError: (kind) =>
        new MatrixIngressPayloadError(
          kind === "invalid-version"
            ? "Matrix ingress payload version is unsupported"
            : "Matrix event identity changed after durable admission",
        ),
    },
    deliver: async ({ roomId, event, historical }, lifecycle) => {
      if (historical) {
        return;
      }
      if (event.type === EventType.RoomMessageEncrypted && !params.client.crypto) {
        // The existing event listener explains how to enable encryption.
        return;
      }
      // Persist ciphertext before the sync cursor, then decrypt from local SDK
      // state on every attempt so a late room key can recover a queued message.
      const [hydrated] = await params.client.hydrateEvents(roomId, [event]);
      if (
        !hydrated ||
        hydrated.type === EventType.RoomMessageEncrypted ||
        getMatrixEventProjection(hydrated)?.decryptionFailure
      ) {
        throw new Error("Matrix ingress event is waiting for decryption");
      }
      return await params.dispatch(roomId, hydrated, lifecycle);
    },
    pollIntervalMs: 1_000,
    retention: "standard",
    waitForDeliveryIdleOnStop: false,
    drain: {
      deferredLaneOccupancy: "release",
      onLog: params.onError,
      resolveNonRetryableFailure: (error) =>
        error instanceof MatrixIngressPayloadError
          ? { reason: "invalid-event", message: error.message }
          : null,
    },
    onError: params.onError,
  });

  const admitSync: MatrixSyncIngressHandler = async (sync, { hasSavedSync }) => {
    const events: MatrixIngressEvent[] = [];
    const rooms = [
      ...Object.entries(sync.rooms?.join ?? {}),
      ...Object.entries(sync.rooms?.leave ?? {}),
    ];
    for (const [roomId, room] of rooms) {
      for (const event of room.timeline?.events ?? []) {
        if (!isMessageEvent(event)) {
          continue;
        }
        // Persist first-login exclusions too, so cached sync cannot revive them
        // after a restart. The shared drain records their intentional non-delivery.
        const historical =
          !hasSavedSync &&
          ((typeof event.origin_server_ts === "number" &&
            event.origin_server_ts < params.startupMs) ||
            (typeof event.origin_server_ts !== "number" &&
              typeof event.unsigned?.age === "number" &&
              event.unsigned.age > 0));
        events.push({
          roomId,
          event: { ...event, room_id: roomId },
          ...(historical ? { historical: true } : {}),
        });
      }
    }
    if (events.length === 0) {
      return;
    }
    await (initializeOrder ??= (async () => {
      const ingressQueue = getQueue();
      const { pending, claims } = ingressQueue.listUnsettled
        ? await ingressQueue.listUnsettled()
        : {
            pending: await ingressQueue.listPending({ limit: "all" }),
            claims: await ingressQueue.listClaims(),
          };
      for (const row of [...pending, ...claims]) {
        lastReceivedAt = Math.max(lastReceivedAt, row.receivedAt);
      }
    })());
    // Sync-store callbacks are serialized. Matrix IDs do not encode order, so
    // continue the queued receipt order instead of tying a whole batch on time.
    for (const event of events) {
      const result = await monitor.admit(event, {
        receivedAt: Math.max(Date.now(), lastReceivedAt + 1),
      });
      if (result.kind === "durable") {
        const admitted = result.queueResult;
        if (
          admitted.kind === "accepted" ||
          admitted.kind === "pending" ||
          admitted.kind === "claimed"
        ) {
          lastReceivedAt = Math.max(lastReceivedAt, admitted.record.receivedAt);
        }
      }
    }
  };

  return {
    admitSync,
    start: monitor.start,
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
