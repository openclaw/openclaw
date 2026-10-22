import { finalizeEvent, getPublicKey } from "nostr-tools";
import { encrypt } from "nostr-tools/nip04";
import { npubEncode } from "nostr-tools/nip19";
import {
  buildChannelInboundEventContext,
  type dispatchInboundDirectDm as DispatchInboundDirectDm,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { getActiveNostrBuses, startNostrGatewayAccount } from "./gateway.js";
import { createNostrRelayFixture } from "./nostr-relay.test-harness.js";
import { setNostrRuntime } from "./runtime.js";
import { buildResolvedNostrAccount, TEST_HEX_PRIVATE_KEY_BYTES } from "./test-fixtures.js";
import type { ResolvedNostrAccount } from "./types.js";

const agent = vi.hoisted(() => ({
  dispatch: vi.fn<(params: Parameters<typeof DispatchInboundDirectDm>[0]) => Promise<void>>(),
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  dispatchInboundDirectDm: agent.dispatch,
}));

// Registered by the SQLite-owning outbound suite. Transport, bus, durable queue
// and Gateway policy resolution are real. Stub only downstream agent dispatch:
// no model call or full running server/reload is part of this local proof.
export function registerNostrGatewayAdmissionTests() {
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
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(failures, "Gateway fixture cleanup failed");
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
        cleanup();
      }
    }),
  );
  const approved = new Uint8Array(32).fill(2);
  const other = new Uint8Array(32).fill(3);
  const recipient = getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES);
  const key = getPublicKey(approved);
  function dm(sender: Uint8Array, text: string) {
    return finalizeEvent(
      {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", recipient]],
        content: encrypt(sender, recipient, text),
      },
      sender,
    );
  }
  async function start(config: ResolvedNostrAccount["config"], stateDir: string) {
    const relay = await createNostrRelayFixture();
    const abort = new AbortController();
    const started = createDeferred<void>();
    const enqueued = createDeferred<void>();
    const delivered = createDeferred<void>();
    const blocked = createDeferred<void>();
    const ids: string[] = [];
    const errors: string[] = [];
    agent.dispatch.mockReset();
    agent.dispatch.mockImplementation(async () => {
      delivered.resolve();
    });
    const dispatch = agent.dispatch;
    const runtime = createPluginRuntimeMock({
      state: {
        openChannelIngressQueue<T, M = unknown, C = unknown>() {
          const queue = createChannelIngressQueueForTests<T, M, C>({
            channelId: "nostr",
            accountId: "default",
            stateDir,
          });
          const enqueue = queue.enqueue.bind(queue);
          queue.enqueue = async (...args) => {
            const result = await enqueue(...args);
            ids.push(args[0]);
            enqueued.resolve();
            return result;
          };
          const enqueueAndClaim = queue.enqueueAndClaim?.bind(queue);
          if (enqueueAndClaim) {
            queue.enqueueAndClaim = async (...args) => {
              const result = await enqueueAndClaim(...args);
              ids.push(args[0]);
              enqueued.resolve();
              return result;
            };
          }
          return queue;
        },
      },
      channel: {
        inbound: { buildContext: buildChannelInboundEventContext },
      },
    });
    setNostrRuntime(runtime);
    const context = createStartAccountContext({
      account: buildResolvedNostrAccount({ publicKey: recipient, relays: [relay.url], config }),
      cfg: { channels: { nostr: config } },
      abortSignal: abort.signal,
    });
    context.channelRuntime = runtime.channel;
    context.log = {
      warn: vi.fn(),
      debug: (message) => {
        if (message.includes("blocked Nostr sender")) {
          blocked.resolve();
        }
      },
      info: (message) => {
        if (message.includes("Nostr provider started")) {
          started.resolve();
        }
      },
      error: (message) => {
        errors.push(message);
      },
    };
    const task = startNostrGatewayAccount(context);
    // Register teardown before waiting for startup; failures cannot leak a socket or monitor.
    const stop = async () => {
      abort.abort();
      try {
        await task;
      } finally {
        await relay.close();
      }
      expect(relay.errors).toEqual([]);
      expect(relay.endpoints()).toEqual({ listening: false, connections: 0, clients: 0 });
    };
    stops.push(stop);
    await withTimeout(Promise.all([started.promise, relay.subscribed]), 5000);
    return { relay, ids, errors, dispatch, enqueued, delivered, blocked, stop };
  }

  it("delivers through Gateway after a 200-event signed outsider burst with normalized literal keys", async () => {
    const h = await start(
      {
        dmPolicy: "allowlist",
        allowFrom: [key.toUpperCase(), " nostr:" + npubEncode(key) + " ", key],
      },
      dirs.make("nostr-gateway-admission-"),
    );
    const denied = Array.from({ length: 200 }, (_, i) => dm(other, "denied-" + i));
    const allowed = dm(approved, "approved through Gateway");
    const forged = { ...dm(other, "forged"), pubkey: key };
    h.relay.sendIncoming([...denied, forged, allowed]);
    await withTimeout(h.delivered.promise, 5000);
    await h.stop();
    expect(h.errors).toEqual([]);
    expect(h.ids).toEqual([allowed.id]);
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        rawBody: "approved through Gateway",
        senderId: key,
      }),
    );
    expect(h.relay.subscriptions).toEqual([[{ kinds: [4], "#p": [recipient], since: 0 }]]);
    expect(getActiveNostrBuses().has("default")).toBe(false);
  });

  it("recreates Gateway admission after abort/join and an allowlist key change", async () => {
    const stateDir = dirs.make("nostr-gateway-recreate-");
    const first = await start({ dmPolicy: "allowlist", allowFrom: [key] }, stateDir);
    const oldAllowed = dm(approved, "old allowed");
    first.relay.sendIncoming([oldAllowed]);
    await withTimeout(first.delivered.promise, 5000);
    await first.stop();
    expect(first.ids).toEqual([oldAllowed.id]);
    expect(getActiveNostrBuses().has("default")).toBe(false);
    const next = await start({ dmPolicy: "allowlist", allowFrom: [getPublicKey(other)] }, stateDir);
    const newAllowed = dm(other, "new allowed");
    next.relay.sendIncoming([dm(approved, "old denied after restart"), newAllowed]);
    await withTimeout(next.delivered.promise, 5000);
    await next.stop();
    expect(next.errors).toEqual([]);
    expect(next.ids).toEqual([newAllowed.id]);
    expect(next.dispatch).toHaveBeenCalledOnce();
  });

  it("keeps canonical Gateway authorization authoritative for a matching admission author", async () => {
    const config: ResolvedNostrAccount["config"] = { dmPolicy: "allowlist", allowFrom: [key] };
    const h = await start(config, dirs.make("nostr-gateway-policy-"));
    // Exercise the existing current-policy recheck, not a running-server reload.
    config.dmPolicy = "disabled";
    const event = dm(approved, "matching hint is not authorization");
    h.relay.sendIncoming([event]);
    await withTimeout(h.blocked.promise, 5000);
    await h.stop();
    expect(h.ids).toEqual([event.id]);
    expect(h.errors).toEqual([]);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { dmPolicy: "allowlist", allowFrom: [] },
    { dmPolicy: "allowlist", allowFrom: [key, 123] },
    { dmPolicy: "allowlist", allowFrom: [key, "*"] },
    { dmPolicy: "allowlist", allowFrom: [key, "accessGroup:friends"] },
    { dmPolicy: "allowlist", allowFrom: [key, "invalid"] },
    { dmPolicy: "allowlist", allowFrom: [key, ""] },
    { dmPolicy: "pairing", allowFrom: [key] },
    { dmPolicy: "open", allowFrom: ["*"] },
    { dmPolicy: "disabled", allowFrom: [key] },
    { allowFrom: [key] },
  ] as const)(
    "durably admits nonmembers through Gateway when optimization is ineligible: %j",
    async (config) => {
      const h = await start(
        { ...config, allowFrom: [...config.allowFrom] },
        dirs.make("nostr-gateway-fallback-"),
      );
      const event = dm(other, "canonical policy owns this event");
      h.relay.sendIncoming([event]);
      await withTimeout(h.enqueued.promise, 5000);
      if (config.dmPolicy === "disabled") {
        await withTimeout(h.blocked.promise, 5000);
      }
      await h.stop();
      expect(h.ids).toEqual([event.id]);
      // Admission is not authorization: the disabled policy must never dispatch.
      if (config.dmPolicy === "disabled") {
        expect(h.dispatch).not.toHaveBeenCalled();
      }
    },
  );
}
