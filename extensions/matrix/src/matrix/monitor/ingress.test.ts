import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import { matrixSyncResponse, useSyncStoreFixture } from "../client/sync-store.test-support.js";
import { MatrixClient, type MatrixRawEvent } from "../sdk.js";
import { createMatrixCryptoFacade } from "../sdk/crypto-facade.js";
import { matrixEventToRaw } from "../sdk/event-helpers.js";
import { MatrixRecoveryKeyStore } from "../sdk/recovery-key-store.js";
import { MatrixVerificationManager } from "../sdk/verification-manager.js";
import { createMatrixIngressMonitor } from "./ingress.js";

type IngressPayload = { version: 1; roomId: string; event: MatrixRawEvent };
const roomId = "!room:example.org";
const createClient = () => new MatrixClient("https://example.org", "synthetic-token");
const encryptedEvent = (event_id: string, origin_server_ts: number) =>
  ({
    event_id,
    origin_server_ts,
    sender: "@alice:example.org",
    type: "m.room.encrypted",
    content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "encrypted-fixture" },
  }) satisfies MatrixRawEvent;

describe("Matrix sync admission", () => {
  const storage = useSyncStoreFixture("openclaw-matrix-ingress-");
  const createQueue = (now?: () => number) =>
    createChannelIngressQueueForTests<IngressPayload>({
      channelId: "matrix",
      accountId: "default",
      stateDir: storage.root,
      ...(now ? { now } : {}),
    });

  it("preserves raw replay and left-room events", async () => {
    const queue = createQueue();
    const event = encryptedEvent("$ciphertext", 1_000);
    const sync = matrixSyncResponse("cursor", roomId, event, "previous");
    const monitor = createMatrixIngressMonitor({
      accountId: "default",
      client: createClient(),
      startupMs: 2_000,
      queue,
      dispatch: async () => {
        throw new Error("Admission must not dispatch before the monitor starts");
      },
    });
    try {
      sync.rooms.leave = {
        "!left:example.org": {
          state: { events: [] },
          timeline: {
            events: [{ ...event, event_id: "$left", type: "m.room.message" }],
            prev_batch: "left-previous",
          },
          account_data: { events: [] },
        },
      };
      await monitor.admitSync(sync, { hasSavedSync: true });
      await monitor.admitSync(sync, { hasSavedSync: true });
      expect(await queue.listPending()).toMatchObject([
        {
          id: "$ciphertext",
          laneKey: `room:${roomId}`,
          payload: { version: 1, roomId, event: { ...event, room_id: roomId } },
        },
        {
          id: "$left",
          laneKey: "room:!left:example.org",
          payload: { event: { event_id: "$left" } },
        },
      ]);
    } finally {
      await monitor.stop();
    }
  });

  it("retains failed decryption for a later successful retry and adopts only once", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const queue = createQueue();
    const event = encryptedEvent("$retry-decryption", now);
    const client = createClient();
    client.crypto = createMatrixCryptoFacade({
      client: { getCrypto: () => undefined, getUserId: () => null },
      verificationManager: new MatrixVerificationManager(),
      recoveryKeyStore: new MatrixRecoveryKeyStore(),
      downloadContent: async () => Buffer.alloc(0),
    });
    const failed = new MatrixEvent({
      ...event,
      type: "m.room.message",
      content: { msgtype: "m.bad.encrypted", body: "Synthetic missing room key" },
    });
    vi.spyOn(failed, "isDecryptionFailure").mockReturnValue(true);
    const hydrate = vi.spyOn(client, "hydrateEvents").mockResolvedValue([matrixEventToRaw(failed)]);
    const dispatch = vi.fn(
      async (_room: string, _event: MatrixRawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await lifecycle.onAdopted();
      },
    );
    const params = { accountId: "default", client, startupMs: now, queue, dispatch };
    const first = createMatrixIngressMonitor(params);
    try {
      await first.admitSync(matrixSyncResponse("cursor", roomId, event, "previous"), {
        hasSavedSync: true,
      });
      first.start();
      await first.waitForIdle();
      expect(dispatch).not.toHaveBeenCalled();
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listPending()).toMatchObject([
        { id: event.event_id, payload: { event }, attempts: 1 },
      ]);
    } finally {
      await first.stop();
    }

    const clear = matrixEventToRaw(
      new MatrixEvent({
        ...event,
        type: "m.room.message",
        content: { msgtype: "m.text", body: "Decrypted fixture" },
      }),
    );
    hydrate.mockResolvedValue([clear]);
    clock.mockReturnValue(now + 2_000);
    const retry = createMatrixIngressMonitor(params);
    try {
      retry.start();
      await retry.waitForIdle();
      await retry.admitSync(matrixSyncResponse("replay", roomId, event, "previous"), {
        hasSavedSync: true,
      });
      await retry.waitForIdle();
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(roomId, clear, expect.any(Object));
      expect(hydrate).toHaveBeenCalledTimes(2);
      expect(await queue.listPending()).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
    } finally {
      await retry.stop();
    }
  });

  it.each(["pending", "claimed"] as const)(
    "preserves timeline order across batches and restart with a %s tail",
    async (headState) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const queue = createQueue(() => now);
      const event = {
        event_id: "$z-first",
        origin_server_ts: now,
        sender: "@alice:example.org",
        type: "m.room.message",
        content: { msgtype: "m.text", body: "First" },
      };
      const sync = matrixSyncResponse("first-batch", roomId, event, "previous");
      sync.rooms.join[roomId]!.timeline!.events.push({ ...event, event_id: "$a-second" });
      const delivered: string[] = [];
      const params = {
        accountId: "default",
        client: createClient(),
        startupMs: 0,
        queue,
        dispatch: async (
          _room: string,
          raw: MatrixRawEvent,
          lifecycle: ChannelIngressMonitorLifecycle,
        ) => {
          delivered.push(raw.event_id!);
          await lifecycle.onAdopted();
        },
      };
      const first = createMatrixIngressMonitor(params);
      await first.admitSync(sync, { hasSavedSync: true });
      await first.stop();
      if (headState === "claimed") {
        await queue.claim("$a-second", { ownerId: "2147483647:0:dead-worker" });
      }

      const restarted = createMatrixIngressMonitor(params);
      try {
        await restarted.admitSync(
          matrixSyncResponse("second-batch", roomId, { ...event, event_id: "$0-third" }, "next"),
          { hasSavedSync: true },
        );
        restarted.start();
        await restarted.waitForIdle();
        expect(delivered).toEqual(["$z-first", "$a-second", "$0-third"]);
      } finally {
        await restarted.stop();
      }
    },
  );
});
