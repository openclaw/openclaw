import { randomUUID } from "node:crypto";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import type { BuzzBus } from "./buzz-bus.js";
import { createBuzzRelayFixture, useBuzzRelayTestHarness } from "./buzz-relay.test-harness.js";
import { startBuzzGatewayAccount } from "./gateway.js";
import { setBuzzRuntime } from "./runtime.js";
import { resolveBuzzAccount } from "./types.js";

let fixture: Awaited<ReturnType<typeof createBuzzRelayFixture>>;
let cleanupAccount: (() => Promise<void>) | undefined;
const { messages, fatal, startBus, closeBus } = useBuzzRelayTestHarness(
  (relay) => {
    fixture = relay;
    cleanupAccount = undefined;
    return {};
  },
  {
    beforeClose: async () => {
      await cleanupAccount?.();
    },
    afterClose: closeOpenClawStateDatabaseAsync,
  },
);

function member(bus: BuzzBus, id = fixture.senderPublicKey) {
  return bus.directory
    .listGroupMembers({ groupId: fixture.roomId })
    .find((entry) => entry.id === id);
}

const initialRoster = () => fixture.events.find((event) => event.kind === 39002)!;
const barrier = (bus: BuzzBus, text: string) => bus.sendText({ channelId: fixture.roomId, text });

function membershipChange(
  type: "member_joined" | "member_removed",
  createdAt: number,
  target = fixture.senderPublicKey,
) {
  return fixture.signRelay({
    kind: 40099,
    created_at: createdAt,
    content: JSON.stringify({ type, target }),
    tags: [["h", fixture.roomId]],
  });
}

function promotedRoster(initial: (typeof fixture.events)[number]) {
  return {
    ...initial,
    created_at: initial.created_at + 1,
    tags: initial.tags.map((tag) =>
      tag[0] === "p" && tag[1] === fixture.senderPublicKey
        ? ["p", fixture.senderPublicKey, "", "bot"]
        : tag,
    ),
  };
}

it("delivers live messages on the room-scoped roster subscription", async () => {
  const bus = await startBus();
  fixture.sendMessage("live after roster subscription");
  await vi.waitFor(() => expect(messages).toEqual(["live after roster subscription"]));
  const initial = initialRoster();
  const roster = promotedRoster(initial);
  const valid = fixture.signRelay(roster);
  fixture.sendUnchecked({ ...valid, sig: "0".repeat(128) });
  fixture.sendUnchecked(
    fixture.signRelay({
      ...roster,
      tags: roster.tags.map((tag) => (tag[0] === "d" ? ["d", randomUUID()] : tag)),
    }),
  );
  await barrier(bus, "invalid roster ordering barrier");
  expect(member(bus)?.raw).toMatchObject({ role: "member" });
  fixture.broadcast(valid);
  await vi.waitFor(() => expect(member(bus)?.raw).toMatchObject({ role: "bot" }));
});

it("keeps removal denied through stale snapshots and accepts a confirmed rejoin", async () => {
  const bus = await startBus();
  const initial = initialRoster();
  const query = fixture.pauseNextMembershipQuery();
  fixture.broadcast(membershipChange("member_removed", Math.floor(Date.now() / 1000)));
  await query.started;
  fixture.broadcast(initial);
  fixture.sendMessage("removed sender");
  query.release();
  await barrier(bus, "removal ordering barrier");
  expect(messages).toEqual([]);
  expect(member(bus)).toBeUndefined();

  fixture.broadcast(membershipChange("member_joined", initial.created_at + 1));
  fixture.broadcast(fixture.signRelay({ ...initial, created_at: initial.created_at + 1 }));
  await vi.waitFor(() => expect(member(bus)).toBeDefined(), { timeout: 6000 });
  fixture.sendMessage("confirmed rejoin");
  await vi.waitFor(() => expect(messages).toEqual(["confirmed rejoin"]));
  expect(fatal).toEqual([]);
});

it("recovers silent presence without replaying pre-activation messages", async ({ signal }) => {
  fixture.setPresenceMode("silent");
  fixture.sendMessage("pre-activation", Math.floor(Date.now() / 1000) - 60);
  const runtime = createPluginRuntimeMock();
  runtime.state.openKeyedStore = (options) => createPluginStateKeyedStoreForTests("buzz", options);
  setBuzzRuntime(runtime);
  const handled: string[] = [];
  const delivered = new Map([
    ["before stall", createDeferred<void>()],
    ["during reconnect", createDeferred<void>()],
  ]);
  vi.mocked(runtime.channel.inbound.dispatch).mockImplementation(async (params) => {
    handled.push(String(params.ctxPayload.RawBody));
    await params.delivery.deliver({ text: "gateway socket reply" }, { kind: "final" });
    delivered.get(String(params.ctxPayload.RawBody))?.resolve();
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: params.ctxPayload,
      routeSessionKey: params.route.sessionKey,
      dispatchResult: { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
    };
  });
  const cfg = {
    channels: {
      buzz: {
        relayUrl: fixture.relayUrl,
        privateKey: fixture.botPrivateKey,
        groupPolicy: "open",
        groups: { [fixture.roomId]: { requireMention: false } },
      },
    },
  } satisfies OpenClawConfig;
  const abort = new AbortController();
  const states: string[] = [];
  const ready = [createDeferred<void>(), createDeferred<void>()] as const;
  const ctx = createStartAccountContext({
    account: resolveBuzzAccount({ cfg }),
    cfg,
    abortSignal: abort.signal,
    statusPatchSink: (next) => {
      if (next.lifecycle) {
        states.push(next.lifecycle);
      }
      if (next.lifecycle === "ready") {
        ready[states.filter((state) => state === "ready").length - 1]?.resolve();
      }
      if (next.lifecycle === "recovering") {
        fixture.setPresenceMode("accept");
        fixture.sendMessage("during reconnect");
      }
    },
  });
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const lifecycle = startBuzzGatewayAccount({ ...ctx, scheduler });
  const stoppedBeforeReady = lifecycle.then(() => {
    throw new Error("Buzz account stopped before becoming ready");
  });
  const waitFor = (promise: Promise<void>) =>
    withinTest(Promise.race([promise, stoppedBeforeReady]), signal);
  cleanupAccount = async () => {
    abort.abort();
    try {
      await lifecycle;
    } finally {
      await scheduler.stop();
    }
  };
  try {
    await waitFor(ready[0].promise);
    expect(states).toContain("ready");
    fixture.sendMessage("before stall");
    await waitFor(delivered.get("before stall")!.promise);
    expect(handled).toContain("before stall");
    // Start the silent heartbeat only after the pre-stall message has completed.
    await withinTest(Promise.resolve(clock.wake()), signal);
    await waitFor(ready[1].promise);
    await waitFor(delivered.get("during reconnect")!.promise);
    expect(fixture.authenticatedSessions()).toBe(2);
    expect(states.filter((state) => state === "ready")).toHaveLength(2);
    expect(states).toContain("recovering");
    expect(handled).toEqual(["before stall", "during reconnect"]);
    expect(
      fixture.received.filter((event) => event.content === "gateway socket reply"),
    ).toHaveLength(2);
  } finally {
    await cleanupAccount();
  }
}, 15000);

it("accepts a startup bot-join notification already reflected in the signed roster", async () => {
  const initial = initialRoster();
  vi.spyOn(Date, "now").mockReturnValue(initial.created_at * 1000);
  fixture.events.push(
    membershipChange("member_joined", Math.floor(Date.now() / 1000), fixture.botPublicKey),
  );
  const bus = await startBus();
  // Directory restoration proves self-membership refresh settled rather than timed out.
  await vi.waitFor(() => expect(member(bus, fixture.botPublicKey)).toBeDefined(), {
    timeout: 6500,
  });
  expect(fatal).toEqual([]);
}, 10000);

it("keeps explicit presence rejection nonfatal over a real socket", async () => {
  fixture.setPresenceMode("reject");
  const errors: Error[] = [];
  let turnSignal: AbortSignal | undefined;
  const bus = await startBus({
    onMessage: async (message, _bus, signal) => {
      messages.push(message.text);
      turnSignal = signal;
    },
    onPresenceError: (error) => errors.push(error),
    onFatalError: (error) => {
      fatal.push(error);
      void closeBus();
    },
  });
  fixture.sendMessage("socket canary");
  await vi.waitFor(() => expect(messages).toEqual(["socket canary"]));
  expect(fixture.authenticatedSessions()).toBe(1);
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  expect(fatal).toEqual([]);
  expect(turnSignal?.aborted).toBe(false);
  await barrier(bus, "healthy after rejection");
  expect(fixture.received.some((event) => event.content === "healthy after rejection")).toBe(true);
}, 12000);

it("keeps the signed role when an older query completes after the push", async () => {
  const bus = await startBus();
  const initial = initialRoster();
  const change = membershipChange("member_joined", Math.floor(Date.now() / 1000));
  const query = fixture.pauseNextMembershipQuery();
  fixture.broadcast(change);
  const updated = fixture.signRelay(promotedRoster(initial));
  await query.started;
  fixture.broadcast(updated);
  fixture.broadcast(change);
  await vi.waitFor(() => expect(member(bus)?.raw).toMatchObject({ role: "bot" }));
  query.release();
  // A publish acknowledgement follows the old query frames on this socket.
  await barrier(bus, "query ordering barrier");
  expect(member(bus)?.raw).toMatchObject({ role: "bot" });
});
