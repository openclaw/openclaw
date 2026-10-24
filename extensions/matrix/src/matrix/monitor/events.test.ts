import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSentNoticeBody,
  getSentNoticeBodyFromCall,
  getSentNoticeBodies,
  installMatrixMonitorTestRuntime,
} from "../../test-runtime.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import type { MatrixClient } from "../sdk.js";
import type { MatrixVerificationSummary } from "../sdk/verification-manager.js";
import { registerMatrixMonitorEvents } from "./events.js";
import { shouldPromoteRecentInviteRoom } from "./recent-invite.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

type VerificationFixture = Pick<MatrixVerificationSummary, "id" | "otherUserId"> &
  Partial<MatrixVerificationSummary>;
const ROOM = "!room:example.org";
const DM = "!dm:example.org";
const ALICE = "@alice:example.org";
const BOT = "@bot:example.org";
const AGGREGATE_WARNING =
  "matrix: repeated fresh encrypted messages are still failing to decrypt after Matrix resumed healthy sync. This device may still be missing new room keys. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.";

const giftSas: NonNullable<MatrixVerificationSummary["sas"]> = {
  decimal: [6158, 1986, 3513],
  emoji: [["🎁", "Gift"]],
};
const rocketSas: NonNullable<MatrixVerificationSummary["sas"]> = {
  decimal: [1111, 2222, 3333],
  emoji: [["🚀", "Rocket"]],
};

function strictRooms(...roomIds: string[]) {
  return Object.fromEntries(roomIds.map((id) => [id, [ALICE, BOT]]));
}

function createVerificationSummary(
  overrides: Partial<MatrixVerificationSummary>,
): MatrixVerificationSummary {
  return {
    id: "verification",
    otherUserId: ALICE,
    isSelfVerification: false,
    initiatedByMe: false,
    phase: 3,
    phaseName: "started",
    pending: true,
    methods: ["m.sas.v1"],
    canAccept: false,
    hasSas: true,
    sas: giftSas,
    hasReciprocateQr: false,
    completed: false,
    createdAt: "2026-02-25T21:42:54.000Z",
    updatedAt: "2026-02-25T21:42:55.000Z",
    ...overrides,
  };
}

type EventFixture = Pick<MatrixRawEvent, "event_id" | "type"> & Partial<MatrixRawEvent>;
function matrixEvent(overrides: EventFixture): MatrixRawEvent {
  return { sender: ALICE, origin_server_ts: Date.now(), content: {}, ...overrides };
}

function verificationEvent(eventId: string, stage: string, requestId: string): EventFixture {
  return {
    event_id: eventId,
    type: `m.key.verification.${stage}`,
    content: { "m.relates_to": { event_id: requestId } },
  };
}

function activeVerification(overrides: Partial<VerificationFixture>): VerificationFixture {
  return {
    id: "verification-active",
    otherUserId: ALICE,
    updatedAt: "2026-02-25T21:43:54.000Z",
    phaseName: "started",
    phase: 3,
    pending: true,
    sas: giftSas,
    ...overrides,
  };
}

function nameEvent(name: string): EventFixture {
  return { event_id: `$name-${name}`, type: "m.room.name", state_key: "", content: { name } };
}

function expectAggregateWarning(
  logger: { warn: ReturnType<typeof vi.fn> },
  callIndex: number,
  wave: string,
) {
  expectWarnContextFields(logger, callIndex, AGGREGATE_WARNING, {
    sampleEventIds: [1, 2, 3].map((index) => `$enc-${wave}-${index}`),
  });
}

beforeEach(() => installMatrixMonitorTestRuntime());
afterEach(() => vi.useRealTimers());

function expectBodiesContain(bodies: string[], text: string) {
  expect(bodies.join("\n")).toContain(text);
}

function expectBodiesExclude(bodies: string[], text: string) {
  expect(bodies.join("\n")).not.toContain(text);
}

function expectWarnContextFields(
  logger: { warn: ReturnType<typeof vi.fn> },
  callIndex: number,
  message: string,
  fields: Record<string, unknown>,
) {
  expect(logger.warn).toHaveBeenNthCalledWith(callIndex, message, expect.objectContaining(fields));
}

function createHarness(params?: {
  cfg?: CoreConfig;
  accountId?: string;
  authEncryption?: boolean;
  cryptoAvailable?: boolean;
  selfUserId?: string;
  selfUserIdError?: Error;
  getHealthySyncSinceMs?: () => number | undefined;
  allowFrom?: string[];
  dmEnabled?: boolean;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  storeAllowFrom?: string[];
  joinedMembersByRoom?: Record<string, string[]>;
  getJoinedRoomsError?: Error;
  memberStateByRoomUser?: Record<string, Record<string, { is_direct?: boolean }>>;
  /** Homeserver m.room.name state; when set, the monitor gets the real room info resolver. */
  roomNameByRoom?: Map<string, string>;
  verifications?: VerificationFixture[];
  sasNoticeRetryDelayMs?: number;
}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const pendingTasks = new Set<Promise<void>>();
  const runDetachedTask = vi.fn((_label: string, task: () => Promise<void>) => {
    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        pendingTasks.delete(promise);
      });
    pendingTasks.add(promise);
    return promise;
  });
  const flushTasks = async () => {
    while (pendingTasks.size > 0) {
      await Promise.all(Array.from(pendingTasks));
    }
  };
  const listVerifications = vi.fn(async () => params?.verifications ?? []);
  const sendMessage = vi.fn(async (_roomId: string, _payload: { body?: string }) => "$notice");
  const invalidateRoom = vi.fn();
  const invalidateMemberDisplayName = vi.fn();
  const rememberInvite = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const formatNativeDependencyHint = vi.fn(() => "install hint");
  const logVerboseMessage = vi.fn();
  const readStoreAllowFrom = vi.fn(async () => params?.storeAllowFrom ?? []);
  const client = {
    on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      listeners.set(eventName, listener);
      return client;
    }),
    off: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      if (listeners.get(eventName) === listener) {
        listeners.delete(eventName);
      }
      return client;
    }),
    sendMessage,
    getUserId: vi.fn(async () => {
      if (params?.selfUserIdError) {
        throw params.selfUserIdError;
      }
      return params?.selfUserId ?? BOT;
    }),
    getJoinedRoomMembers: vi.fn(
      async (roomId: string) => params?.joinedMembersByRoom?.[roomId] ?? [BOT, ALICE],
    ),
    getJoinedRooms: vi.fn(async () =>
      params?.getJoinedRoomsError
        ? await Promise.reject(params.getJoinedRoomsError)
        : Object.keys(params?.joinedMembersByRoom ?? {}).length > 0
          ? Object.keys(params?.joinedMembersByRoom ?? {})
          : [ROOM],
    ),
    getAccountData: vi.fn(async () => undefined),
    getRoomStateEvent: vi.fn(async (roomId: string, eventType: string, stateKey: string) =>
      eventType === "m.room.name" && params?.roomNameByRoom?.has(roomId)
        ? { name: params.roomNameByRoom.get(roomId) }
        : (params?.memberStateByRoomUser?.[roomId]?.[stateKey] ?? {}),
    ),
    ...(params?.cryptoAvailable === false
      ? {}
      : { crypto: { listVerifications, ensureVerificationDmTracked: vi.fn(async () => null) } }),
  } as unknown as MatrixClient;
  const roomInfo = params?.roomNameByRoom ? createMatrixRoomInfoResolver(client) : undefined;

  const dmPolicy = params?.dmPolicy ?? "open";
  const allowFrom = params?.allowFrom ?? (dmPolicy === "open" ? ["*"] : []);

  const dispose = registerMatrixMonitorEvents({
    cfg: params?.cfg ?? { channels: { matrix: {} } },
    client,
    auth: {
      accountId: params?.accountId ?? "default",
      encryption: params?.authEncryption ?? true,
    } as MatrixAuth,
    allowFrom,
    dmEnabled: params?.dmEnabled ?? true,
    dmPolicy,
    readStoreAllowFrom,
    directTracker: { invalidateRoom, rememberInvite, isDirectMessage: vi.fn(async () => false) },
    groupPolicy: "allowlist",
    needsRoomAliasesForConfig: false,
    getRoomInfo:
      roomInfo?.getRoomInfo ??
      vi.fn(async () => ({ altAliases: [], nameResolved: true, aliasesResolved: true })),
    invalidateMemberDisplayName,
    invalidateRoomName: roomInfo?.invalidateRoomName,
    logVerboseMessage,
    warnedEncryptedRooms: new Set<string>(),
    warnedCryptoMissingRooms: new Set<string>(),
    logger,
    getHealthySyncSinceMs: params?.getHealthySyncSinceMs,
    formatNativeDependencyHint,
    runDetachedTask,
    sasNoticeRetryDelayMs: params?.sasNoticeRetryDelayMs ?? 0,
  });

  function getListener(name: string) {
    return expectDefined(listeners.get(name), name);
  }

  function eventListener(name: string) {
    const callback = getListener(name);
    return (roomId: string, event: EventFixture) => callback(roomId, matrixEvent(event));
  }
  const failedDecrypt = getListener("room.failed_decryption");
  const verificationSummary = getListener("verification.summary");

  return {
    dispose,
    sendMessage,
    invalidateRoom,
    invalidateMemberDisplayName,
    roomInfo,
    rememberInvite,
    roomEventListener: eventListener("room.event"),
    listVerifications,
    readStoreAllowFrom,
    logger,
    formatNativeDependencyHint,
    logVerboseMessage,
    flushTasks,
    roomMessageListener: eventListener("room.message"),
    failedDecryptListener: (
      roomId: string,
      event: Pick<MatrixRawEvent, "event_id"> & Partial<MatrixRawEvent>,
      error = new Error("The sender's device has not sent us the keys for this message."),
    ) =>
      failedDecrypt(roomId, matrixEvent({ type: EventType.RoomMessageEncrypted, ...event }), error),
    verificationSummaryListener: (summary: MatrixVerificationSummary) =>
      verificationSummary(summary),
    roomInviteListener: eventListener("room.invite"),
    listenerCount: () => listeners.size,
    off: (client as unknown as { off: ReturnType<typeof vi.fn> }).off,
    on: (client as unknown as { on: ReturnType<typeof vi.fn> }).on,
  };
}

function healthySyncHarness(ready = true) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
  const healthySync: { sinceMs: number | undefined } = {
    sinceMs: ready ? Date.now() - 60_000 : undefined,
  };
  return {
    ...createHarness({ accountId: "ops", getHealthySyncSinceMs: () => healthySync.sinceMs }),
    healthySync,
  };
}

async function failureWave(
  harness: ReturnType<typeof healthySyncHarness>,
  label: string,
  offset = (index: number) => -index * 1_000,
) {
  for (const index of [1, 2, 3]) {
    harness.failedDecryptListener(`!room-${label}-${index}:example.org`, {
      event_id: `$enc-${label}-${index}`,
      sender: `@alice-${label}-${index}:matrix.example.org`,
      origin_server_ts: Date.now() + offset(index),
    });
    await harness.flushTasks();
  }
}

describe("registerMatrixMonitorEvents verification routing", () => {
  it("removes every exact monitor listener on disposal", () => {
    const { dispose, listenerCount, off, on } = createHarness();
    const registeredListeners = on.mock.calls.map(
      ([eventName, listener]) => [eventName, listener] as const,
    );

    expect(listenerCount()).toBe(8);
    dispose();

    expect(listenerCount()).toBe(0);
    expect(off).toHaveBeenCalledTimes(8);
    for (const [eventName, listener] of registeredListeners) {
      expect(off).toHaveBeenCalledWith(eventName, listener);
    }
  });

  it("does not repost historical verification completions during startup catch-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T13:10:00.000Z"));
    const { sendMessage, roomEventListener } = createHarness();

    roomEventListener(ROOM, {
      event_id: "$done-old",
      type: "m.key.verification.done",
      origin_server_ts: Date.now() - 10 * 60 * 1000,
      content: { "m.relates_to": { event_id: "$req-old" } },
    });

    await vi.runAllTimersAsync();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["done", ["Matrix verification completed with @alice:example.org."]],
    [
      "ready",
      ["Matrix verification is ready with @alice:example.org.", 'Choose "Verify by emoji"'],
    ],
  ] as const)("posts fresh %s verification guidance", async (stage, expected) => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness();
    roomEventListener(ROOM, verificationEvent("$fresh", stage, "$req-fresh"));
    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    for (const text of expected) {
      expect(getSentNoticeBody(sendMessage)).toContain(text);
    }
  });

  it.each(["@mallory:example.org", undefined])(
    "invalidates only authoritative member cache keys: %s",
    (stateKey) => {
      const { invalidateRoom, invalidateMemberDisplayName, roomEventListener } = createHarness();
      roomEventListener(ROOM, {
        event_id: "$member",
        type: EventType.RoomMember,
        content: { membership: "join" },
        ...(stateKey ? { state_key: stateKey } : {}),
      });
      expect(invalidateRoom).toHaveBeenCalledWith(ROOM);
      if (stateKey) {
        expect(invalidateMemberDisplayName).toHaveBeenCalledWith(ROOM, stateKey);
      } else {
        expect(invalidateMemberDisplayName).not.toHaveBeenCalled();
      }
    },
  );

  it("serves a room's current name after an m.room.name event, including a cleared name", async () => {
    const roomNameByRoom = new Map([
      [ROOM, "Room Alpha"],
      ["!other:example.org", "Room Other"],
    ]);
    const { roomInfo, roomEventListener } = createHarness({ roomNameByRoom });
    const { getRoomInfo } = expectDefined(roomInfo, "room info resolver");
    const currentInfo = (roomId: string) => getRoomInfo(roomId, { currentName: true });

    await expect(currentInfo(ROOM)).resolves.toMatchObject({ name: "Room Alpha" });
    await expect(currentInfo("!other:example.org")).resolves.toMatchObject({ name: "Room Other" });

    // The homeserver state changes; the cached name is kept until the room's name event arrives.
    roomNameByRoom.set(ROOM, "Room Beta");
    roomNameByRoom.set("!other:example.org", "Room Other Two");
    await expect(currentInfo(ROOM)).resolves.toMatchObject({ name: "Room Alpha" });

    roomEventListener(ROOM, nameEvent("Room Beta"));
    await expect(currentInfo(ROOM)).resolves.toMatchObject({
      name: "Room Beta",
      nameResolved: true,
    });
    await expect(currentInfo("!other:example.org")).resolves.toMatchObject({ name: "Room Other" });

    roomNameByRoom.set(ROOM, "");
    roomEventListener(ROOM, nameEvent(""));
    await expect(currentInfo(ROOM)).resolves.toMatchObject({
      name: "",
      nameResolved: true,
    });
  });

  it("keeps DM promotion on the first room name it resolved after a rename", async () => {
    const roomNameByRoom = new Map([["!named:example.org", "Room Alpha"]]);
    const { roomInfo, roomEventListener } = createHarness({ roomNameByRoom });
    const { getRoomInfo } = expectDefined(roomInfo, "room info resolver");
    // The lookup and check the monitor's direct-room tracker runs before promoting a room.
    const promotionView = async (roomId: string) => {
      const info = await getRoomInfo(roomId, { includeAliases: true });
      return {
        name: info.name,
        promotable: shouldPromoteRecentInviteRoom({ roomId, roomInfo: info }),
      };
    };

    await expect(promotionView("!named:example.org")).resolves.toEqual({
      name: "Room Alpha",
      promotable: false,
    });
    await expect(promotionView("!unnamed:example.org")).resolves.toEqual({
      name: undefined,
      promotable: true,
    });

    roomNameByRoom.set("!named:example.org", "");
    roomEventListener("!named:example.org", nameEvent(""));
    roomNameByRoom.set("!unnamed:example.org", "Room Bravo");
    roomEventListener("!unnamed:example.org", nameEvent("Room Bravo"));

    await expect(promotionView("!named:example.org")).resolves.toEqual({
      name: "Room Alpha",
      promotable: false,
    });
    await expect(promotionView("!unnamed:example.org")).resolves.toEqual({
      name: undefined,
      promotable: true,
    });
  });

  it.each([BOT, ALICE])("tracks invite provenance from %s", (sender) => {
    const { invalidateRoom, rememberInvite, roomInviteListener } = createHarness();
    roomInviteListener(ROOM, {
      event_id: "$invite",
      sender,
      type: EventType.RoomMember,
      content: { membership: "invite" },
      state_key: BOT,
    });
    expect(invalidateRoom).toHaveBeenCalledWith(ROOM);
    if (sender === BOT) {
      expect(rememberInvite).not.toHaveBeenCalled();
    } else {
      expect(rememberInvite).toHaveBeenCalledWith(ROOM, sender);
    }
  });

  it.each<[string, NonNullable<Parameters<typeof createHarness>[0]>, string | null]>([
    ["unpaired", { dmPolicy: "pairing" }, "dmPolicy=pairing"],
    ["paired", { dmPolicy: "pairing", storeAllowFrom: [ALICE] }, null],
    ["disabled DMs", { dmEnabled: false }, "dmPolicy=open, dmEnabled=false"],
  ])("authorizes verification requests for %s", async (_name, options, blockedPolicy) => {
    const { sendMessage, roomMessageListener, logVerboseMessage, readStoreAllowFrom, flushTasks } =
      createHarness(options);

    roomMessageListener(ROOM, {
      event_id: "$request",
      type: EventType.RoomMessage,
      content: { msgtype: "m.key.verification.request", body: "verification request" },
    });

    await flushTasks();
    if (blockedPolicy) {
      expect(logVerboseMessage).toHaveBeenCalledWith(
        `matrix: blocked verification sender ${ALICE} (${blockedPolicy})`,
      );
      expect(sendMessage).not.toHaveBeenCalled();
    } else {
      expect(readStoreAllowFrom).toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    }
  });

  it("blocks summary SAS notices when dmPolicy allowlist would block the sender", async () => {
    const { sendMessage, verificationSummaryListener, logVerboseMessage, flushTasks } =
      createHarness({
        dmPolicy: "allowlist",
        joinedMembersByRoom: strictRooms(DM),
      });

    verificationSummaryListener(
      createVerificationSummary({ id: "verification-blocked-summary", roomId: DM }),
    );

    await flushTasks();
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix: blocked verification sender @alice:example.org (dmPolicy=allowlist)",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("posts SAS notices from summary updates using the room mapped by earlier flow events", async () => {
    const { sendMessage, roomEventListener, verificationSummaryListener, flushTasks } =
      createHarness({
        joinedMembersByRoom: strictRooms(DM),
      });

    roomEventListener(DM, {
      event_id: "$start-mapped",
      type: "m.key.verification.start",
      content: { transaction_id: "txn-mapped-room", "m.relates_to": { event_id: "$req-mapped" } },
    });

    verificationSummaryListener(
      createVerificationSummary({
        id: "verification-mapped",
        transactionId: "txn-mapped-room",
        sas: rocketSas,
      }),
    );

    await flushTasks();
    expectBodiesContain(getSentNoticeBodies(sendMessage), "SAS decimal: 1111 2222 3333");
  });

  it("prefers the canonical active DM over the most recent verification room for unmapped SAS summaries", async () => {
    const { sendMessage, roomEventListener, verificationSummaryListener, flushTasks } =
      createHarness({
        joinedMembersByRoom: strictRooms("!dm-active:example.org", "!dm-current:example.org"),
      });

    roomEventListener(
      "!dm-current:example.org",
      verificationEvent("$start-current", "start", "$req-current"),
    );

    await flushTasks();
    expectBodiesContain(getSentNoticeBodies(sendMessage), "Matrix verification started with");

    verificationSummaryListener(
      createVerificationSummary({
        id: "verification-current-room",
        sas: {
          decimal: [2468, 1357, 9753],
          emoji: [["🔔", "Bell"]],
        },
      }),
    );

    await flushTasks();
    expectBodiesContain(getSentNoticeBodies(sendMessage), "SAS decimal: 2468 1357 9753");
    const calls = sendMessage.mock.calls;
    const sasCall = calls.find((call) =>
      getSentNoticeBodyFromCall(call).includes("SAS decimal: 2468 1357 9753"),
    );
    expect(sasCall?.[0] ?? "").toBe("!dm-active:example.org");
  });

  it("retries SAS notice lookup when start arrives before SAS payload is available", async () => {
    vi.useFakeTimers();
    const verifications: VerificationFixture[] = [
      {
        id: "verification-race",
        transactionId: "$req-race",
        updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
        otherUserId: ALICE,
      },
    ];
    const { sendMessage, roomEventListener } = createHarness({
      joinedMembersByRoom: strictRooms(DM),
      verifications,
      sasNoticeRetryDelayMs: 750,
    });

    roomEventListener(DM, verificationEvent("$start-race", "start", "$req-race"));

    await vi.advanceTimersByTimeAsync(500);
    const verification = expectDefined(verifications[0], "Matrix verification summary");
    verifications[0] = {
      ...verification,
      sas: {
        decimal: [1234, 5678, 9012],
        emoji: [["🚀", "Rocket"]],
      },
    };
    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      const bodies = getSentNoticeBodies(sendMessage);
      expectBodiesContain(bodies, "SAS emoji:");
    });
  });

  it("ignores verification notices in unrelated non-DM rooms", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: {
        "!group:example.org": [ALICE, BOT, "@ops:example.org"],
      },
      verifications: [
        {
          id: "verification-2",
          transactionId: "$different-flow-id",
          otherUserId: ALICE,
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
          sas: giftSas,
        },
      ],
    });

    roomEventListener(
      "!group:example.org",
      verificationEvent("$start-group", "start", "$req-group"),
    );

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(0);
  });

  it("prefers the active direct room over a stale remembered strict room for unmapped summaries", async () => {
    const { sendMessage, roomEventListener, verificationSummaryListener, flushTasks } =
      createHarness({
        joinedMembersByRoom: strictRooms("!fallback:example.org", DM),
        memberStateByRoomUser: { [DM]: { [BOT]: { is_direct: true } } },
      });

    roomEventListener(
      "!fallback:example.org",
      verificationEvent("$start-fallback", "start", "$req-fallback"),
    );

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    sendMessage.mockClear();

    verificationSummaryListener(createVerificationSummary({ id: "verification-stale-room" }));

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((sendMessage.mock.calls as unknown[][])[0]?.[0]).toBe(DM);
  });

  it("does not emit duplicate SAS notices for the same verification payload", async () => {
    const { sendMessage, roomEventListener, listVerifications, flushTasks } = createHarness({
      verifications: [
        {
          id: "verification-3",
          transactionId: "$req3",
          otherUserId: ALICE,
          sas: rocketSas,
        },
      ],
    });

    roomEventListener(ROOM, verificationEvent("$start3", "start", "$req3"));
    await flushTasks();
    expect(sendMessage.mock.calls.length).toBeGreaterThan(0);

    roomEventListener(ROOM, verificationEvent("$key3", "key", "$req3"));
    await flushTasks();
    expect(listVerifications).toHaveBeenCalledTimes(2);

    const sasBodies = getSentNoticeBodies(sendMessage).filter((body) =>
      body.includes("SAS emoji:"),
    );
    expect(sasBodies).toHaveLength(1);
  });

  it("preserves strict-room SAS fallback when active DM inspection cannot resolve a room", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: strictRooms(DM),
      getJoinedRoomsError: new Error("temporary joined-room lookup failure"),
      verifications: [activeVerification({ transactionId: "$different-flow-id" })],
    });

    roomEventListener(DM, verificationEvent("$start-active", "start", "$req-active"));

    await flushTasks();
    expectBodiesContain(getSentNoticeBodies(sendMessage), "SAS decimal: 6158 1986 3513");
  });

  it("prefers the active verification for the current DM when multiple active summaries exist", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: strictRooms("!dm-current:example.org"),
      verifications: [
        activeVerification({
          id: "verification-other-room",
          roomId: "!dm-other:example.org",
          transactionId: "$different-flow-other",
          updatedAt: "2026-02-25T21:44:54.000Z",
          sas: rocketSas,
        }),
        activeVerification({
          id: "verification-current-room",
          roomId: "!dm-current:example.org",
          transactionId: "$different-flow-current",
        }),
      ],
    });

    roomEventListener(
      "!dm-current:example.org",
      verificationEvent("$start-room-scoped", "start", "$req-room-scoped"),
    );

    await flushTasks();
    const bodies = getSentNoticeBodies(sendMessage);
    expectBodiesContain(bodies, "SAS decimal: 6158 1986 3513");
    expectBodiesExclude(bodies, "SAS decimal: 1111 2222 3333");
  });

  it("does not emit SAS notices for cancelled verification events", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: strictRooms(DM),
      verifications: [
        activeVerification({
          id: "verification-cancelled",
          transactionId: "$req-cancelled",
          updatedAt: "2026-02-25T21:42:54.000Z",
          phaseName: "cancelled",
          phase: 4,
          pending: false,
          sas: rocketSas,
        }),
      ],
    });

    roomEventListener(DM, {
      event_id: "$cancelled-1",
      type: "m.key.verification.cancel",
      content: {
        code: "m.mismatched_sas",
        reason: "The SAS did not match.",
        "m.relates_to": { event_id: "$req-cancelled" },
      },
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification cancelled by @alice:example.org");
    expect(body).not.toContain("SAS decimal:");
  });

  it.each([
    [
      { authEncryption: false },
      "matrix: encrypted event received without encryption enabled; set channels.matrix.encryption=true and verify the device to decrypt",
    ],
    [
      {
        accountId: "ops",
        authEncryption: false,
        cfg: { channels: { matrix: { accounts: { ops: {} } } } },
      },
      "matrix: encrypted event received without encryption enabled; set channels.matrix.accounts.ops.encryption=true and verify the device to decrypt",
    ],
    [
      { authEncryption: true, cryptoAvailable: false },
      "matrix: encryption enabled but crypto is unavailable; install hint",
    ],
  ] satisfies Array<[NonNullable<Parameters<typeof createHarness>[0]>, string]>)(
    "warns once for encrypted events with %j",
    (options, warning) => {
      const { formatNativeDependencyHint, logger, roomEventListener } = createHarness(options);
      for (const event_id of ["$enc1", "$enc2"]) {
        roomEventListener(ROOM, { event_id, type: EventType.RoomMessageEncrypted });
      }
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(warning, { roomId: ROOM });
      if (options.authEncryption) {
        expect(formatNativeDependencyHint).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("adds self-device guidance when decrypt failures come from the same Matrix user", async () => {
    const { logger, failedDecryptListener, flushTasks } = createHarness({
      accountId: "ops",
      selfUserId: "@gumadeiras:matrix.example.org",
    });

    failedDecryptListener(ROOM, {
      event_id: "$enc-self",
      sender: "@gumadeiras:matrix.example.org",
    });
    await flushTasks();

    expectWarnContextFields(logger, 1, "Failed to decrypt message", {
      roomId: ROOM,
      eventId: "$enc-self",
      sender: "@gumadeiras:matrix.example.org",
      senderMatchesOwnUser: true,
    });
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      "matrix: failed to decrypt a message from this same Matrix user. This usually means another Matrix device did not share the room key, or another OpenClaw runtime is using the same account. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
      {
        roomId: ROOM,
        eventId: "$enc-self",
        sender: "@gumadeiras:matrix.example.org",
      },
    );
  });

  it("keeps decrypt failures before healthy sync on the generic warning path", async () => {
    const { logger, failedDecryptListener, flushTasks, healthySync } = healthySyncHarness(false);

    failedDecryptListener(ROOM, {
      event_id: "$enc-old",
      sender: "@alice:matrix.example.org",
      origin_server_ts: Date.now() - 5 * 60_000,
    });
    await flushTasks();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expectWarnContextFields(logger, 1, "Failed to decrypt message", {
      eventId: "$enc-old",
      freshAfterHealthySync: false,
    });

    healthySync.sinceMs = Date.now();

    failedDecryptListener(ROOM, {
      event_id: "$enc-fresh-after-ready",
      sender: "@alice:matrix.example.org",
      origin_server_ts: Date.now() + 1,
    });
    await flushTasks();

    expectWarnContextFields(logger, 2, "Failed to decrypt fresh post-healthy-sync message", {
      eventId: "$enc-fresh-after-ready",
      freshAfterHealthySync: true,
      postHealthySyncFailureCount: 1,
    });
  });

  it("re-emits the aggregate warning for a new failure wave after the window clears", async () => {
    const harness = healthySyncHarness();
    const { logger } = harness;

    for (const wave of [1, 2]) {
      await failureWave(harness, `wave-${wave}`);

      if (wave === 1) {
        await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
      }
    }

    expectAggregateWarning(logger, 4, "wave-1");
    expectAggregateWarning(logger, 8, "wave-2");
  });

  it("resets tracked failures when healthy sync restarts before the old window expires", async () => {
    const harness = healthySyncHarness();
    const { logger, healthySync } = harness;
    await failureWave(harness, "first");
    healthySync.sinceMs = Date.now();
    await failureWave(harness, "second", (index) => index);

    for (const index of [1, 2, 3]) {
      expectWarnContextFields(
        logger,
        index + 4,
        "Failed to decrypt fresh post-healthy-sync message",
        {
          eventId: `$enc-second-${index}`,
          freshAfterHealthySync: true,
          postHealthySyncFailureCount: index,
        },
      );
    }
    expectAggregateWarning(logger, 8, "second");
  });

  it("logs decrypt guidance when getUserId fails during lookup", async () => {
    const { logger, logVerboseMessage, failedDecryptListener, flushTasks } = createHarness({
      accountId: "ops",
      selfUserIdError: new Error("lookup failed"),
    });

    failedDecryptListener(ROOM, {
      event_id: "$enc-lookup-fail",
      sender: "@gumadeiras:matrix.example.org",
    });
    await flushTasks();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expectWarnContextFields(logger, 1, "Failed to decrypt message", {
      roomId: ROOM,
      eventId: "$enc-lookup-fail",
      senderMatchesOwnUser: false,
    });
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix: failed resolving self user id for decrypt warning: Error: lookup failed",
    );
  });
});
