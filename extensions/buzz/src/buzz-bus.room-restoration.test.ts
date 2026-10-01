import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startBuzzBus, type BuzzBus } from "./buzz-bus.js";
import { createBuzzRelayFixture } from "./buzz-relay.test-harness.js";

type BuzzRelayFixture = Awaited<ReturnType<typeof createBuzzRelayFixture>>;
type BusOptions = Parameters<typeof startBuzzBus>[0];

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
  options: Partial<Pick<BusOptions, "onMessage" | "channelIds" | "onRoomUnavailable">> = {},
) {
  cleanupBus = await startBuzzBus({
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
    fixture.signRelay({
      kind: 39000,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", roomId],
        ["name", "Skipped room"],
        ["t", "stream"],
      ],
    }),
  );
  publishBotRole(roomId, "member", createdAt);
  return { roomId, createdAt };
}

function publishBotRole(roomId: string, role: "bot" | "member", createdAt: number) {
  fixture.broadcast(
    fixture.signRelay({
      kind: 39002,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", roomId],
        ["p", fixture.botPublicKey, "", role],
        ["p", fixture.senderPublicKey, "", "member"],
      ],
    }),
  );
}

function notifyBotMembership(roomId: string, kind: 44100 | 44101, createdAt: number) {
  const event = fixture.signRelay({
    kind,
    created_at: createdAt,
    content: JSON.stringify({
      type: kind === 44100 ? "member_added" : "member_removed",
      channel_id: roomId,
    }),
    tags: [
      ["p", fixture.botPublicKey],
      ["h", roomId],
    ],
  });
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
    fixture.signRelay({
      kind: 40099,
      created_at: skipped.createdAt + 1,
      content: JSON.stringify({ type: "member_joined", target: fixture.botPublicKey }),
      tags: [["h", skipped.roomId]],
    }),
  );
  publishBotRole(skipped.roomId, "bot", skipped.createdAt + 1);
  const grant = notifyBotMembership(skipped.roomId, 44100, skipped.createdAt + 1);
  await vi.waitFor(() => {
    expect(fatal).toEqual([]);
    expect(roomSubscriptionIds(skipped.roomId)).toHaveLength(1);
  });
  await history.started;
  fixture.sendMessage("healthy while restoration waits");
  await vi.waitFor(() => expect(replies).toContain("healthy while restoration waits"));
  expect(roomSubscriptionIds(fixture.roomId)).toEqual(healthySubscriptions);
  history.release();
  await bus.sendText({ channelId: fixture.roomId, text: "restored history ordering barrier" });
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
  expect(messages).toHaveLength(4);
  expect(messages).toEqual(
    expect.arrayContaining([
      "healthy before restoration",
      "healthy while restoration waits",
      "restored short history",
      "restored room message",
    ]),
  );
  expect(roomSubscriptionIds(skipped.roomId)).toHaveLength(1);
  expect(roomSubscriptionIds(fixture.roomId)).toEqual(healthySubscriptions);
  expect(fixture.authenticatedSessions()).toBe(1);
  expect(fatal).toEqual([]);

  publishBotRole(skipped.roomId, "member", skipped.createdAt + 2);
  await vi.waitFor(() => expect(fatal).toHaveLength(1));
  expect(restoredTurnSignal?.aborted).toBe(true);
  await expect(
    bus.sendText({ channelId: skipped.roomId, text: "retired restored-room reply" }),
  ).rejects.toThrow("no longer has the Bot role");
});

it("discards a grant query superseded by removal and accepts a later signed grant", async () => {
  const bus = await startBus();
  const healthySubscriptions = roomSubscriptionIds(fixture.roomId);
  const staleQuery = fixture.pauseNextMembershipQuery();
  publishBotRole(skipped.roomId, "bot", skipped.createdAt + 1);
  notifyBotMembership(skipped.roomId, 44100, skipped.createdAt + 1);
  await staleQuery.started;
  publishBotRole(skipped.roomId, "member", skipped.createdAt + 2);
  notifyBotMembership(skipped.roomId, 44101, skipped.createdAt + 2);
  staleQuery.release();
  await bus.sendText({ channelId: fixture.roomId, text: "removal query ordering barrier" });
  fixture.sendMessage("healthy after superseded grant");
  await vi.waitFor(() => expect(messages).toEqual(["healthy after superseded grant"]));
  expect(roomSubscriptionIds(skipped.roomId)).toEqual([]);
  expect(fatal).toEqual([]);

  publishBotRole(skipped.roomId, "bot", skipped.createdAt + 3);
  notifyBotMembership(skipped.roomId, 44100, skipped.createdAt + 3);
  await vi.waitFor(() => expect(roomSubscriptionIds(skipped.roomId)).toHaveLength(1));
  fixture.sendMessage("restored after a fresh grant", undefined, skipped.roomId);
  await vi.waitFor(() => expect(messages).toContain("restored after a fresh grant"));
  expect(roomSubscriptionIds(fixture.roomId)).toEqual(healthySubscriptions);
  expect(fixture.authenticatedSessions()).toBe(1);
  expect(fatal).toEqual([]);
});

it("retains a newer non-Bot roster when a later grant query returns an older Bot roster", async () => {
  const bus = await startBus();
  const healthySubscriptions = roomSubscriptionIds(fixture.roomId);
  const newerDenial = fixture.signRelay({
    kind: 39002,
    created_at: skipped.createdAt + 3,
    content: "",
    tags: [
      ["d", skipped.roomId],
      ["p", fixture.botPublicKey, "", "member"],
    ],
  });
  fixture.broadcast(newerDenial);
  notifyBotMembership(skipped.roomId, 44101, skipped.createdAt + 3);
  await vi.waitFor(() =>
    expect(
      bus.directory
        .listGroupMembers({ groupId: skipped.roomId })
        .some((entry) => entry.id === fixture.senderPublicKey),
    ).toBe(false),
  );
  expect(roomSubscriptionIds(skipped.roomId)).toEqual([]);

  // Model a stale relay snapshot after the client has accepted the newer denial.
  fixture.events.splice(fixture.events.indexOf(newerDenial), 1);
  publishBotRole(skipped.roomId, "bot", skipped.createdAt + 2);
  const staleQuery = fixture.pauseNextMembershipQuery();
  notifyBotMembership(skipped.roomId, 44100, skipped.createdAt + 4);
  await staleQuery.started;
  staleQuery.release();
  await bus.sendText({ channelId: fixture.roomId, text: "stale denial ordering barrier" });
  fixture.sendMessage("healthy after stale Bot roster");
  await vi.waitFor(() => expect(messages).toEqual(["healthy after stale Bot roster"]));
  expect(roomSubscriptionIds(skipped.roomId)).toEqual([]);
  expect(
    bus.directory
      .listGroupMembers({ groupId: skipped.roomId })
      .some((entry) => entry.id === fixture.senderPublicKey),
  ).toBe(false);
  expect(fatal).toEqual([]);

  publishBotRole(skipped.roomId, "bot", skipped.createdAt + 5);
  notifyBotMembership(skipped.roomId, 44100, skipped.createdAt + 5);
  await vi.waitFor(() => expect(roomSubscriptionIds(skipped.roomId)).toHaveLength(1));
  fixture.sendMessage("restored by newer Bot roster", undefined, skipped.roomId);
  await vi.waitFor(() => expect(messages).toContain("restored by newer Bot roster"));
  expect(roomSubscriptionIds(fixture.roomId)).toEqual(healthySubscriptions);
  expect(fatal).toEqual([]);
});

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
    publishBotRole(skipped.roomId, "bot", skipped.createdAt + 1);
    notifyBotMembership(skipped.roomId, 44100, skipped.createdAt + 1);
    await history.started;

    let reconciliation: ReturnType<BuzzRelayFixture["pauseNextMembershipQuery"]> | undefined;
    if (interruption === "shutdown during reconciliation") {
      fixture.broadcast(
        fixture.signRelay({
          kind: 39002,
          created_at: skipped.createdAt + 2,
          content: "",
          tags: [
            ["d", skipped.roomId],
            ["p", fixture.botPublicKey, "", "bot"],
          ],
        }),
      );
      reconciliation = fixture.pauseNextMembershipQuery();
      history.release();
      await reconciliation.started;
      expect(
        bus.directory
          .listGroupMembers({ groupId: skipped.roomId })
          .some((member) => member.id === fixture.senderPublicKey),
      ).toBe(true);
    } else {
      // A registered room subscription can receive a live roster before its EOSE.
      fixture.sendUnchecked(
        fixture.signRelay({
          kind: 39002,
          created_at: skipped.createdAt + 2,
          content: "",
          tags: [
            ["d", skipped.roomId],
            ["p", fixture.botPublicKey, "", "member"],
          ],
        }),
      );
      await vi.waitFor(() => expect(fatal).toHaveLength(1));
      expect(turnSignal?.aborted).toBe(true);
      await expect(
        bus.sendText({ channelId: skipped.roomId, text: "pre-EOSE retired reply" }),
      ).rejects.toThrow("no longer has the Bot role");
    }

    const membersAtStop = bus.directory.listGroupMembers({ groupId: skipped.roomId });
    const requestsAtStop = fixture.requests.length;
    const stopping = bus.close();
    history.release();
    reconciliation?.release();
    await stopping;
    expect(turnSignal?.aborted).toBe(true);
    expect(messages).toEqual(["retained generation"]);
    expect(fixture.requests).toHaveLength(requestsAtStop);
    expect(bus.directory.listGroupMembers({ groupId: skipped.roomId })).toEqual(membersAtStop);
    expect(fatal).toHaveLength(interruption === "live downgrade" ? 1 : 0);
    await expect(
      bus.sendText({ channelId: skipped.roomId, text: "closed restoration reply" }),
    ).rejects.toThrow(
      interruption === "live downgrade" ? "no longer has the Bot role" : "Buzz bus closed",
    );
  },
);

it.each(["closed", "missing EOSE"] as const)(
  "fails the account when restored room history is %s",
  async (failure) => {
    const bus = await startBus();
    if (failure === "missing EOSE") {
      await bus.sendText({ channelId: fixture.roomId, text: "restoration startup barrier" });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
    const history = fixture.pauseNextRoomHistory();
    publishBotRole(skipped.roomId, "bot", skipped.createdAt + 1);
    notifyBotMembership(skipped.roomId, 44100, skipped.createdAt + 1);
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
    await expect(
      bus.sendText({ channelId: fixture.roomId, text: "failed generation reply" }),
    ).rejects.toThrow(fatal[0]);
  },
  15000,
);

it("fails startup when the bot is only a member in every active configured room", async () => {
  const initial = fixture.events.find((event) => event.kind === 39002)!;
  publishBotRole(fixture.roomId, "member", initial.created_at + 1);
  await expect(startBus({ channelIds: [fixture.roomId] })).rejects.toThrow("Bot role");
  expect(roomSubscriptionIds(fixture.roomId)).toEqual([]);
});
