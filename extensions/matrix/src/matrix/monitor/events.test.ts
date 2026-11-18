import { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSentNoticeBodies, installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import type { MatrixClient } from "../sdk.js";
import type { MatrixVerificationSummary } from "../sdk/verification-manager.js";
import { registerMatrixMonitorEvents } from "./events.js";
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
  const events = new EventEmitter();
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
    on: events.on.bind(events),
    off: events.off.bind(events),
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
    return expectDefined(events.listeners(name)[0], name);
  }

  function eventListener(name: string) {
    const callback = getListener(name);
    return (roomId: string, event: EventFixture) => callback(roomId, matrixEvent(event));
  }
  const failedDecrypt = getListener("room.failed_decryption");
  const verificationSummary = getListener("verification.summary");
  const roomEventListener = eventListener("room.event");
  const failedDecryptListener = (
    roomId: string,
    event: Pick<MatrixRawEvent, "event_id"> & Partial<MatrixRawEvent>,
  ) =>
    failedDecrypt(
      roomId,
      matrixEvent({ type: EventType.RoomMessageEncrypted, ...event }),
      new Error("The sender's device has not sent us the keys for this message."),
    );

  return {
    dispose,
    sendMessage,
    invalidateRoom,
    invalidateMemberDisplayName,
    roomInfo,
    rememberInvite,
    roomEventListener,
    emit: async (event: EventFixture, room = ROOM) => {
      roomEventListener(room, event);
      await flushTasks();
    },
    summary: async (overrides: Partial<MatrixVerificationSummary>) => {
      verificationSummary(activeVerification(overrides));
      await flushTasks();
    },
    decrypt: async (event: Pick<MatrixRawEvent, "event_id"> & Partial<MatrixRawEvent>) => {
      failedDecryptListener(ROOM, event);
      await flushTasks();
    },
    bodies: () => getSentNoticeBodies(sendMessage).join("\n"),
    readStoreAllowFrom,
    logger,
    formatNativeDependencyHint,
    logVerboseMessage,
    flushTasks,
    roomMessageListener: eventListener("room.message"),
    failedDecryptListener,
    roomInviteListener: eventListener("room.invite"),
    listenerCount: () => events.eventNames().length,
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
  it("removes every monitor listener on disposal", () => {
    const f = createHarness();
    expect(f.listenerCount()).toBe(8);
    f.dispose();
    expect(f.listenerCount()).toBe(0);
  });

  it("does not repost historical completions during startup catch-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T13:10:00.000Z"));
    const f = createHarness();
    await f.emit({
      ...verificationEvent("$old", "done", "$request"),
      origin_server_ts: Date.now() - 10 * 60_000,
    });
    await vi.runAllTimersAsync();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["done", ["Matrix verification completed with @alice:example.org."]],
    [
      "ready",
      ["Matrix verification is ready with @alice:example.org.", 'Choose "Verify by emoji"'],
    ],
  ] as const)("posts fresh %s guidance", async (stage, expected) => {
    const f = createHarness();
    await f.emit(verificationEvent("$fresh", stage, "$request"));
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    for (const text of expected) {
      expect(f.bodies()).toContain(text);
    }
  });

  it.each(["@mallory:example.org", undefined])(
    "invalidates authoritative member keys: %s",
    (stateKey) => {
      const f = createHarness();
      f.roomEventListener(ROOM, {
        event_id: "$member",
        type: EventType.RoomMember,
        content: { membership: "join" },
        ...(stateKey ? { state_key: stateKey } : {}),
      });
      expect(f.invalidateRoom).toHaveBeenCalledWith(ROOM);
      if (stateKey) {
        expect(f.invalidateMemberDisplayName).toHaveBeenCalledWith(ROOM, stateKey);
      } else {
        expect(f.invalidateMemberDisplayName).not.toHaveBeenCalled();
      }
    },
  );

  it("invalidates only the renamed room, including a cleared name", async () => {
    const names = new Map([
      [ROOM, "Alpha"],
      ["!other:example.org", "Other"],
    ]);
    const f = createHarness({ roomNameByRoom: names });
    const info = expectDefined(f.roomInfo, "room info").getRoomInfo;
    await info(ROOM, { currentName: true });
    await info("!other:example.org", { currentName: true });
    names.set("!other:example.org", "Changed");
    for (const name of ["Beta", ""]) {
      names.set(ROOM, name);
      await f.emit(nameEvent(name));
      await expect(info(ROOM, { currentName: true })).resolves.toMatchObject({
        name,
        nameResolved: true,
      });
      await expect(info("!other:example.org", { currentName: true })).resolves.toMatchObject({
        name: "Other",
      });
    }
  });

  it.each([BOT, ALICE])("tracks invite provenance from %s", (sender) => {
    const f = createHarness();
    f.roomInviteListener(ROOM, {
      event_id: "$invite",
      sender,
      type: EventType.RoomMember,
      content: { membership: "invite" },
      state_key: BOT,
    });
    expect(f.invalidateRoom).toHaveBeenCalledWith(ROOM);
    if (sender === BOT) {
      expect(f.rememberInvite).not.toHaveBeenCalled();
    } else {
      expect(f.rememberInvite).toHaveBeenCalledWith(ROOM, sender);
    }
  });

  it.each<[string, NonNullable<Parameters<typeof createHarness>[0]>, string | null]>([
    ["unpaired", { dmPolicy: "pairing" }, "dmPolicy=pairing"],
    ["paired", { dmPolicy: "pairing", storeAllowFrom: [ALICE] }, null],
    ["disabled DMs", { dmEnabled: false }, "dmPolicy=open, dmEnabled=false"],
  ])("authorizes verification requests for %s", async (_name, options, blockedPolicy) => {
    const f = createHarness(options);
    f.roomMessageListener(ROOM, {
      event_id: "$request",
      type: EventType.RoomMessage,
      content: { msgtype: "m.key.verification.request", body: "verification request" },
    });
    await f.flushTasks();
    if (blockedPolicy) {
      expect(f.logVerboseMessage).toHaveBeenCalledWith(
        "matrix: blocked verification sender " + ALICE + " (" + blockedPolicy + ")",
      );
      expect(f.sendMessage).not.toHaveBeenCalled();
    } else {
      expect(f.readStoreAllowFrom).toHaveBeenCalled();
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    }
  });

  it("blocks summary SAS notices for non-allowlisted senders", async () => {
    const f = createHarness({ dmPolicy: "allowlist", joinedMembersByRoom: strictRooms(DM) });
    await f.summary({ id: "blocked", roomId: DM });
    expect(f.logVerboseMessage).toHaveBeenCalledWith(
      "matrix: blocked verification sender @alice:example.org (dmPolicy=allowlist)",
    );
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("maps summary updates through earlier flow events", async () => {
    const f = createHarness({ joinedMembersByRoom: strictRooms(DM) });
    f.roomEventListener(DM, {
      ...verificationEvent("$start", "start", "$request"),
      content: { transaction_id: "mapped", "m.relates_to": { event_id: "$request" } },
    });
    await f.summary({ id: "verification", transactionId: "mapped", sas: rocketSas });
    expect(f.bodies()).toContain("SAS decimal: 1111 2222 3333");
  });

  it.each([false, true])(
    "prefers the active DM over a remembered room (direct hint=%s)",
    async (direct) => {
      const active = "!active:example.org";
      const recent = "!recent:example.org";
      const f = createHarness({
        joinedMembersByRoom: strictRooms(...(direct ? [recent, active] : [active, recent])),
        ...(direct ? { memberStateByRoomUser: { [active]: { [BOT]: { is_direct: true } } } } : {}),
      });
      await f.emit(verificationEvent("$start", "start", "$request"), recent);
      expect(f.bodies()).toContain("Matrix verification started with");
      f.sendMessage.mockClear();
      await f.summary({ id: "unmapped", sas: rocketSas });
      expect(f.bodies()).toContain("SAS decimal: 1111 2222 3333");
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      expect(f.sendMessage.mock.calls[0]?.[0]).toBe(active);
    },
  );

  it("retries when start arrives before the SAS payload", async () => {
    vi.useFakeTimers();
    const verifications: VerificationFixture[] = [
      {
        id: "race",
        transactionId: "$request",
        otherUserId: ALICE,
        updatedAt: "2026-02-25T21:42:54.000Z",
      },
    ];
    const f = createHarness({
      joinedMembersByRoom: strictRooms(DM),
      verifications,
      sasNoticeRetryDelayMs: 750,
    });
    f.roomEventListener(DM, verificationEvent("$start", "start", "$request"));
    await vi.advanceTimersByTimeAsync(500);
    verifications[0] = { ...expectDefined(verifications[0], "verification"), sas: rocketSas };
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(f.bodies()).toContain("SAS emoji:"));
  });

  it("does not leak verification SAS into an unrelated group", async () => {
    const f = createHarness({
      joinedMembersByRoom: { "!group:example.org": [ALICE, BOT, "@ops:example.org"] },
      verifications: [
        {
          id: "other",
          transactionId: "$different",
          otherUserId: ALICE,
          updatedAt: "2026-02-25T21:42:54.000Z",
          sas: giftSas,
        },
      ],
    });
    await f.emit(verificationEvent("$start", "start", "$request"), "!group:example.org");
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("deduplicates identical SAS payloads across verification stages", async () => {
    const f = createHarness({
      verifications: [
        { id: "verification", transactionId: "$request", otherUserId: ALICE, sas: rocketSas },
      ],
    });
    await f.emit(verificationEvent("$start", "start", "$request"));
    expect(f.sendMessage).toHaveBeenCalled();
    await f.emit(verificationEvent("$key", "key", "$request"));
    expect(f.bodies().match(/SAS emoji:/g)).toHaveLength(1);
  });

  it("falls back to a strict DM when active-room inspection fails", async () => {
    const f = createHarness({
      joinedMembersByRoom: strictRooms(DM),
      getJoinedRoomsError: new Error("temporary joined-room lookup failure"),
      verifications: [activeVerification({ transactionId: "$different" })],
    });
    await f.emit(verificationEvent("$start", "start", "$request"), DM);
    expect(f.bodies()).toContain("SAS decimal: 6158 1986 3513");
  });

  it("chooses the current DM's active summary over a newer unrelated summary", async () => {
    const f = createHarness({
      joinedMembersByRoom: strictRooms(DM),
      verifications: [
        activeVerification({
          id: "other",
          roomId: "!other:example.org",
          transactionId: "$other",
          updatedAt: "2026-02-25T21:44:54.000Z",
          sas: rocketSas,
        }),
        activeVerification({ id: "current", roomId: DM, transactionId: "$different" }),
      ],
    });
    await f.emit(verificationEvent("$start", "start", "$request"), DM);
    expect(f.bodies()).toContain("SAS decimal: 6158 1986 3513");
    expect(f.bodies()).not.toContain("SAS decimal: 1111 2222 3333");
  });

  it("emits cancellation guidance without cancelled SAS", async () => {
    const f = createHarness({
      joinedMembersByRoom: strictRooms(DM),
      verifications: [
        activeVerification({
          id: "cancelled",
          transactionId: "$request",
          phaseName: "cancelled",
          phase: 4,
          pending: false,
          sas: rocketSas,
        }),
      ],
    });
    await f.emit(
      {
        ...verificationEvent("$cancelled", "cancel", "$request"),
        content: {
          code: "m.mismatched_sas",
          reason: "The SAS did not match.",
          "m.relates_to": { event_id: "$request" },
        },
      },
      DM,
    );
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.bodies()).toContain("Matrix verification cancelled by @alice:example.org");
    expect(f.bodies()).not.toContain("SAS decimal:");
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
      const f = createHarness(options);
      for (const event_id of ["$enc1", "$enc2"]) {
        f.roomEventListener(ROOM, { event_id, type: EventType.RoomMessageEncrypted });
      }
      expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(warning, { roomId: ROOM });
      if (options.authEncryption) {
        expect(f.formatNativeDependencyHint).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([true, false])(
    "resolves self-device decrypt guidance (lookup succeeds=%s)",
    async (found) => {
      const sender = "@gumadeiras:matrix.example.org";
      const f = createHarness({
        accountId: "ops",
        selfUserId: sender,
        ...(!found ? { selfUserIdError: new Error("lookup failed") } : {}),
      });
      await f.decrypt({ event_id: "$self", sender });
      expectWarnContextFields(f.logger, 1, "Failed to decrypt message", {
        roomId: ROOM,
        eventId: "$self",
        sender,
        senderMatchesOwnUser: found,
      });
      if (found) {
        expect(f.logger.warn).toHaveBeenNthCalledWith(
          2,
          "matrix: failed to decrypt a message from this same Matrix user. This usually means another Matrix device did not share the room key, or another OpenClaw runtime is using the same account. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
          { roomId: ROOM, eventId: "$self", sender },
        );
      } else {
        expect(f.logger.warn).toHaveBeenCalledTimes(1);
        expect(f.logVerboseMessage).toHaveBeenCalledWith(
          "matrix: failed resolving self user id for decrypt warning: Error: lookup failed",
        );
      }
    },
  );

  it("distinguishes pre-sync from fresh post-sync decrypt failures", async () => {
    const f = healthySyncHarness(false);
    await f.decrypt({
      event_id: "$old",
      sender: "@alice:matrix.example.org",
      origin_server_ts: Date.now() - 5 * 60_000,
    });
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expectWarnContextFields(f.logger, 1, "Failed to decrypt message", {
      eventId: "$old",
      freshAfterHealthySync: false,
    });
    f.healthySync.sinceMs = Date.now();
    await f.decrypt({
      event_id: "$fresh",
      sender: "@alice:matrix.example.org",
      origin_server_ts: Date.now() + 1,
    });
    expectWarnContextFields(f.logger, 2, "Failed to decrypt fresh post-healthy-sync message", {
      eventId: "$fresh",
      freshAfterHealthySync: true,
      postHealthySyncFailureCount: 1,
    });
  });

  it.each(["window expiry", "sync restart"])(
    "resets failure aggregation after %s",
    async (reset) => {
      const f = healthySyncHarness();
      await failureWave(f, "first");
      if (reset === "window expiry") {
        await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
      } else {
        f.healthySync.sinceMs = Date.now();
      }
      await failureWave(f, "second", reset === "sync restart" ? (index) => index : undefined);
      if (reset === "window expiry") {
        expectAggregateWarning(f.logger, 4, "first");
      } else {
        for (const index of [1, 2, 3]) {
          expectWarnContextFields(
            f.logger,
            index + 4,
            "Failed to decrypt fresh post-healthy-sync message",
            {
              eventId: "$enc-second-" + index,
              freshAfterHealthySync: true,
              postHealthySyncFailureCount: index,
            },
          );
        }
      }
      expectAggregateWarning(f.logger, 8, "second");
    },
  );
});
