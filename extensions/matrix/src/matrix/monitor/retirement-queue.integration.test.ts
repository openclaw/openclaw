import http from "node:http";
import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it } from "vitest";
import { MatrixClient } from "../sdk.js";
import { MatrixMessageWireDispatchGuards } from "../sdk/message-wire-dispatch.js";
import { captureMatrixSendCurrentness } from "../sdk/send-currentness.js";
import { MatrixSendScheduler } from "../sdk/send-scheduler.js";
import { createMatrixGuardedFetch } from "../sdk/transport.js";
import { withResolvedMatrixSendClient } from "../send/client.js";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

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
  let server: http.Server | undefined;
  let client: MatrixClient | undefined;

  afterEach(async () => {
    await client?.stopWithoutPersist().catch(() => {});
    client = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("sends the active sibling when the queue owner retires first", async () => {
    const seen: string[] = [];
    server = http.createServer((request, response) => {
      seen.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ event_id: "$ok" }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("proof server did not bind");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    client = new MatrixClient(baseUrl, "fixture-token", {
      userId: "@bot:example.org",
      deviceId: "fixture",
      encryption: false,
      autoBootstrapCrypto: false,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    const matrixClient = client;
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
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const owner = createMatrixMonitorTaskRunner({ logger, logVerboseMessage: () => {} });
    const sibling = createMatrixMonitorTaskRunner({ logger, logVerboseMessage: () => {} });
    const sendQueued = (monitor: typeof owner, txnId: string) =>
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
              await pending;
            },
          });
        }),
      );
    const ownerSend = sendQueued(owner, "txn-a");
    await holding.promise;
    const siblingQueued = createDeferred<void>();
    const siblingSend = sibling.runDetachedTask("txn-b", () =>
      withResolvedMatrixSendClient({ client: matrixClient }, async () => {
        const assertCurrent = captureMatrixSendCurrentness(matrixClient);
        await guards.run({
          transactionId: "txn-b",
          assertCurrent,
          run: async () => {
            const pending = scheduler.queueEvent(queuedMessage("txn-b"));
            if (!pending) {
              throw new Error("txn-b was not queued");
            }
            siblingQueued.resolve();
            await pending;
          },
        });
      }),
    );
    await siblingQueued.promise;
    expect(seen).toEqual([]);
    owner.close();
    release.resolve();
    await Promise.allSettled([ownerSend, siblingSend]);
    expect(seen.some((line) => line.includes("txn-b"))).toBe(true);
    expect(seen.some((line) => line.includes("txn-a"))).toBe(false);
    sibling.close();
  });
});
