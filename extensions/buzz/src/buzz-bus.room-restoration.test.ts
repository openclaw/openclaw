import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startBuzzBus, type BuzzBus } from "./buzz-bus.js";
import { createBuzzRelayFixture } from "./buzz-relay.test-harness.js";

let stateDir: string;
beforeEach(() => {
  // openclaw-temp-dir: allow extension tests cannot import root test helpers.
  stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-room-restoration-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(() => {
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

type BuzzRelayFixture = Awaited<ReturnType<typeof createBuzzRelayFixture>>;

function seedSkippedRoom(fixture: BuzzRelayFixture) {
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
  publishBotRole(fixture, roomId, "member", createdAt);
  return { roomId, createdAt };
}

function publishBotRole(
  fixture: BuzzRelayFixture,
  roomId: string,
  role: "bot" | "member",
  createdAt: number,
) {
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

function notifyBotMembership(
  fixture: BuzzRelayFixture,
  roomId: string,
  kind: 44100 | 44101,
  createdAt: number,
) {
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

function roomSubscriptionIds(fixture: BuzzRelayFixture, roomId: string) {
  return fixture.requests
    .filter(
      ({ filters }) =>
        filters.some((filter) => filter.kinds?.includes(9) && filter["#h"]?.includes(roomId)) &&
        filters.some((filter) => filter.kinds?.includes(39002)),
    )
    .map(({ id }) => id);
}

it("restores a skipped room without replacing healthy subscriptions", async () => {
  const fixture = await createBuzzRelayFixture();
  const skipped = seedSkippedRoom(fixture);
  const messages: string[] = [];
  const replies: string[] = [];
  const fatal: Error[] = [];
  let restoredTurnSignal: AbortSignal | undefined;
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [skipped.roomId, fixture.roomId],
      onMessage: async (message, activeBus, signal) => {
        messages.push(message.text);
        if (message.channelId === skipped.roomId) {
          restoredTurnSignal = signal;
        }
        await activeBus.sendText({ channelId: message.channelId, text: `reply: ${message.text}` });
        replies.push(message.text);
      },
      onFatalError: (error) => fatal.push(error),
    });
    const healthySubscriptions = roomSubscriptionIds(fixture, fixture.roomId);
    expect(healthySubscriptions).toHaveLength(1);
    expect(roomSubscriptionIds(fixture, skipped.roomId)).toEqual([]);
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
    publishBotRole(fixture, skipped.roomId, "bot", skipped.createdAt + 1);
    const grant = notifyBotMembership(fixture, skipped.roomId, 44100, skipped.createdAt + 1);
    await vi.waitFor(() => {
      expect(fatal).toEqual([]);
      expect(roomSubscriptionIds(fixture, skipped.roomId)).toHaveLength(1);
    });
    await history.started;
    fixture.sendMessage("healthy while restoration waits");
    await vi.waitFor(() => expect(replies).toContain("healthy while restoration waits"));
    expect(roomSubscriptionIds(fixture, fixture.roomId)).toEqual(healthySubscriptions);
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
    expect(roomSubscriptionIds(fixture, skipped.roomId)).toHaveLength(1);
    expect(roomSubscriptionIds(fixture, fixture.roomId)).toEqual(healthySubscriptions);
    expect(fixture.authenticatedSessions()).toBe(1);
    expect(fatal).toEqual([]);

    publishBotRole(fixture, skipped.roomId, "member", skipped.createdAt + 2);
    await vi.waitFor(() => expect(fatal).toHaveLength(1));
    expect(restoredTurnSignal?.aborted).toBe(true);
    await expect(
      bus.sendText({ channelId: skipped.roomId, text: "retired restored-room reply" }),
    ).rejects.toThrow("no longer has the Bot role");
  } finally {
    await bus?.close();
    await fixture.close();
  }
});

it("discards a grant query superseded by removal and accepts a later signed grant", async () => {
  const fixture = await createBuzzRelayFixture();
  const skipped = seedSkippedRoom(fixture);
  const messages: string[] = [];
  const fatal: Error[] = [];
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [skipped.roomId, fixture.roomId],
      onMessage: async (message) => {
        messages.push(message.text);
      },
      onFatalError: (error) => fatal.push(error),
    });
    const healthySubscriptions = roomSubscriptionIds(fixture, fixture.roomId);
    const staleQuery = fixture.pauseNextMembershipQuery();
    publishBotRole(fixture, skipped.roomId, "bot", skipped.createdAt + 1);
    notifyBotMembership(fixture, skipped.roomId, 44100, skipped.createdAt + 1);
    await staleQuery.started;
    publishBotRole(fixture, skipped.roomId, "member", skipped.createdAt + 2);
    notifyBotMembership(fixture, skipped.roomId, 44101, skipped.createdAt + 2);
    staleQuery.release();
    await bus.sendText({ channelId: fixture.roomId, text: "removal query ordering barrier" });
    fixture.sendMessage("healthy after superseded grant");
    await vi.waitFor(() => expect(messages).toEqual(["healthy after superseded grant"]));
    expect(roomSubscriptionIds(fixture, skipped.roomId)).toEqual([]);
    expect(fatal).toEqual([]);

    publishBotRole(fixture, skipped.roomId, "bot", skipped.createdAt + 3);
    notifyBotMembership(fixture, skipped.roomId, 44100, skipped.createdAt + 3);
    await vi.waitFor(() => expect(roomSubscriptionIds(fixture, skipped.roomId)).toHaveLength(1));
    fixture.sendMessage("restored after a fresh grant", undefined, skipped.roomId);
    await vi.waitFor(() => expect(messages).toContain("restored after a fresh grant"));
    expect(roomSubscriptionIds(fixture, fixture.roomId)).toEqual(healthySubscriptions);
    expect(fixture.authenticatedSessions()).toBe(1);
    expect(fatal).toEqual([]);
  } finally {
    await bus?.close();
    await fixture.close();
  }
});

it("retains a newer non-Bot roster when a later grant query returns an older Bot roster", async () => {
  const fixture = await createBuzzRelayFixture();
  const skipped = seedSkippedRoom(fixture);
  const messages: string[] = [];
  const fatal: Error[] = [];
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [skipped.roomId, fixture.roomId],
      onMessage: async (message) => {
        messages.push(message.text);
      },
      onFatalError: (error) => fatal.push(error),
    });
    const healthySubscriptions = roomSubscriptionIds(fixture, fixture.roomId);
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
    notifyBotMembership(fixture, skipped.roomId, 44101, skipped.createdAt + 3);
    await vi.waitFor(() =>
      expect(
        bus?.directory
          .listGroupMembers({ groupId: skipped.roomId })
          .some((entry) => entry.id === fixture.senderPublicKey),
      ).toBe(false),
    );
    expect(roomSubscriptionIds(fixture, skipped.roomId)).toEqual([]);

    // Model a stale relay snapshot after the client has accepted the newer denial.
    fixture.events.splice(fixture.events.indexOf(newerDenial), 1);
    publishBotRole(fixture, skipped.roomId, "bot", skipped.createdAt + 2);
    const staleQuery = fixture.pauseNextMembershipQuery();
    notifyBotMembership(fixture, skipped.roomId, 44100, skipped.createdAt + 4);
    await staleQuery.started;
    staleQuery.release();
    await bus.sendText({ channelId: fixture.roomId, text: "stale denial ordering barrier" });
    fixture.sendMessage("healthy after stale Bot roster");
    await vi.waitFor(() => expect(messages).toEqual(["healthy after stale Bot roster"]));
    expect(roomSubscriptionIds(fixture, skipped.roomId)).toEqual([]);
    expect(
      bus.directory
        .listGroupMembers({ groupId: skipped.roomId })
        .some((entry) => entry.id === fixture.senderPublicKey),
    ).toBe(false);
    expect(fatal).toEqual([]);

    publishBotRole(fixture, skipped.roomId, "bot", skipped.createdAt + 5);
    notifyBotMembership(fixture, skipped.roomId, 44100, skipped.createdAt + 5);
    await vi.waitFor(() => expect(roomSubscriptionIds(fixture, skipped.roomId)).toHaveLength(1));
    fixture.sendMessage("restored by newer Bot roster", undefined, skipped.roomId);
    await vi.waitFor(() => expect(messages).toContain("restored by newer Bot roster"));
    expect(roomSubscriptionIds(fixture, fixture.roomId)).toEqual(healthySubscriptions);
    expect(fatal).toEqual([]);
  } finally {
    await bus?.close();
    await fixture.close();
  }
});

it.each(["live downgrade", "shutdown before EOSE", "shutdown during reconciliation"] as const)(
  "retires pending restoration on %s without late work",
  async (interruption) => {
    const fixture = await createBuzzRelayFixture();
    const skipped = seedSkippedRoom(fixture);
    const messages: string[] = [];
    const fatal: Error[] = [];
    let turnSignal: AbortSignal | undefined;
    let bus: BuzzBus | undefined;
    try {
      bus = await startBuzzBus({
        accountId: randomUUID(),
        relayUrl: fixture.relayUrl,
        privateKey: fixture.botPrivateKey,
        channelIds: [skipped.roomId, fixture.roomId],
        onMessage: async (message, _bus, signal) => {
          messages.push(message.text);
          turnSignal = signal;
        },
        onFatalError: (error) => fatal.push(error),
      });
      fixture.sendMessage("retained generation");
      await vi.waitFor(() => expect(turnSignal).toBeDefined());
      fixture.sendMessage("pending restored history", undefined, skipped.roomId);
      const history = fixture.pauseNextRoomHistory();
      publishBotRole(fixture, skipped.roomId, "bot", skipped.createdAt + 1);
      notifyBotMembership(fixture, skipped.roomId, 44100, skipped.createdAt + 1);
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
      } else if (interruption === "live downgrade") {
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
    } finally {
      await bus?.close();
      await fixture.close();
    }
  },
);

it("does not open a restored room after shutdown during its roster query", async () => {
  const fixture = await createBuzzRelayFixture();
  const skipped = seedSkippedRoom(fixture);
  const fatal: Error[] = [];
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [skipped.roomId, fixture.roomId],
      onMessage: async () => {},
      onFatalError: (error) => fatal.push(error),
    });
    const query = fixture.pauseNextMembershipQuery();
    publishBotRole(fixture, skipped.roomId, "bot", skipped.createdAt + 1);
    notifyBotMembership(fixture, skipped.roomId, 44100, skipped.createdAt + 1);
    await query.started;
    await bus.close();
    query.release();
    expect(roomSubscriptionIds(fixture, skipped.roomId)).toEqual([]);
    expect(fatal).toEqual([]);
    await expect(
      bus.sendText({ channelId: fixture.roomId, text: "closed generation reply" }),
    ).rejects.toThrow("Buzz bus closed");
  } finally {
    await bus?.close();
    await fixture.close();
  }
});

it.each(["closed", "missing EOSE"] as const)(
  "fails the account when restored room history is %s",
  async (failure) => {
    const fixture = await createBuzzRelayFixture();
    const skipped = seedSkippedRoom(fixture);
    const fatal: Error[] = [];
    let bus: BuzzBus | undefined;
    try {
      bus = await startBuzzBus({
        accountId: randomUUID(),
        relayUrl: fixture.relayUrl,
        privateKey: fixture.botPrivateKey,
        channelIds: [skipped.roomId, fixture.roomId],
        onMessage: async () => {},
        onFatalError: (error) => fatal.push(error),
      });
      const history = fixture.pauseNextRoomHistory();
      publishBotRole(fixture, skipped.roomId, "bot", skipped.createdAt + 1);
      notifyBotMembership(fixture, skipped.roomId, 44100, skipped.createdAt + 1);
      await history.started;
      if (failure === "closed") {
        history.close("fixture room history failed");
      }
      await vi.waitFor(() => expect(fatal).toHaveLength(1), { timeout: 11000 });
      expect(fatal[0]?.message).toContain(failure === "closed" ? "closed" : "Timed out");
      await expect(
        bus.sendText({ channelId: fixture.roomId, text: "failed generation reply" }),
      ).rejects.toThrow();
    } finally {
      await bus?.close();
      await fixture.close();
    }
  },
  15000,
);

it.each(["member", "absent"] as const)(
  "fails startup when the bot is %s in every active configured room",
  async (membership) => {
    const fixture = await createBuzzRelayFixture();
    const initial = fixture.events.find((event) => event.kind === 39002)!;
    fixture.events.push(
      fixture.signRelay({
        kind: 39002,
        created_at: initial.created_at + 1,
        content: "",
        tags: [
          ["d", fixture.roomId],
          ...(membership === "member" ? [["p", fixture.botPublicKey, "", "member"]] : []),
          ["p", fixture.senderPublicKey, "", "member"],
        ],
      }),
    );
    try {
      await expect(
        startBuzzBus({
          accountId: randomUUID(),
          relayUrl: fixture.relayUrl,
          privateKey: fixture.botPrivateKey,
          channelIds: [fixture.roomId],
          onMessage: async () => {},
        }),
      ).rejects.toThrow("Bot role");
      expect(roomSubscriptionIds(fixture, fixture.roomId)).toEqual([]);
    } finally {
      await fixture.close();
    }
  },
);

it("keeps an unrelated in-flight reply alive when another room is archived", async () => {
  const fixture = await createBuzzRelayFixture();
  const other = seedSkippedRoom(fixture);
  fixture.events.splice(
    fixture.events.findIndex(
      (event) =>
        event.kind === 39002 && event.tags.some((tag) => tag[0] === "d" && tag[1] === other.roomId),
    ),
    1,
  );
  publishBotRole(fixture, other.roomId, "bot", other.createdAt + 1);
  const fatal: Error[] = [];
  let turnSignal: AbortSignal | undefined;
  let releaseReply = () => {};
  const pendingReply = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [fixture.roomId, other.roomId],
      onMessage: async (message, activeBus, signal, assertCurrent) => {
        turnSignal = signal;
        await pendingReply;
        assertCurrent();
        await activeBus.sendText({ channelId: message.channelId, text: "completed reply" });
      },
      onFatalError: (error) => fatal.push(error),
    });
    fixture.sendMessage("slow question in healthy room");
    await vi.waitFor(() => expect(turnSignal).toBeDefined());
    fixture.broadcast(
      fixture.signRelay({
        kind: 39000,
        created_at: other.createdAt + 2,
        content: "",
        tags: [
          ["d", other.roomId],
          ["archived", "true"],
        ],
      }),
    );
    fixture.broadcast(
      fixture.signRelay({
        kind: 9002,
        created_at: other.createdAt + 2,
        content: "",
        tags: [["h", other.roomId]],
      }),
    );
    await vi.waitFor(() => expect(bus?.directory.isRoomArchived(other.roomId)).toBe(true));
    expect(turnSignal?.aborted).toBe(false);
    expect(fatal).toEqual([]);
    releaseReply();
    await vi.waitFor(() =>
      expect(fixture.received).toContainEqual(
        expect.objectContaining({ content: "completed reply" }),
      ),
    );
    expect(fixture.authenticatedSessions()).toBe(1);
  } finally {
    releaseReply();
    await bus?.close();
    await fixture.close();
  }
});

function publishRoomArchive(
  fixture: BuzzRelayFixture,
  roomId: string,
  archived: boolean,
  createdAt: number,
) {
  fixture.broadcast(
    fixture.signRelay({
      kind: 39000,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", roomId],
        ["archived", String(archived)],
      ],
    }),
  );
}

it.each(["roster query", "room EOSE"] as const)(
  "keeps healthy rooms online when an archive interrupts restoration during %s",
  async (stage) => {
    const fixture = await createBuzzRelayFixture();
    const skipped = seedSkippedRoom(fixture);
    const messages: string[] = [];
    const fatal: Error[] = [];
    let pending: ReturnType<BuzzRelayFixture["pauseNextMembershipQuery"]> | undefined;
    let bus: BuzzBus | undefined;
    try {
      bus = await startBuzzBus({
        accountId: randomUUID(),
        relayUrl: fixture.relayUrl,
        privateKey: fixture.botPrivateKey,
        channelIds: [fixture.roomId, skipped.roomId],
        onMessage: async (message) => {
          messages.push(message.text);
        },
        onFatalError: (error) => fatal.push(error),
      });
      const healthySubscriptions = roomSubscriptionIds(fixture, fixture.roomId);
      pending =
        stage === "roster query"
          ? fixture.pauseNextMembershipQuery()
          : fixture.pauseNextRoomHistory();
      publishBotRole(fixture, skipped.roomId, "bot", skipped.createdAt + 1);
      notifyBotMembership(fixture, skipped.roomId, 44100, skipped.createdAt + 1);
      await pending.started;

      publishRoomArchive(fixture, skipped.roomId, true, skipped.createdAt + 2);
      await bus.refreshDirectory();
      expect(bus.directory.isRoomArchived(skipped.roomId)).toBe(true);
      expect(bus.directory.listGroupMembers({ groupId: skipped.roomId })).toEqual([]);
      pending.release();
      await bus.sendText({ channelId: fixture.roomId, text: "archived restoration barrier" });
      fixture.sendMessage("healthy after interrupted restoration");
      await vi.waitFor(() => expect(messages).toContain("healthy after interrupted restoration"));
      expect(fatal).toEqual([]);
      if (stage === "roster query") {
        expect(roomSubscriptionIds(fixture, skipped.roomId)).toEqual([]);
      }

      publishRoomArchive(fixture, skipped.roomId, false, skipped.createdAt + 3);
      await bus.refreshDirectory();
      fixture.sendMessage("restored after interrupted restoration", undefined, skipped.roomId);
      await vi.waitFor(() => expect(messages).toContain("restored after interrupted restoration"));
      expect(roomSubscriptionIds(fixture, fixture.roomId)).toEqual(healthySubscriptions);
      expect(fixture.authenticatedSessions()).toBe(1);
      expect(fatal).toEqual([]);
    } finally {
      pending?.release();
      await bus?.close();
      await fixture.close();
    }
  },
);

it("keeps a pre-archive turn fenced after its room is restored", async () => {
  const fixture = await createBuzzRelayFixture();
  const createdAt = Math.floor(Date.now() / 1000);
  const messages: string[] = [];
  const fatal: Error[] = [];
  const messageErrors: Error[] = [];
  let staleAuthority: (() => void) | undefined;
  let turnSignal: AbortSignal | undefined;
  let releaseTurn = () => {};
  const pendingTurn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [fixture.roomId],
      onMessage: async (message, _bus, signal, assertCurrent) => {
        if (message.text === "before archive") {
          staleAuthority = assertCurrent;
          turnSignal = signal;
          await pendingTurn;
        }
        assertCurrent();
        messages.push(message.text);
      },
      onFatalError: (error) => fatal.push(error),
      onMessageError: (error) => messageErrors.push(error),
    });
    fixture.sendMessage("before archive");
    await vi.waitFor(() => expect(staleAuthority).toBeDefined());
    publishRoomArchive(fixture, fixture.roomId, true, createdAt + 1);
    await bus.refreshDirectory();
    expect(() => staleAuthority?.()).toThrow("archived");
    expect(turnSignal?.aborted).toBe(true);

    publishRoomArchive(fixture, fixture.roomId, false, createdAt + 2);
    await bus.refreshDirectory();
    expect(() => staleAuthority?.()).toThrow("archived");
    fixture.sendMessage("new turn after restoration");
    await vi.waitFor(() => expect(messages).toContain("new turn after restoration"));
    releaseTurn();
    await vi.waitFor(() => expect(messageErrors).toHaveLength(1));
    expect(messages).not.toContain("before archive");
    expect(fatal).toEqual([]);
    expect(fixture.authenticatedSessions()).toBe(1);
  } finally {
    releaseTurn();
    await bus?.close();
    await fixture.close();
  }
});

it("preserves a pending sender removal across archive and a lagging restoration roster", async () => {
  const fixture = await createBuzzRelayFixture();
  const healthy = seedSkippedRoom(fixture);
  fixture.events.splice(
    fixture.events.findIndex(
      (event) =>
        event.kind === 39002 &&
        event.tags.some((tag) => tag[0] === "d" && tag[1] === healthy.roomId),
    ),
    1,
  );
  publishBotRole(fixture, healthy.roomId, "bot", healthy.createdAt + 1);
  const messages: string[] = [];
  const fatal: Error[] = [];
  const pending: Array<ReturnType<BuzzRelayFixture["pauseNextMembershipQuery"]>> = [];
  let bus: BuzzBus | undefined;
  try {
    bus = await startBuzzBus({
      accountId: randomUUID(),
      relayUrl: fixture.relayUrl,
      privateKey: fixture.botPrivateKey,
      channelIds: [fixture.roomId, healthy.roomId],
      onMessage: async (message) => {
        messages.push(message.text);
      },
      onFatalError: (error) => fatal.push(error),
    });
    const healthySubscriptions = roomSubscriptionIds(fixture, healthy.roomId);
    const beforeArchive = fixture.pauseNextMembershipQuery();
    pending.push(beforeArchive);
    fixture.broadcast(
      fixture.signRelay({
        kind: 40099,
        created_at: healthy.createdAt + 2,
        content: JSON.stringify({ type: "member_removed", target: fixture.senderPublicKey }),
        tags: [["h", fixture.roomId]],
      }),
    );
    await beforeArchive.started;
    expect(bus.directory.isMember(fixture.roomId, fixture.senderPublicKey)).toBe(false);
    publishRoomArchive(fixture, fixture.roomId, true, healthy.createdAt + 3);
    await bus.refreshDirectory();
    beforeArchive.release();
    await bus.sendText({ channelId: healthy.roomId, text: "archived removal barrier" });

    const staleRestore = fixture.pauseNextMembershipQuery();
    pending.push(staleRestore);
    publishRoomArchive(fixture, fixture.roomId, false, healthy.createdAt + 4);
    await bus.refreshDirectory();
    await staleRestore.started;
    const confirmedRestore = fixture.pauseNextMembershipQuery();
    pending.push(confirmedRestore);
    fixture.broadcast(
      fixture.signRelay({
        kind: 39002,
        created_at: healthy.createdAt + 5,
        content: "",
        tags: [
          ["d", fixture.roomId],
          ["p", fixture.botPublicKey, "", "bot"],
        ],
      }),
    );
    staleRestore.release();
    await confirmedRestore.started;
    // A stale signed roster cannot reopen the room while removal confirmation is pending.
    expect(roomSubscriptionIds(fixture, fixture.roomId)).toHaveLength(1);
    expect(bus.directory.isMember(fixture.roomId, fixture.senderPublicKey)).toBe(false);
    fixture.sendMessage("denied during restoration");
    confirmedRestore.release();
    await vi.waitFor(() => expect(roomSubscriptionIds(fixture, fixture.roomId)).toHaveLength(2));
    fixture.sendMessage("denied after restoration");
    fixture.sendMessage("healthy after confirmed removal", undefined, healthy.roomId);
    await vi.waitFor(() => expect(messages).toContain("healthy after confirmed removal"));
    expect(messages).toEqual(["healthy after confirmed removal"]);
    expect(bus.directory.isMember(fixture.roomId, fixture.senderPublicKey)).toBe(false);
    expect(roomSubscriptionIds(fixture, healthy.roomId)).toEqual(healthySubscriptions);
    expect(fixture.authenticatedSessions()).toBe(1);
    expect(fatal).toEqual([]);
  } finally {
    for (const query of pending) {
      query.release();
    }
    await bus?.close();
    await fixture.close();
  }
});

it("retires an archived room generation while another room is still starting", async () => {
  const fixture = await createBuzzRelayFixture();
  const other = seedSkippedRoom(fixture);
  fixture.events.splice(
    fixture.events.findIndex(
      (event) =>
        event.kind === 39002 && event.tags.some((tag) => tag[0] === "d" && tag[1] === other.roomId),
    ),
    1,
  );
  publishBotRole(fixture, other.roomId, "bot", other.createdAt + 1);
  const history = fixture.pauseNextRoomHistory();
  const fatal: Error[] = [];
  let turnSignal: AbortSignal | undefined;
  let staleAuthority: (() => void) | undefined;
  let activeBus: BuzzBus | undefined;
  let releaseTurn = () => {};
  const pendingTurn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const starting = startBuzzBus({
    accountId: randomUUID(),
    relayUrl: fixture.relayUrl,
    privateKey: fixture.botPrivateKey,
    channelIds: [other.roomId, fixture.roomId],
    onMessage: async (message, bus, signal, assertCurrent) => {
      activeBus = bus;
      if (message.text === "turn during startup") {
        turnSignal = signal;
        staleAuthority = assertCurrent;
        await pendingTurn;
      }
    },
    onFatalError: (error) => fatal.push(error),
  });
  try {
    await history.started;
    await vi.waitFor(() => expect(roomSubscriptionIds(fixture, fixture.roomId)).toHaveLength(1));
    fixture.sendMessage("turn during startup");
    await vi.waitFor(() => expect(turnSignal).toBeDefined());
    publishRoomArchive(fixture, fixture.roomId, true, other.createdAt + 2);
    await activeBus?.refreshDirectory();
    expect(turnSignal?.aborted).toBe(true);
    publishRoomArchive(fixture, fixture.roomId, false, other.createdAt + 3);
    await activeBus?.refreshDirectory();
    expect(() => staleAuthority?.()).toThrow("archived");
    history.release();
    await starting;
    expect(() => staleAuthority?.()).toThrow("archived");
    expect(fatal).toEqual([]);
    expect(fixture.authenticatedSessions()).toBe(1);
  } finally {
    history.release();
    releaseTurn();
    await (await starting).close();
    await fixture.close();
  }
});
