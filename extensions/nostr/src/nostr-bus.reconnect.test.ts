// Nostr tests cover relay resubscription against a real loopback relay socket.
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools";
import { encrypt } from "nostr-tools/nip04";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import * as guardPolicy from "openclaw/plugin-sdk/direct-dm-guard-policy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { PluginRuntime } from "../runtime-api.js";
import { startNostrBus } from "./nostr-bus.js";
import { setNostrRuntime } from "./runtime.js";
import { TEST_HEX_PRIVATE_KEY, TEST_HEX_PRIVATE_KEY_BYTES } from "./test-fixtures.js";

vi.mock("./nostr-state-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nostr-state-store.js")>()),
  readNostrBusState: vi.fn(async () => null),
  writeNostrBusState: vi.fn(async () => {}),
  computeSinceTimestamp: vi.fn(() => Math.floor(Date.now() / 1000) - 3_600),
  readNostrProfileState: vi.fn(async () => null),
  writeNostrProfileState: vi.fn(async () => {}),
}));

const BOT_PUBKEY = getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES);
const createGuardPolicy = guardPolicy.createDirectDmPreCryptoGuardPolicy;

/** NIP-01 relay that keeps published DMs and replays those at or after a REQ's `since`. */
async function startLoopbackRelay() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });
  const stored: Event[] = [];
  const live: Array<{ socket: WebSocket; id: string }> = [];
  const dmSubscriptions: Array<{ since?: number }> = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const [type, id, ...filters] = JSON.parse(String(raw)) as [string, string, ...unknown[]];
      if (type !== "REQ") {
        return;
      }
      const dmFilter = (filters as Array<{ kinds?: number[]; since?: number }>).find((filter) =>
        filter.kinds?.includes(4),
      );
      if (dmFilter) {
        dmSubscriptions.push({ since: dmFilter.since });
        live.push({ socket, id });
        for (const event of stored) {
          if (event.created_at >= (dmFilter.since ?? 0)) {
            socket.send(JSON.stringify(["EVENT", id, event]));
          }
        }
      }
      socket.send(JSON.stringify(["EOSE", id]));
    });
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    dmSubscriptions,
    publish(event: Event) {
      stored.push(event);
      for (const { socket, id } of live) {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(["EVENT", id, event]));
        }
      }
    },
    dropConnections() {
      live.length = 0;
      for (const socket of server.clients) {
        socket.terminate();
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function createDm(text: string, createdAt = Math.floor(Date.now() / 1000)): Event {
  const senderKey = generateSecretKey();
  return finalizeEvent(
    {
      kind: 4,
      created_at: createdAt,
      tags: [["p", BOT_PUBKEY]],
      content: encrypt(senderKey, BOT_PUBKEY, text),
    },
    senderKey,
  );
}

/** Drop the relay socket and run only the resubscribe backoff on fake timers; socket I/O stays real. */
async function dropAndResubscribe(relay: Awaited<ReturnType<typeof startLoopbackRelay>>) {
  const subscriptions = relay.dmSubscriptions.length;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  relay.dropConnections();
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(10_000);
  vi.useRealTimers();
  await vi.waitFor(() => expect(relay.dmSubscriptions).toHaveLength(subscriptions + 1), {
    timeout: 5_000,
  });
  return relay.dmSubscriptions.at(-1);
}

describe("startNostrBus relay resubscription", () => {
  let stateDir = "";
  let relay: Awaited<ReturnType<typeof startLoopbackRelay>>;
  let bus: Awaited<ReturnType<typeof startNostrBus>> | undefined;
  const received: string[] = [];
  const errors: string[] = [];
  const rejected: string[] = [];
  const ingressTasks: Promise<void>[] = [];

  const start = async (rateLimit?: { windowMs: number; maxGlobalPerWindow: number }) => {
    const policy = rateLimit && vi.spyOn(guardPolicy, "createDirectDmPreCryptoGuardPolicy");
    policy?.mockReturnValue(
      createGuardPolicy({
        rateLimit: { ...rateLimit, maxPerSenderPerWindow: 20, maxTrackedSenderKeys: 64 },
      }),
    );
    try {
      bus = await startNostrBus({
        privateKey: TEST_HEX_PRIVATE_KEY,
        relays: [relay.url],
        onMessage: async (_pubkey, text) => {
          received.push(text);
        },
        onRejected: (reason) => rejected.push(reason),
        trackIngressTask: (task) => ingressTasks.push(task),
        onError: (error) => errors.push(error.message),
      });
    } finally {
      policy?.mockRestore();
    }
    await vi.waitFor(() => expect(relay.dmSubscriptions).toHaveLength(1), { timeout: 30_000 });
  };

  beforeEach(async () => {
    stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-rc-")));
    const ingressQueue = createChannelIngressQueueForTests<Record<string, unknown>>({
      channelId: "nostr",
      accountId: "default",
      stateDir,
    });
    setNostrRuntime({
      state: { openChannelIngressQueue: () => ingressQueue },
    } as unknown as PluginRuntime);
    relay = await startLoopbackRelay();
    received.length = 0;
    errors.length = 0;
    rejected.length = 0;
    ingressTasks.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.allSettled(ingressTasks);
    await bus?.close();
    bus = undefined;
    await relay.close();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("resubscribes after the relay drops the socket and receives the next DM", async () => {
    await start();
    relay.publish(createDm("before the drop"));
    await vi.waitFor(() => expect(received).toEqual(["before the drop"]), { timeout: 30_000 });

    const droppedAt = Math.floor(Date.now() / 1000);
    const resubscription = await dropAndResubscribe(relay);
    // The replay starts just behind the outage, not at the hour of history since startup.
    expect(resubscription?.since).toBeGreaterThanOrEqual(droppedAt - 120);
    expect(resubscription?.since).toBeGreaterThan(relay.dmSubscriptions[0]?.since ?? Infinity);

    relay.publish(createDm("after the drop"));
    await vi.waitFor(() => expect(received).toEqual(["before the drop", "after the drop"]), {
      timeout: 30_000,
    });
    expect(errors).toEqual([expect.stringMatching(/^Subscription closed: /)]);
  });

  it("does not let replayed history use up admission for new DMs", async () => {
    await start({ windowMs: 60_000, maxGlobalPerWindow: 10 });
    for (let index = 0; index < 6; index += 1) {
      relay.publish(createDm(`old ${index}`));
    }
    await vi.waitFor(() => expect(received).toHaveLength(6), { timeout: 30_000 });

    // The resubscription replays all six; the window has room for exactly four more DMs.
    await dropAndResubscribe(relay);
    for (let index = 0; index < 4; index += 1) {
      relay.publish(createDm(`new ${index}`));
    }
    await vi.waitFor(() => expect(received).toHaveLength(10), { timeout: 30_000 });
    expect(received.slice(6).toSorted()).toEqual(["new 0", "new 1", "new 2", "new 3"]);
    expect(rejected).not.toContain("rate_limited");
  });

  it("replays a rate-limited DM after newer DMs were accepted", async () => {
    await start({ windowMs: 1_000, maxGlobalPerWindow: 2 });
    relay.publish(createDm("first"));
    relay.publish(createDm("second"));
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 30_000 });
    const limited = createDm("limited", Math.floor(Date.now() / 1000) - 200);
    relay.publish(limited);
    await vi.waitFor(() => expect(rejected).toContain("rate_limited"), { timeout: 30_000 });

    // A later DM is accepted once the window resets, moving live progress past the limited one.
    await new Promise((resolve) => {
      setTimeout(resolve, 1_100);
    });
    relay.publish(createDm("later"));
    await vi.waitFor(() => expect(received).toContain("later"), { timeout: 30_000 });

    const resubscription = await dropAndResubscribe(relay);
    expect(resubscription?.since).toBeLessThanOrEqual(limited.created_at);
    await vi.waitFor(() => expect(received).toContain("limited"), { timeout: 30_000 });
  });
});
