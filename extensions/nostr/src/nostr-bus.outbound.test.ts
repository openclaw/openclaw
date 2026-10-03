// Nostr outbound tests exercise signed EVENT/OK frames through the real pool.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getPublicKey } from "nostr-tools";
import { decrypt } from "nostr-tools/nip04";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nostrPlugin } from "./channel.js";
import { getActiveNostrBuses } from "./gateway.js";
import { startNostrBus } from "./nostr-bus.js";
import { createNostrRelayFixture, PREFIX_ACK_REASON } from "./nostr-relay.test-harness.js";
import { getNostrRuntime, setNostrRuntime } from "./runtime.js";
import {
  TEST_HEX_PRIVATE_KEY,
  TEST_HEX_PRIVATE_KEY_BYTES,
  buildResolvedNostrAccount,
  createConfiguredNostrCfg,
} from "./test-fixtures.js";

// Keep existing state persistence isolation; transport, signatures and NIP-04 are real.
vi.mock("./nostr-state-store.js", () => ({
  readNostrBusState: vi.fn(async () => null),
  writeNostrBusState: vi.fn(async () => {}),
  computeSinceTimestamp: vi.fn(() => 0),
  readNostrProfileState: vi.fn(async () => null),
  writeNostrProfileState: vi.fn(async () => {}),
}));

const RECIPIENT_KEY = new Uint8Array(32).fill(2);
const RECIPIENT_PUBKEY = getPublicKey(RECIPIENT_KEY);
let stateDir = "";
let stops: Array<() => Promise<void>> = [];
let relays: Array<Awaited<ReturnType<typeof createNostrRelayFixture>>> = [];

async function relay(options: Parameters<typeof createNostrRelayFixture>[0] = {}) {
  const result = await createNostrRelayFixture(options);
  relays.push(result);
  return result;
}

async function startBus(urls: string[]) {
  const bus = await startNostrBus({
    privateKey: TEST_HEX_PRIVATE_KEY,
    relays: urls,
    onMessage: async () => {},
  });
  stops.push(() => bus.close());
  return bus;
}

async function startRegisteredAccount(urls: string[]) {
  const cfg = createConfiguredNostrCfg({ relays: urls });
  const abort = new AbortController();
  const context = createStartAccountContext({
    cfg,
    account: buildResolvedNostrAccount({
      relays: urls,
      publicKey: getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES),
    }),
    abortSignal: abort.signal,
  });
  context.channelRuntime = getNostrRuntime().channel;
  const start = nostrPlugin.gateway?.startAccount;
  const send = nostrPlugin.message?.send?.text;
  if (!start || !send) {
    throw new Error("Nostr message registration is missing");
  }
  const task = start(context);
  stops.push(async () => {
    abort.abort();
    await task;
  });
  await vi.waitFor(() => expect(getActiveNostrBuses().has("default")).toBe(true));
  return (
    text: string,
    options: Pick<ChannelOutboundContext, "assertDirectAdapterHandoff" | "onPlatformSendDispatch">,
  ) => send({ cfg, to: RECIPIENT_PUBKEY, text, accountId: "default", ...options });
}

describe("Nostr outbound relay failover", () => {
  beforeEach(async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-outbound-"));
    stateDir = await fs.realpath(created);
    stops = [];
    relays = [];
    setNostrRuntime(
      createPluginRuntimeMock({
        state: {
          openChannelIngressQueue<TEnvelope, TMetadata = unknown, TCompletedMetadata = unknown>() {
            return createChannelIngressQueueForTests<TEnvelope, TMetadata, TCompletedMetadata>({
              channelId: "nostr",
              accountId: "default",
              stateDir,
            });
          },
        },
        channel: {
          inbound: { buildContext: buildChannelInboundEventContext },
          text: {
            resolveMarkdownTableMode: () => "off",
            convertMarkdownTables: (text: string) => text,
          },
        },
      }),
    );
  });

  afterEach(async () => {
    for (const entry of relays) {
      entry.releaseUpgrades();
    }
    const busResults = await Promise.allSettled(stops.map((stop) => stop()));
    const relayResults = await Promise.allSettled(relays.map((entry) => entry.close()));
    try {
      const failures = [...busResults, ...relayResults].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Nostr outbound cleanup failed");
      }
      for (const entry of relays) {
        expect(entry.endpoints()).toEqual({ listening: false, connections: 0, clients: 0 });
        expect(entry.errors).toEqual([]);
      }
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("accepts a real positive OK even when its reason starts with connection failure", async () => {
    const first = await relay({ reason: PREFIX_ACK_REASON });
    const second = await relay();
    const bus = await startBus([first.url, second.url]);

    const id = await bus.sendDm(RECIPIENT_PUBKEY, "hello");

    expect(first.events).toHaveLength(1);
    expect(first.acknowledgements).toEqual([["OK", id, true, PREFIX_ACK_REASON]]);
    expect(second.events).toEqual([]);
    expect(first.events[0]).toMatchObject({ id, kind: 4, tags: [["p", RECIPIENT_PUBKEY]] });
    expect(decrypt(RECIPIENT_KEY, bus.publicKey, first.events[0]!.content)).toBe("hello");
  });

  it("preserves real failures when every relay rejects", async () => {
    const first = await relay({ rejectUpgrade: true });
    const second = await relay({ accepted: false, reason: PREFIX_ACK_REASON });
    const bus = await startBus([first.url, second.url]);

    await expect(bus.sendDm(RECIPIENT_PUBKEY, "hello")).rejects.toThrow(
      `Failed to publish to any relay: ${PREFIX_ACK_REASON}`,
    );

    expect(first.events).toEqual([]);
    expect(second.events).toHaveLength(1);
    expect(second.acknowledgements).toEqual([
      ["OK", second.events[0]!.id, false, PREFIX_ACK_REASON],
    ]);
  });

  describe("registered message sender", () => {
    it("falls back past connection and publish failures, accounting only for EVENT handoffs", async () => {
      const refused = await relay({ rejectUpgrade: true });
      const first = await relay({ accepted: false, reason: PREFIX_ACK_REASON });
      const second = await relay();
      const send = await startRegisteredAccount([refused.url, first.url, second.url]);
      const onPlatformSendDispatch = vi.fn(async () => {});

      const result = await send("ordinary fallback", {
        assertDirectAdapterHandoff: () => {},
        onPlatformSendDispatch,
      });

      expect(refused.upgradeAttempts()).toBeGreaterThan(0);
      expect(refused.events).toEqual([]);
      expect(first.events).toHaveLength(1);
      expect(second.events).toEqual(first.events);
      expect(result).toMatchObject({ messageId: second.events[0]!.id });
      expect(result.receipt.parts[0]?.kind).toBe("text");
      expect(first.acknowledgements).toEqual([["OK", result.messageId, false, PREFIX_ACK_REASON]]);
      expect(second.acknowledgements).toEqual([["OK", result.messageId, true, "saved"]]);
      expect(
        decrypt(RECIPIENT_KEY, getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES), second.events[0]!.content),
      ).toBe("ordinary fallback");
      expect(onPlatformSendDispatch).toHaveBeenCalledTimes(2);
    });

    it.each([false, true])(
      "settles an in-flight acknowledgement after cancellation (accepted=%s)",
      async (accepted) => {
        const first = await relay({ accepted, holdAcknowledgements: true });
        const second = await relay();
        const send = await startRegisteredAccount([first.url, second.url]);
        const caller = new AbortController();
        const canceled = new Error("Nostr delivery canceled");
        const settled = send("canceled during relay response", {
          assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        }).catch((error: unknown) => error);
        await vi.waitFor(() => expect(first.events).toHaveLength(1));

        caller.abort(canceled);
        first.acknowledgeAll();
        const outcome = await settled;

        expect(second.events).toEqual([]);
        if (accepted) {
          expect(outcome).toMatchObject({ messageId: first.events[0]!.id });
        } else {
          expect(outcome).toBe(canceled);
        }
      },
    );

    it("isolates concurrent callers across a shared connection wait", async () => {
      const first = await relay({ holdUpgrades: true });
      const send = await startRegisteredAccount([first.url]);
      const caller = new AbortController();
      const canceled = new Error("Nostr delivery canceled during connection");
      const withdrawn = send("withdrawn", {
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      }).catch((error: unknown) => error);
      const current = send("still current", { assertDirectAdapterHandoff: () => {} });
      await vi.waitFor(() => expect(first.upgradeAttempts()).toBe(1));

      caller.abort(canceled);
      first.releaseUpgrades();
      const [withdrawnResult, currentResult] = await Promise.all([withdrawn, current]);

      expect(first.events).toHaveLength(1);
      expect(withdrawnResult).toBe(canceled);
      expect(currentResult).toMatchObject({ messageId: first.events[0]!.id });
      expect(
        decrypt(RECIPIENT_KEY, getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES), first.events[0]!.content),
      ).toBe("still current");
    });

    it.each(["cancellation", "failure"])(
      "stops before handoff on dispatch accounting %s",
      async (outcome) => {
        const first = await relay();
        const second = await relay();
        const send = await startRegisteredAccount([first.url, second.url]);
        const caller = new AbortController();
        const failure = new Error("Dispatch custody refresh failed");
        const onPlatformSendDispatch = vi.fn(async () => {
          await Promise.resolve();
          if (outcome === "failure") {
            throw failure;
          }
          caller.abort(failure);
        });

        await expect(
          send("canceled before handoff", {
            onPlatformSendDispatch,
            assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
          }),
        ).rejects.toBe(failure);

        expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
        expect(first.events).toEqual([]);
        expect(second.events).toEqual([]);
      },
    );
  });
});
