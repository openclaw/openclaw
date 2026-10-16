import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startBuzzBus, type BuzzBus } from "./buzz-bus.js";
import { createBuzzRelayFixture } from "./buzz-relay.test-harness.js";

type BuzzRelayFixture = Awaited<ReturnType<typeof createBuzzRelayFixture>>;
let stateDir: string;
let fixture: BuzzRelayFixture;
let skipped: ReturnType<typeof seedSkippedRoom>;
let messages: string[];
let fatal: Error[];
let cleanupBus: BuzzBus | undefined;

beforeEach(async () => {
  // openclaw-temp-dir: allow extension tests cannot import root test helpers.
  stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-room-restoration-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  cleanupBus = undefined;
  messages = [];
  fatal = [];
  fixture = await createBuzzRelayFixture();
  skipped = seedSkippedRoom();
});
afterEach(async () => {
  try {
    await cleanupBus?.close();
    await fixture.close();
  } finally {
    vi.useRealTimers();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

async function startBus(
  options: Partial<
    Pick<Parameters<typeof startBuzzBus>[0], "onMessage" | "channelIds" | "onRoomUnavailable">
  > = {},
) {
  cleanupBus = await startBuzzBus({
    scheduler: createTestPluginServiceScheduler(),
    accountId: randomUUID(),
    relayUrl: fixture.relayUrl,
    privateKey: fixture.botPrivateKey,
    channelIds: [skipped.roomId, fixture.roomId],
    onMessage: async (message) => {
      messages.push(message.text);
    },
    onFatalError: (error) => fatal.push(error),
    ...options,
  });
  return cleanupBus;
}

function seedSkippedRoom() {
  const roomId = randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  fixture.events.push(
    sign(39000, createdAt, [
      ["d", roomId],
      ["name", "Skipped room"],
      ["t", "stream"],
    ]),
  );
  publishBotRole(roomId, "member", createdAt);
  return { roomId, createdAt };
}

function sign(kind: number, created_at: number, tags: string[][], content = "") {
  return fixture.signRelay({ kind, created_at, tags, content });
}

function publishBotRole(roomId: string, role: "bot" | "member", createdAt: number) {
  fixture.broadcast(botRoster(role, createdAt, roomId, true));
}

const send = (bus: BuzzBus, text: string, channelId = fixture.roomId) =>
  bus.sendText({ channelId, text });
const members = (bus: BuzzBus) => bus.directory.listGroupMembers({ groupId: skipped.roomId });

function botRoster(
  role: "bot" | "member",
  createdAt: number,
  roomId = skipped.roomId,
  withSender = false,
) {
  return sign(39002, createdAt, [
    ["d", roomId],
    ["p", fixture.botPublicKey, "", role],
    ...(withSender ? [["p", fixture.senderPublicKey, "", "member"]] : []),
  ]);
}

function hasSender(bus: BuzzBus) {
  return members(bus).some((entry) => entry.id === fixture.senderPublicKey);
}

function grantBotRole(offset: number) {
  publishBotRole(skipped.roomId, "bot", skipped.createdAt + offset);
  return notifyBotMembership(skipped.roomId, 44100, skipped.createdAt + offset);
}

function notifyBotMembership(roomId: string, kind: 44100 | 44101, createdAt: number) {
  const event = sign(
    kind,
    createdAt,
    [
      ["p", fixture.botPublicKey],
      ["h", roomId],
    ],
    JSON.stringify({
      type: kind === 44100 ? "member_added" : "member_removed",
      channel_id: roomId,
    }),
  );
  fixture.broadcast(event);
  return event;
}

function roomSubscriptionIds(roomId: string) {
  return fixture.requests
    .filter(
      ({ filters }) =>
        filters.some((filter) => filter.kinds?.includes(9) && filter["#h"]?.includes(roomId)) &&
        filters.some((filter) => filter.kinds?.includes(39002)),
    )
    .map(({ id }) => id);
}

it("restores a skipped room without replacing healthy subscriptions", async () => {
  const unavailable = vi.fn<(error: Error) => void>();
  const replies: string[] = [];
  let restoredTurnSignal: AbortSignal | undefined;
  const bus = await startBus({
    onRoomUnavailable: unavailable,
    onMessage: async (message, activeBus, signal) => {
      messages.push(message.text);
      if (message.channelId === skipped.roomId) {
        restoredTurnSignal = signal;
      }
      await activeBus.sendText({ channelId: message.channelId, text: `reply: ${message.text}` });
      replies.push(message.text);
    },
  });
  const healthySubscriptions = roomSubscriptionIds(fixture.roomId);
  expect(healthySubscriptions).toHaveLength(1);
  expect(roomSubscriptionIds(skipped.roomId)).toEqual([]);
  expect(unavailable).toHaveBeenCalledOnce();
  expect(unavailable).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining(skipped.roomId) }),
  );
  expect(unavailable.mock.calls[0]?.[0].message).toContain("does not have the Bot role");
  fixture.sendMessage("healthy before restoration");
  await vi.waitFor(() => expect(replies).toContain("healthy before restoration"));

  fixture.sendMessage("restored short history", undefined, skipped.roomId);
  const history = fixture.pauseNextRoomHistory();
  fixture.broadcast(
    sign(
      40099,
      skipped.createdAt + 1,
      [["h", skipped.roomId]],
      JSON.stringify({ type: "member_joined", target: fixture.botPublicKey }),
    ),
  );
  const grant = grantBotRole(1);
  await vi.waitFor(() => {
    expect(fatal).toEqual([]);
    expect(roomSubscriptionIds(skipped.roomId)).toHaveLength(1);
  });
  await history.started;
  fixture.sendMessage("healthy while restoration waits");
  await vi.waitFor(() => expect(replies).toContain("healthy while restoration waits"));
  expect(roomSubscriptionIds(fixture.roomId)).toEqual(healthySubscriptions);
  history.release();
  await send(bus, "restored history ordering barrier");
  fixture.broadcast(grant);
  fixture.sendMessage("restored room message", undefined, skipped.roomId);
  await vi.waitFor(() => {
    expect(replies).toContain("restored short history");
    expect(replies).toContain("restored room message");
  });
  expect(fixture.received).toContainEqual(
    expect.objectContaining({
      content: "reply: restored room message",
      tags: expect.arrayContaining([["h", skipped.roomId]]),
    }),
  );
  expect(messages.toSorted()).toEqual([
    "healthy before restoration",
    "healthy while restoration waits",
    "restored room message",
    "restored short history",
  ]);
  expect(roomSubscriptionIds(skipped.roomId)).toHaveLength(1);
  expect(roomSubscriptionIds(fixture.roomId)).toEqual(healthySubscriptions);
  expect(fixture.authenticatedSessions()).toBe(1);
  expect(fatal).toEqual([]);

  publishBotRole(skipped.roomId, "member", skipped.createdAt + 2);
  await vi.waitFor(() => expect(fatal).toHaveLength(1));
  expect(restoredTurnSignal?.aborted).toBe(true);
  await expect(send(bus, "retired restored-room reply", skipped.roomId)).rejects.toThrow(
    "no longer has the Bot role",
  );
});

it.each(["removal during query", "stale Bot snapshot"] as const)(
  "rejects a superseded grant after %s and accepts a newer signed grant",
  async (race) => {
    const bus = await startBus();
    const healthySubscriptions = roomSubscriptionIds(fixture.roomId);
    if (race === "stale Bot snapshot") {
      const denial = botRoster("member", skipped.createdAt + 3);
      fixture.broadcast(denial);
      notifyBotMembership(skipped.roomId, 44101, skipped.createdAt + 3);
      await vi.waitFor(() => expect(hasSender(bus)).toBe(false));
      expect(roomSubscriptionIds(skipped.roomId)).toEqual([]);
      // The client retains the denial while the relay regresses to an older snapshot.
      fixture.events.splice(fixture.events.indexOf(denial), 1);
      publishBotRole(skipped.roomId, "bot", skipped.createdAt + 2);
    }
    const staleQuery = fixture.pauseNextMembershipQuery();
    if (race === "removal during query") {
      grantBotRole(1);
    } else {
      notifyBotMembership(skipped.roomId, 44100, skipped.createdAt + 4);
    }
    await staleQuery.started;
    if (race === "removal during query") {
      publishBotRole(skipped.roomId, "member", skipped.createdAt + 2);
      notifyBotMembership(skipped.roomId, 44101, skipped.createdAt + 2);
    }
    staleQuery.release();
    await send(bus, "stale grant ordering barrier");
    fixture.sendMessage("healthy after stale grant");
    await vi.waitFor(() => expect(messages).toEqual(["healthy after stale grant"]));
    expect(roomSubscriptionIds(skipped.roomId)).toEqual([]);
    expect(fatal).toEqual([]);
    if (race === "stale Bot snapshot") {
      expect(hasSender(bus)).toBe(false);
    }
    grantBotRole(race === "removal during query" ? 3 : 5);
    await vi.waitFor(() => expect(roomSubscriptionIds(skipped.roomId)).toHaveLength(1));
    fixture.sendMessage("restored by fresh grant", undefined, skipped.roomId);
    await vi.waitFor(() => expect(messages).toContain("restored by fresh grant"));
    expect(roomSubscriptionIds(fixture.roomId)).toEqual(healthySubscriptions);
    expect(fatal).toEqual([]);
    if (race === "removal during query") {
      expect(fixture.authenticatedSessions()).toBe(1);
    }
  },
);

it.each(["live downgrade", "shutdown during reconciliation"] as const)(
  "retires pending restoration on %s without late work",
  async (interruption) => {
    let turnSignal: AbortSignal | undefined;
    const bus = await startBus({
      onMessage: async (message, _bus, signal) => {
        messages.push(message.text);
        turnSignal = signal;
      },
    });
    fixture.sendMessage("retained generation");
    await vi.waitFor(() => expect(turnSignal).toBeDefined());
    fixture.sendMessage("pending restored history", undefined, skipped.roomId);
    const history = fixture.pauseNextRoomHistory();
    grantBotRole(1);
    await history.started;

    let reconciliation: ReturnType<BuzzRelayFixture["pauseNextMembershipQuery"]> | undefined;
    if (interruption === "shutdown during reconciliation") {
      fixture.broadcast(botRoster("bot", skipped.createdAt + 2));
      reconciliation = fixture.pauseNextMembershipQuery();
      history.release();
      await reconciliation.started;
      expect(hasSender(bus)).toBe(true);
    } else {
      // A registered room subscription can receive a live roster before its EOSE.
      fixture.sendUnchecked(botRoster("member", skipped.createdAt + 2));
      await vi.waitFor(() => expect(fatal).toHaveLength(1));
      expect(turnSignal?.aborted).toBe(true);
      await expect(send(bus, "pre-EOSE retired reply", skipped.roomId)).rejects.toThrow(
        "no longer has the Bot role",
      );
    }

    const membersAtStop = members(bus);
    const requestsAtStop = fixture.requests.length;
    const stopping = bus.close();
    history.release();
    reconciliation?.release();
    await stopping;
    expect(turnSignal?.aborted).toBe(true);
    expect(messages).toEqual(["retained generation"]);
    expect(fixture.requests).toHaveLength(requestsAtStop);
    expect(members(bus)).toEqual(membersAtStop);
    expect(fatal).toHaveLength(interruption === "live downgrade" ? 1 : 0);
    await expect(send(bus, "closed restoration reply", skipped.roomId)).rejects.toThrow(
      interruption === "live downgrade" ? "no longer has the Bot role" : "Buzz bus closed",
    );
  },
);

it.each(["closed", "missing EOSE"] as const)(
  "fails the account when restored room history is %s",
  async (failure) => {
    const bus = await startBus();
    if (failure === "missing EOSE") {
      await send(bus, "restoration startup barrier");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
    const history = fixture.pauseNextRoomHistory();
    grantBotRole(1);
    await history.started;
    if (failure === "closed") {
      history.close("fixture room history failed");
      await vi.waitFor(() => expect(fatal).toHaveLength(1), { timeout: 11000 });
      expect(fatal[0]?.message).toContain("closed");
    } else {
      expect(fatal).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]?.message).toBe(
        `Timed out loading Buzz room membership changes for ${skipped.roomId}`,
      );
    }
    await expect(send(bus, "failed generation reply")).rejects.toThrow(fatal[0]);
  },
  15000,
);

it("fails startup when the bot is only a member in every active configured room", async () => {
  const initial = fixture.events.find((event) => event.kind === 39002)!;
  publishBotRole(fixture.roomId, "member", initial.created_at + 1);
  await expect(startBus({ channelIds: [fixture.roomId] })).rejects.toThrow("Bot role");
  expect(roomSubscriptionIds(fixture.roomId)).toEqual([]);
});
