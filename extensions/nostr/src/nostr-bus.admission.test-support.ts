import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools";
import { encrypt } from "nostr-tools/nip04";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startNostrBus } from "./nostr-bus.js";
import { createNostrRelayFixture } from "./nostr-relay.test-harness.js";
import { setNostrRuntime } from "./runtime.js";
import { TEST_HEX_PRIVATE_KEY, TEST_HEX_PRIVATE_KEY_BYTES } from "./test-fixtures.js";

export function registerNostrAdmissionTests() {
  const approved = new Uint8Array(32).fill(2);
  const approvedPubkey = getPublicKey(approved);
  const recipient = getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES);
  const errors: string[] = [];
  let stateDir = "";
  let relay: Awaited<ReturnType<typeof createNostrRelayFixture>>;
  let bus: Awaited<ReturnType<typeof startNostrBus>> | undefined;
  const enqueuedIds: string[] = [];

  function dm(key: Uint8Array, text: string): Event {
    return finalizeEvent(
      {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", recipient]],
        content: encrypt(key, recipient, text),
      },
      key,
    );
  }

  beforeEach(async () => {
    errors.length = 0;
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nostr-admission-"));
    enqueuedIds.length = 0;
    setNostrRuntime(
      createPluginRuntimeMock({
        state: {
          openChannelIngressQueue<TPayload, TMetadata = unknown, TCompletedMetadata = unknown>() {
            const queue = createChannelIngressQueueForTests<
              TPayload,
              TMetadata,
              TCompletedMetadata
            >({ channelId: "nostr", accountId: "default", stateDir });
            const enqueue = queue.enqueue.bind(queue);
            queue.enqueue = (...args) => {
              enqueuedIds.push(args[0]);
              return enqueue(...args);
            };
            return queue;
          },
        },
      }),
    );
    relay = await createNostrRelayFixture();
  });
  afterEach(async () => {
    try {
      await bus?.close();
    } finally {
      bus = undefined;
      await relay.close();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
    expect(relay.errors).toEqual([]);
  });

  it.each([0, 200])(
    "delivers approved DM after %i signed denied events without persisting them",
    async (count) => {
      const onMessage = vi.fn(async () => {});
      const authorizeSender = vi.fn(
        async ({ senderPubkey }: { senderPubkey: string }): Promise<"allow" | "block"> =>
          senderPubkey === approvedPubkey ? "allow" : "block",
      );
      const tasks: Promise<void>[] = [];
      const received = createDeferred<void>();
      let seen = 0;
      bus = await startNostrBus({
        privateKey: TEST_HEX_PRIVATE_KEY,
        onError: (error, context) => errors.push(context + ": " + error.message),
        accountId: "default",
        relays: [relay.url],
        admissionPubkeys: [approvedPubkey],
        onMessage,
        authorizeSender,
        onMetric: (event) => {
          if (event.name === "event.received" && ++seen === count + 1) {
            received.resolve();
          }
        },
        trackIngressTask: (task) => tasks.push(task),
      });
      await relay.subscribed;
      const denied = Array.from({ length: count }, (_, i) =>
        dm(new Uint8Array(32).fill(3 + Math.floor(i / 20)), "denied-" + i),
      );
      const allowed = dm(approved, "approved");
      // Re-signing with another key cannot claim the approved identity on the real transport.
      const forged = { ...dm(new Uint8Array(32).fill(20), "forged"), pubkey: approvedPubkey };
      relay.sendIncoming([...denied, forged, allowed]);
      await received.promise;
      await Promise.all(tasks);
      expect(seen).toBe(count + 1);
      expect(errors).toEqual([]);
      expect(enqueuedIds).toEqual([allowed.id]);
      expect(authorizeSender).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ senderPubkey: approvedPubkey }),
      );
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(
        approvedPubkey,
        "approved",
        expect.any(Function),
        expect.objectContaining({ eventId: allowed.id }),
        expect.any(Object),
      );
      expect(relay.subscriptions).toEqual([[{ kinds: [4], "#p": [recipient], since: 0 }]]);
    },
  );

  it("does not grant authorization to a matching literal author", async () => {
    const onMessage = vi.fn(async () => {});
    const done = createDeferred<void>();
    const authorizeSender = vi.fn(async () => "block" as const);
    bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onError: (error, context) => errors.push(context + ": " + error.message),
      relays: [relay.url],
      admissionPubkeys: [approvedPubkey],
      onMessage,
      authorizeSender,
      trackIngressTask: (task) => {
        void task.then(() => done.resolve());
      },
    });
    await relay.subscribed;
    relay.sendIncoming([dm(approved, "not authorized")]);
    await done.promise;
    expect(errors).toEqual([]);
    expect(authorizeSender).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("retains the default 200-event allowed admission cap and resets after 60 seconds", async () => {
    const keys = Array.from({ length: 11 }, (_, i) => new Uint8Array(32).fill(30 + i));
    const onMessage = vi.fn(async () => {});
    let completed = createDeferred<void>();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      bus = await startNostrBus({
        privateKey: TEST_HEX_PRIVATE_KEY,
        onError: (error, context) => errors.push(context + ": " + error.message),
        accountId: "default",
        relays: [relay.url],
        admissionPubkeys: keys.map(getPublicKey),
        onMessage,
        trackIngressTask: (task) => {
          const completion = completed;
          void task.then(() => completion.resolve());
        },
      });
      await relay.subscribed;
      for (let i = 0; i < 201; i++) {
        completed = createDeferred<void>();
        relay.sendIncoming([dm(keys[Math.floor(i / 20)]!, "allowed-" + i)]);
        await completed.promise;
      }
      expect(onMessage).toHaveBeenCalledTimes(200);
      clock.mockReturnValue(now + 60_001);
      completed = createDeferred<void>();
      relay.sendIncoming([dm(keys[10]!, "after rollover")]);
      await completed.promise;
      expect(onMessage).toHaveBeenCalledTimes(201);
    } finally {
      clock.mockRestore();
    }
  });
}
