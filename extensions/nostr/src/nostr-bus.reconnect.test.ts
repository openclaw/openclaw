// Nostr tests cover relay reconnects against a real loopback relay socket.
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { encrypt } from "nostr-tools/nip04";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
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

/** Minimal NIP-01 relay: records DM subscriptions, answers every REQ with EOSE. */
async function startLoopbackRelay() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });
  const dmSubscriptions: Array<{ socket: WebSocket; id: string; since?: number }> = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw);
      const [type, id, ...filters] = JSON.parse(text.toString("utf8")) as [
        string,
        string,
        ...unknown[],
      ];
      if (type !== "REQ") {
        return;
      }
      const dmFilter = (filters as Array<{ kinds?: number[]; since?: number }>).find((filter) =>
        filter.kinds?.includes(4),
      );
      if (dmFilter) {
        dmSubscriptions.push({ socket, id, since: dmFilter.since });
      }
      socket.send(JSON.stringify(["EOSE", id]));
    });
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    dmSubscriptions,
    publishToLatest(event: unknown) {
      const latest = dmSubscriptions.at(-1);
      latest?.socket.send(JSON.stringify(["EVENT", latest.id, event]));
    },
    dropConnections() {
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

function createDm(text: string) {
  const senderKey = generateSecretKey();
  return finalizeEvent(
    {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", BOT_PUBKEY]],
      content: encrypt(senderKey, BOT_PUBKEY, text),
    },
    senderKey,
  );
}

describe("startNostrBus relay reconnect", () => {
  let stateDir = "";

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
  });

  afterEach(async () => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("resubscribes after the relay drops the socket and receives the next DM", async () => {
    const relay = await startLoopbackRelay();
    const received: string[] = [];
    const ingressTasks: Promise<void>[] = [];
    const errors: string[] = [];
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      relays: [relay.url],
      onMessage: async (_pubkey, text) => {
        received.push(text);
      },
      trackIngressTask: (task) => ingressTasks.push(task),
      onError: (error) => errors.push(error.message),
    });
    try {
      await vi.waitFor(() => expect(relay.dmSubscriptions).toHaveLength(1), { timeout: 30_000 });
      const beforeDrop = createDm("before the drop");
      relay.publishToLatest(beforeDrop);
      await vi.waitFor(() => expect(received).toEqual(["before the drop"]), { timeout: 30_000 });

      // Fake only the reconnect backoff; the socket I/O stays real.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      relay.dropConnections();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();

      await vi.waitFor(() => expect(relay.dmSubscriptions).toHaveLength(2), { timeout: 5_000 });
      // The resubscription replays a bounded window (newest event minus the 120 s lookback),
      // not the hour of history since startup.
      const [first, second] = relay.dmSubscriptions;
      expect(second?.since).toBe(beforeDrop.created_at - 120);
      expect(second?.since).toBeGreaterThan(first?.since ?? Infinity);
      relay.publishToLatest(createDm("after the drop"));
      await vi.waitFor(() => expect(received).toEqual(["before the drop", "after the drop"]), {
        timeout: 30_000,
      });
      expect(errors).toEqual([expect.stringMatching(/^Subscription closed: .+; resubscribing$/)]);
    } finally {
      await Promise.allSettled(ingressTasks);
      await bus.close();
      await relay.close();
    }
  });
});
