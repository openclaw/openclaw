import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { MatrixClient } from "../sdk.js";
import { MatrixMessageWireDispatchGuards } from "../sdk/message-wire-dispatch.js";
import { captureMatrixSendCurrentness } from "../sdk/send-currentness.js";
import { MatrixSendScheduler } from "../sdk/send-scheduler.js";
import { createMatrixGuardedFetch } from "../sdk/transport.js";
import { withResolvedMatrixSendClient } from "../send/client.js";
import { createRetirementTaskRunner, useRetirementServer } from "./retirement.test-support.js";

function queuedMessage(txnId: string): MatrixEvent {
  const event = new MatrixEvent({
    type: "m.room.message",
    room_id: "!room:example.org",
    content: { msgtype: "m.text", body: txnId },
    txn_id: txnId,
  });
  event.setTxnId(txnId);
  return event;
}

describe("Matrix retirement queue", () => {
  const { seen, start } = useRetirementServer({ event_id: "$ok" });

  it.each(["owner", "sibling"] as const)(
    "sends only the active monitor when %s retires",
    async (retired) => {
      const { client: matrixClient, baseUrl } = await start(MatrixClient);
      const fetchFn = createMatrixGuardedFetch({ ssrfPolicy: { allowPrivateNetwork: true } });
      const guards = new MatrixMessageWireDispatchGuards();
      const scheduler = new MatrixSendScheduler((event) =>
        guards.wasCurrentnessRejected(event.getTxnId()),
      );
      const holding = createDeferred<void>();
      const release = createDeferred<void>();
      const sendUrl = (txnId: string) =>
        `${baseUrl}/_matrix/client/v3/rooms/%21room%3Aexample.org/send/m.room.message/${txnId}`;
      scheduler.setProcessFunction(async (event) => {
        const txnId = event.getTxnId();
        if (!txnId) {
          throw new Error("queued event has no transaction id");
        }
        if (txnId === "txn-a") {
          holding.resolve();
          await release.promise;
        }
        guards.captureCurrentness(sendUrl(txnId), { method: "PUT" }, undefined)?.();
        const response = await fetchFn(sendUrl(txnId), { method: "PUT", body: "{}" });
        if (!response.ok) {
          throw new Error(`send failed with ${response.status}`);
        }
        return { event_id: `$${txnId}` };
      });
      const owner = createRetirementTaskRunner();
      const sibling = createRetirementTaskRunner();
      const sendQueued = (monitor: typeof owner, txnId: string, onQueued = () => {}) =>
        monitor.runDetachedTask(txnId, () =>
          withResolvedMatrixSendClient({ client: matrixClient }, async () => {
            const assertCurrent = captureMatrixSendCurrentness(matrixClient);
            await guards.run({
              transactionId: txnId,
              assertCurrent,
              run: async () => {
                const pending = scheduler.queueEvent(queuedMessage(txnId));
                if (!pending) {
                  throw new Error(`${txnId} was not queued`);
                }
                onQueued();
                await pending;
              },
            });
          }),
        );
      const ownerSend = sendQueued(owner, "txn-a");
      await holding.promise;
      const siblingQueued = createDeferred<void>();
      const siblingSend = sendQueued(sibling, "txn-b", () => siblingQueued.resolve());
      await siblingQueued.promise;
      expect(seen).toEqual([]);
      (retired === "owner" ? owner : sibling).close();
      release.resolve();
      await Promise.allSettled([ownerSend, siblingSend]);
      expect(seen.some((line) => line.includes("txn-b"))).toBe(retired === "owner");
      expect(seen.some((line) => line.includes("txn-a"))).toBe(retired === "sibling");
      owner.close();
      sibling.close();
    },
  );
});
