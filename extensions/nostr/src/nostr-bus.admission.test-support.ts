import { finalizeEvent, getPublicKey, type Event } from "nostr-tools";
import { encrypt } from "nostr-tools/nip04";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { startNostrBus } from "./nostr-bus.js";
import { createNostrRelayFixture } from "./nostr-relay.test-harness.js";
import { setNostrRuntime } from "./runtime.js";
import { TEST_HEX_PRIVATE_KEY, TEST_HEX_PRIVATE_KEY_BYTES } from "./test-fixtures.js";

const recipient = getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES);

export function useNostrAdmissionFixture() {
  const stops: Array<() => Promise<void>> = [];
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      try {
        const results = await Promise.allSettled(
          stops
            .splice(0)
            .toReversed()
            .map((stop) => stop()),
        );
        const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
        if (failures.length) {
          throw new AggregateError(failures, "Nostr fixture cleanup failed");
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
        cleanup();
      }
    }),
  );
  const directory = () => dirs.make("nostr-admission-");
  async function create(stateDir = directory()) {
    const relay = await createNostrRelayFixture();
    const ids: string[] = [],
      errors: string[] = [];
    const enqueued = createDeferred<void>();
    let join = async () => {};
    const stop = async () => {
      try {
        await join();
      } finally {
        await relay.close();
      }
      expect(relay.errors).toEqual([]);
      expect(relay.endpoints()).toEqual({ listening: false, connections: 0, clients: 0 });
    };
    stops.push(stop);
    const runtime = createPluginRuntimeMock({
      state: {
        openChannelIngressQueue<T, M = unknown, C = unknown>() {
          const queue = createChannelIngressQueueForTests<T, M, C>({
            channelId: "nostr",
            accountId: "default",
            stateDir,
          });
          const record = async <TResult>(id: string, work: Promise<TResult>) => {
            const result = await work;
            ids.push(id);
            enqueued.resolve();
            return result;
          };
          const enqueue = queue.enqueue.bind(queue);
          queue.enqueue = (...args) => record(args[0], enqueue(...args));
          const enqueueAndClaim = queue.enqueueAndClaim?.bind(queue);
          if (enqueueAndClaim) {
            queue.enqueueAndClaim = (...args) => record(args[0], enqueueAndClaim(...args));
          }
          return queue;
        },
      },
      channel: { inbound: { buildContext: buildChannelInboundEventContext } },
    });
    setNostrRuntime(runtime);
    return {
      relay,
      runtime,
      ids,
      errors,
      enqueued,
      stop,
      onStop: (work: typeof join) => {
        join = work;
      },
    };
  }
  return { create, directory };
}

export function createSignedNostrDm(key: Uint8Array, text: string): Event {
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

export function registerNostrAdmissionTests() {
  const fixture = useNostrAdmissionFixture();
  it("retains the default 200-event allowed admission cap and resets after 60 seconds", async () => {
    const h = await fixture.create();
    const onMessage = vi.fn(async () => {});
    let completed = createDeferred<void>();
    const keys = Array.from({ length: 11 }, (_, i) => new Uint8Array(32).fill(30 + i));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const bus = await startNostrBus({
        privateKey: TEST_HEX_PRIVATE_KEY,
        accountId: "default",
        relays: [h.relay.url],
        admissionPubkeys: keys.map(getPublicKey),
        onMessage,
        trackIngressTask: (task) => {
          const completion = completed;
          void task.then(() => completion.resolve());
        },
      });
      h.onStop(() => bus.close());
      await h.relay.subscribed;
      for (let i = 0; i < 201; i++) {
        completed = createDeferred<void>();
        h.relay.sendIncoming([createSignedNostrDm(keys[Math.floor(i / 20)]!, "allowed-" + i)]);
        await completed.promise;
      }
      expect(onMessage).toHaveBeenCalledTimes(200);
      clock.mockReturnValue(now + 60_001);
      completed = createDeferred<void>();
      h.relay.sendIncoming([createSignedNostrDm(keys[10]!, "after rollover")]);
      await completed.promise;
      expect(onMessage).toHaveBeenCalledTimes(201);
    } finally {
      clock.mockRestore();
    }
  });
}
