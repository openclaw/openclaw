import { describe, expect, it, vi } from "vitest";
import { createSlackDurableIngress } from "./ingress.js";
import { withQueue } from "./ingress.test-support.js";

describe("Slack relay durable ingress", () => {
  const relayMessage = {
    type: "message",
    channel: "C_RELAY",
    team: "T_TEST",
    user: "U_TEST",
    ts: "1700000001.000200",
    text: "relayed",
  };

  it("dedupes a router redelivery by logical message identity, not delivery id", async () => {
    await withQueue(async (queue) => {
      const dispatched: unknown[] = [];
      const ingress = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 60_000,
        adoptionStallTimeoutMs: 5_000,
      });
      ingress.attachRelayDispatch(async (message) => {
        dispatched.push(message);
      });
      ingress.start();

      await ingress.acceptRelayEvent({ deliveryId: "delivery-1", message: relayMessage });
      await ingress.waitForIdle();
      await ingress.acceptRelayEvent({ deliveryId: "delivery-2", message: relayMessage });
      await ingress.waitForIdle();

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({ channel: "C_RELAY", text: "relayed" });
      await ingress.stop();
    });
  });

  it("retries a claimed relay event until a dispatcher attaches", async () => {
    await withQueue(async (queue) => {
      const detached = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 60_000,
        adoptionStallTimeoutMs: 5_000,
      });
      await detached.acceptRelayEvent({ deliveryId: "delivery-3", message: relayMessage });
      await detached.stop();

      const dispatched: unknown[] = [];
      const recovered = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 25,
        adoptionStallTimeoutMs: 5_000,
      });
      recovered.start();
      await recovered.waitForIdle();
      expect(dispatched).toHaveLength(0);

      recovered.attachRelayDispatch(async (message) => {
        dispatched.push(message);
      });
      await vi.waitFor(
        async () => {
          await recovered.waitForIdle();
          expect(dispatched).toHaveLength(1);
        },
        { timeout: 15_000, interval: 250 },
      );
      await recovered.stop();
    });
  });

  it("drops a malformed persisted row without blocking the next relay message", async () => {
    await withQueue(async (queue) => {
      const laneKey = "team:T_TEST:conversation:C_RELAY";
      await queue.enqueue(
        "relay:malformed",
        {
          version: 1,
          receivedAt: 1,
          kind: "relay",
          message: { channel: "C_RELAY", team: "T_TEST" },
        },
        { laneKey, receivedAt: 1 },
      );
      await queue.enqueue(
        "message:T_TEST:C_RELAY:1700000001.000200",
        { version: 1, receivedAt: 2, kind: "relay", message: relayMessage },
        { laneKey, receivedAt: 2 },
      );

      const dispatched: unknown[] = [];
      const ingress = createSlackDurableIngress({ accountId: "default", queue });
      ingress.attachRelayDispatch(async (message) => {
        dispatched.push(message);
      });
      ingress.start();
      await ingress.waitForIdle();

      expect(dispatched).toEqual([relayMessage]);
      expect(await queue.listPending()).toHaveLength(0);
      await ingress.stop();
    });
  });
});
