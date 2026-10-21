import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { SqliteBackedMatrixSyncStore } from "../client/file-sync-store.js";
import { matrixSyncResponse, useSyncStoreFixture } from "../client/sync-store.test-support.js";
import { MatrixClient, type MatrixRawEvent } from "../sdk.js";
import { createMatrixIngressMonitor } from "./ingress.js";

type Dispatch = Parameters<typeof createMatrixIngressMonitor>[0]["dispatch"];
describe("Matrix inbound restart recovery", () => {
  const storage = useSyncStoreFixture("openclaw-matrix-inbound-restart-");
  const roomId = "!room:example.org";
  const event = {
    event_id: "$unadopted",
    sender: "@alice:example.org",
    origin_server_ts: 1_000,
    type: "m.room.message",
    content: { msgtype: "m.text", body: "Keep this pending message" },
  };
  const response = matrixSyncResponse("cursor-after-message", roomId, event, "previous");
  const createQueue = () =>
    createChannelIngressQueueForTests<{
      version: 1;
      roomId: string;
      event: MatrixRawEvent;
    }>({ channelId: "matrix", accountId: "default", stateDir: storage.root });
  async function openMonitor(startupMs: number, dispatch: Dispatch) {
    const store = await SqliteBackedMatrixSyncStore.create(storage.root);
    const client = new MatrixClient("https://example.org", "synthetic-token", {
      userId: "@bot:example.org",
      syncStore: store,
    });
    const monitor = createMatrixIngressMonitor({
      accountId: "default",
      client,
      startupMs,
      queue: createQueue(),
      dispatch,
    });
    const unbind = await client.bindSyncIngress(monitor.admitSync);
    return { ...monitor, store, unbind };
  }
  async function closeDatabase() {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }
  const adoptingDispatch = (adopted?: ReturnType<typeof createDeferred<void>>) =>
    vi.fn<Dispatch>(async (_room, _event, lifecycle) => {
      await lifecycle.onAdopted();
      adopted?.resolve();
    });
  async function expectDrained() {
    expect(await createQueue().listPending()).toEqual([]);
    expect(await createQueue().listClaims()).toEqual([]);
  }

  it("keeps first-login history excluded across sync batches and cached replay", async () => {
    const dispatch = adoptingDispatch();
    const first = await openMonitor(2_000, dispatch);
    await first.store.setSyncData(response);
    const lateRoomId = "!joined-later:example.org";
    const laterSync = matrixSyncResponse(
      "cursor-after-join",
      lateRoomId,
      { ...event, event_id: "$late-history" },
      "previous-join",
    );
    const freshEvent = { ...event, event_id: "$fresh", origin_server_ts: 2_500 };
    laterSync.rooms.join[lateRoomId]!.timeline!.events.push(freshEvent);
    await first.store.setSyncData(laterSync);
    await first.store.flush();
    first.unbind();
    await first.stop();
    await closeDatabase();
    const restarted = await openMonitor(3_000, dispatch);
    try {
      restarted.start();
      await restarted.waitForIdle();
      await restarted.store.setSyncData(response);
      await restarted.store.setSyncData(laterSync);
      await restarted.waitForIdle();
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(
        lateRoomId,
        expect.objectContaining(freshEvent),
        expect.any(Object),
      );
      await expectDrained();
    } finally {
      restarted.unbind();
      await restarted.stop();
    }
  });

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "replays an unadopted message exactly once after %s-style restart",
    async (shutdown) => {
      const deferred = createDeferred<void>();
      const first = await openMonitor(0, async (_room, _event, lifecycle) => {
        lifecycle.onDeferred();
        deferred.resolve();
      });
      await first.store.setSyncData(response);
      await first.store.flush();
      if (shutdown === "SIGTERM") {
        first.start();
        await deferred.promise;
        expect(await createQueue().listClaims()).toHaveLength(1);
        await first.stop();
      } else {
        // Leave a committed claim with a dead process owner, as a hard kill does.
        await createQueue().claim(event.event_id, { ownerId: "2147483647:0:dead-worker" });
      }
      first.unbind();
      await closeDatabase();
      const adopted = createDeferred<void>();
      const dispatch = adoptingDispatch(adopted);
      const restarted = await openMonitor(2_000, dispatch);
      try {
        restarted.start();
        await adopted.promise;
        // A server replay must not create another delivery after adoption.
        await restarted.store.setSyncData(response);
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(
          roomId,
          expect.objectContaining(event),
          expect.any(Object),
        );
        await expectDrained();
      } finally {
        restarted.unbind();
        await restarted.stop();
      }
    },
  );
});
