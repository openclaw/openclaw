import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
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
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

type VerificationFixture = Pick<MatrixVerificationSummary, "id" | "otherUserId"> &
  Partial<MatrixVerificationSummary>;

const giftSas: NonNullable<MatrixVerificationSummary["sas"]> = {
  decimal: [6158, 1986, 3513],
  emoji: [["🎁", "Gift"]],
};
const rocketSas: NonNullable<MatrixVerificationSummary["sas"]> = {
  decimal: [1111, 2222, 3333],
  emoji: [["🚀", "Rocket"]],
};

function strictRooms(...roomIds: string[]) {
  return Object.fromEntries(roomIds.map((id) => [id, ["@alice:example.org", "@bot:example.org"]]));
}

function createVerificationSummary(
  overrides: Partial<MatrixVerificationSummary>,
): MatrixVerificationSummary {
  return {
    id: "verification",
    otherUserId: "@alice:example.org",
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
  return { sender: "@alice:example.org", origin_server_ts: Date.now(), content: {}, ...overrides };
}

function verificationEvent(eventId: string, stage: string, requestId: string): EventFixture {
  return {
    event_id: eventId,
    type: `m.key.verification.${stage}`,
    content: { "m.relates_to": { event_id: requestId } },
  };
}

beforeEach(() => installMatrixMonitorTestRuntime());
afterEach(() => vi.useRealTimers());

function expectBodiesContain(bodies: string[], text: string) {
  expect(bodies.join("\n")).toContain(text);
}

function expectBodiesExclude(bodies: string[], text: string) {
  expect(bodies.join("\n")).not.toContain(text);
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectWarnContextFields(
  logger: { warn: ReturnType<typeof vi.fn> },
  callIndex: number,
  message: string,
  fields: Record<string, unknown>,
) {
  const call = logger.warn.mock.calls[callIndex - 1] as unknown[];
  expect(call?.[0]).toBe(message);
  expect(requireRecord(call?.[1], "logger warning context")).toMatchObject(fields);
}

function createHarness(params?: {
  cfg?: CoreConfig;
  accountId?: string;
  authEncryption?: boolean;
  cryptoAvailable?: boolean;
  selfUserId?: string;
  selfUserIdError?: Error;
  startupMs?: number;
  getHealthySyncSinceMs?: () => number | undefined;
  allowFrom?: string[];
  dmEnabled?: boolean;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  storeAllowFrom?: string[];
  accountDataByType?: Record<string, unknown>;
  joinedMembersByRoom?: Record<string, string[]>;
  getJoinedRoomsError?: Error;
  memberStateByRoomUser?: Record<string, Record<string, { is_direct?: boolean }>>;
  verifications?: VerificationFixture[];
  ensureVerificationDmTracked?: () => Promise<VerificationFixture | null>;
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
  const onRoomMessage = vi.fn(async () => {});
  const listVerifications = vi.fn(async () => params?.verifications ?? []);
  const ensureVerificationDmTracked = vi.fn(
    params?.ensureVerificationDmTracked ?? (async () => null),
  );
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
      return params?.selfUserId ?? "@bot:example.org";
    }),
    getJoinedRoomMembers: vi.fn(
      async (roomId: string) =>
        params?.joinedMembersByRoom?.[roomId] ?? ["@bot:example.org", "@alice:example.org"],
    ),
    getJoinedRooms: vi.fn(async () =>
      params?.getJoinedRoomsError
        ? await Promise.reject(params.getJoinedRoomsError)
        : Object.keys(params?.joinedMembersByRoom ?? {}).length > 0
          ? Object.keys(params?.joinedMembersByRoom ?? {})
          : ["!room:example.org"],
    ),
    getAccountData: vi.fn(
      async (eventType: string) =>
        (params?.accountDataByType?.[eventType] as Record<string, unknown> | undefined) ??
        undefined,
    ),
    getRoomStateEvent: vi.fn(
      async (roomId: string, _eventType: string, stateKey: string) =>
        params?.memberStateByRoomUser?.[roomId]?.[stateKey] ?? {},
    ),
    ...(params?.cryptoAvailable === false
      ? {}
      : { crypto: { listVerifications, ensureVerificationDmTracked } }),
  } as unknown as MatrixClient;

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
    getRoomInfo: vi.fn(async () => ({ altAliases: [], nameResolved: true, aliasesResolved: true })),
    invalidateMemberDisplayName,
    logVerboseMessage,
    warnedEncryptedRooms: new Set<string>(),
    warnedCryptoMissingRooms: new Set<string>(),
    logger,
    getHealthySyncSinceMs:
      params?.getHealthySyncSinceMs ??
      (typeof params?.startupMs === "number" ? () => params.startupMs : undefined),
    formatNativeDependencyHint,
    onRoomMessage,
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
    onRoomMessage,
    sendMessage,
    invalidateRoom,
    invalidateMemberDisplayName,
    rememberInvite,
    roomEventListener: eventListener("room.event"),
    listVerifications,
    readStoreAllowFrom,
    logger,
    formatNativeDependencyHint,
    logVerboseMessage,
    flushTasks,
    runDetachedTask,
    roomMessageListener: eventListener("room.message"),
    roomDecryptedEventListener: eventListener("room.decrypted_event"),
    failedDecryptListener: (
      roomId: string,
      event: Pick<MatrixRawEvent, "event_id"> & Partial<MatrixRawEvent>,
      error = new Error("The sender's device has not sent us the keys for this message."),
    ) =>
      failedDecrypt(roomId, matrixEvent({ type: EventType.RoomMessageEncrypted, ...event }), error),
    verificationSummaryListener: (summary: MatrixVerificationSummary) =>
      verificationSummary(summary),
    roomInviteListener: eventListener("room.invite"),
    roomJoinListener: eventListener("room.join"),
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

    roomEventListener("!room:example.org", {
      event_id: "$done-old",
      type: "m.key.verification.done",
      origin_server_ts: Date.now() - 10 * 60 * 1000,
      content: { "m.relates_to": { event_id: "$req-old" } },
    });

    await vi.runAllTimersAsync();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("still posts fresh verification completions", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness();

    roomEventListener("!room:example.org", verificationEvent("$done-fresh", "done", "$req-fresh"));

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(getSentNoticeBody(sendMessage)).toContain(
      "Matrix verification completed with @alice:example.org.",
    );
  });

  it("forwards reaction room events into the shared room handler", async () => {
    const { onRoomMessage, sendMessage, roomEventListener, flushTasks } = createHarness();

    roomEventListener("!room:example.org", {
      event_id: "$reaction1",
      type: EventType.Reaction,
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$msg1", key: "👍" } },
    });

    await flushTasks();
    const roomMessageCalls = onRoomMessage.mock.calls as unknown[][];
    expect(roomMessageCalls[0]?.[0]).toBe("!room:example.org");
    expect(requireRecord(roomMessageCalls[0]?.[1], "reaction event")).toMatchObject({
      event_id: "$reaction1",
      type: EventType.Reaction,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(["@mallory:example.org", undefined])(
    "invalidates only authoritative member cache keys: %s",
    (stateKey) => {
      const { invalidateRoom, invalidateMemberDisplayName, roomEventListener } = createHarness();
      roomEventListener("!room:example.org", {
        event_id: "$member",
        type: EventType.RoomMember,
        content: { membership: "join" },
        ...(stateKey ? { state_key: stateKey } : {}),
      });
      expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
      if (stateKey) {
        expect(invalidateMemberDisplayName).toHaveBeenCalledWith("!room:example.org", stateKey);
      } else {
        expect(invalidateMemberDisplayName).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["@bot:example.org", "@alice:example.org"])(
    "tracks invite provenance from %s",
    (sender) => {
      const { invalidateRoom, rememberInvite, roomInviteListener } = createHarness();
      roomInviteListener("!room:example.org", {
        event_id: "$invite",
        sender,
        type: EventType.RoomMember,
        content: { membership: "invite" },
        state_key: "@bot:example.org",
      });
      expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
      if (sender === "@bot:example.org") {
        expect(rememberInvite).not.toHaveBeenCalled();
      } else {
        expect(rememberInvite).toHaveBeenCalledWith("!room:example.org", sender);
      }
    },
  );

  it("routes late-decrypted room messages through the normal room handler", async () => {
    const { onRoomMessage, roomDecryptedEventListener, flushTasks } = createHarness();
    const event: MatrixRawEvent = matrixEvent({
      event_id: "$decrypted1",
      type: EventType.RoomMessage,
      content: { msgtype: "m.text", body: "@bot late decrypt trigger" },
    });

    roomDecryptedEventListener("!room:example.org", event);

    await flushTasks();
    expect(onRoomMessage).toHaveBeenCalledTimes(1);
    expect(onRoomMessage).toHaveBeenCalledWith("!room:example.org", event);
  });

  it.each<{
    name: string;
    eventId: string;
    options: NonNullable<Parameters<typeof createHarness>[0]>;
    accepted: boolean;
    storeConsulted?: boolean;
    blockedLog?: string;
    expectNoRoomDispatch?: boolean;
  }>([
    {
      name: "blocks verification request notices when dmPolicy pairing would block the sender",
      eventId: "$req-pairing-blocked",
      options: { dmPolicy: "pairing" },
      accepted: false,
      blockedLog: "matrix: blocked verification sender @alice:example.org (dmPolicy=pairing)",
      expectNoRoomDispatch: true,
    },
    {
      name: "allows verification notices for pairing-authorized DM senders from the allow store",
      eventId: "$req-pairing-allowed",
      options: { dmPolicy: "pairing", storeAllowFrom: ["@alice:example.org"] },
      accepted: true,
      storeConsulted: true,
    },
    {
      name: "blocks verification notices when Matrix DMs are disabled",
      eventId: "$req-dm-disabled",
      options: { dmEnabled: false },
      accepted: false,
      blockedLog:
        "matrix: blocked verification sender @alice:example.org (dmPolicy=open, dmEnabled=false)",
    },
  ])(
    "$name",
    async ({ eventId, options, accepted, storeConsulted, blockedLog, expectNoRoomDispatch }) => {
      const {
        onRoomMessage,
        sendMessage,
        roomMessageListener,
        logVerboseMessage,
        readStoreAllowFrom,
        flushTasks,
      } = createHarness(options);

      roomMessageListener("!room:example.org", {
        event_id: eventId,
        type: EventType.RoomMessage,
        content: { msgtype: "m.key.verification.request", body: "verification request" },
      });

      await flushTasks();
      if (blockedLog) {
        expect(logVerboseMessage).toHaveBeenCalledWith(blockedLog);
      }
      if (storeConsulted) {
        expect(readStoreAllowFrom).toHaveBeenCalled();
      }
      if (!accepted) {
        expect(sendMessage).not.toHaveBeenCalled();
        if (expectNoRoomDispatch) {
          expect(onRoomMessage).not.toHaveBeenCalled();
        }
        return;
      }
      expect(sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("posts ready-stage guidance for emoji verification", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness();
    roomEventListener("!room:example.org", verificationEvent("$ready-1", "ready", "$req-ready-1"));

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification is ready with @alice:example.org.");
    expect(body).toContain('Choose "Verify by emoji"');
  });

  it("blocks summary SAS notices when dmPolicy allowlist would block the sender", async () => {
    const { sendMessage, verificationSummaryListener, logVerboseMessage, flushTasks } =
      createHarness({
        dmPolicy: "allowlist",
        joinedMembersByRoom: { "!dm:example.org": ["@alice:example.org", "@bot:example.org"] },
      });

    verificationSummaryListener(
      createVerificationSummary({ id: "verification-blocked-summary", roomId: "!dm:example.org" }),
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
        joinedMembersByRoom: { "!dm:example.org": ["@alice:example.org", "@bot:example.org"] },
      });

    roomEventListener("!dm:example.org", {
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
    expect(
      getSentNoticeBodies(sendMessage).some((body) =>
        body.includes("Matrix verification started with"),
      ),
    ).toBe(true);

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
        otherUserId: "@alice:example.org",
      },
    ];
    const { sendMessage, roomEventListener } = createHarness({
      joinedMembersByRoom: { "!dm:example.org": ["@alice:example.org", "@bot:example.org"] },
      verifications,
      sasNoticeRetryDelayMs: 750,
    });

    roomEventListener("!dm:example.org", verificationEvent("$start-race", "start", "$req-race"));

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
        "!group:example.org": ["@alice:example.org", "@bot:example.org", "@ops:example.org"],
      },
      verifications: [
        {
          id: "verification-2",
          transactionId: "$different-flow-id",
          otherUserId: "@alice:example.org",
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
        joinedMembersByRoom: strictRooms("!fallback:example.org", "!dm:example.org"),
        memberStateByRoomUser: { "!dm:example.org": { "@bot:example.org": { is_direct: true } } },
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
    expect((sendMessage.mock.calls as unknown[][])[0]?.[0]).toBe("!dm:example.org");
  });

  it("does not emit duplicate SAS notices for the same verification payload", async () => {
    const { sendMessage, roomEventListener, listVerifications, flushTasks } = createHarness({
      verifications: [
        {
          id: "verification-3",
          transactionId: "$req3",
          otherUserId: "@alice:example.org",
          sas: rocketSas,
        },
      ],
    });

    roomEventListener("!room:example.org", verificationEvent("$start3", "start", "$req3"));
    await flushTasks();
    expect(sendMessage.mock.calls.length).toBeGreaterThan(0);

    roomEventListener("!room:example.org", verificationEvent("$key3", "key", "$req3"));
    await flushTasks();
    expect(listVerifications).toHaveBeenCalledTimes(2);

    const sasBodies = getSentNoticeBodies(sendMessage).filter((body) =>
      body.includes("SAS emoji:"),
    );
    expect(sasBodies).toHaveLength(1);
  });

  it("preserves strict-room SAS fallback when active DM inspection cannot resolve a room", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: { "!dm:example.org": ["@alice:example.org", "@bot:example.org"] },
      getJoinedRoomsError: new Error("temporary joined-room lookup failure"),
      verifications: [
        {
          id: "verification-active",
          transactionId: "$different-flow-id",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:43:54.000Z").toISOString(),
          phaseName: "started",
          phase: 3,
          pending: true,
          sas: giftSas,
        },
      ],
    });

    roomEventListener(
      "!dm:example.org",
      verificationEvent("$start-active", "start", "$req-active"),
    );

    await flushTasks();
    expectBodiesContain(getSentNoticeBodies(sendMessage), "SAS decimal: 6158 1986 3513");
  });

  it("prefers the active verification for the current DM when multiple active summaries exist", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: strictRooms("!dm-current:example.org"),
      verifications: [
        {
          id: "verification-other-room",
          roomId: "!dm-other:example.org",
          transactionId: "$different-flow-other",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:44:54.000Z").toISOString(),
          phaseName: "started",
          phase: 3,
          pending: true,
          sas: rocketSas,
        },
        {
          id: "verification-current-room",
          roomId: "!dm-current:example.org",
          transactionId: "$different-flow-current",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:43:54.000Z").toISOString(),
          phaseName: "started",
          phase: 3,
          pending: true,
          sas: giftSas,
        },
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
      joinedMembersByRoom: { "!dm:example.org": ["@alice:example.org", "@bot:example.org"] },
      verifications: [
        {
          id: "verification-cancelled",
          transactionId: "$req-cancelled",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
          phaseName: "cancelled",
          phase: 4,
          pending: false,
          sas: rocketSas,
        },
      ],
    });

    roomEventListener("!dm:example.org", {
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

  it("warns once when encrypted events arrive without Matrix encryption enabled", () => {
    const { logger, roomEventListener } = createHarness({ authEncryption: false });

    roomEventListener("!room:example.org", {
      event_id: "$enc1",
      type: EventType.RoomMessageEncrypted,
    });
    roomEventListener("!room:example.org", {
      event_id: "$enc2",
      type: EventType.RoomMessageEncrypted,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encrypted event received without encryption enabled; set channels.matrix.encryption=true and verify the device to decrypt",
      { roomId: "!room:example.org" },
    );
  });

  it("uses the active Matrix account path in encrypted-event warnings", () => {
    const { logger, roomEventListener } = createHarness({
      accountId: "ops",
      authEncryption: false,
      cfg: { channels: { matrix: { accounts: { ops: {} } } } },
    });

    roomEventListener("!room:example.org", {
      event_id: "$enc1",
      type: EventType.RoomMessageEncrypted,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encrypted event received without encryption enabled; set channels.matrix.accounts.ops.encryption=true and verify the device to decrypt",
      { roomId: "!room:example.org" },
    );
  });

  it("warns once when crypto bindings are unavailable for encrypted rooms", () => {
    const { formatNativeDependencyHint, logger, roomEventListener } = createHarness({
      authEncryption: true,
      cryptoAvailable: false,
    });

    roomEventListener("!room:example.org", {
      event_id: "$enc1",
      type: EventType.RoomMessageEncrypted,
    });
    roomEventListener("!room:example.org", {
      event_id: "$enc2",
      type: EventType.RoomMessageEncrypted,
    });

    expect(formatNativeDependencyHint).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encryption enabled but crypto is unavailable; install hint",
      { roomId: "!room:example.org" },
    );
  });

  it("adds self-device guidance when decrypt failures come from the same Matrix user", async () => {
    const { logger, failedDecryptListener, flushTasks } = createHarness({
      accountId: "ops",
      selfUserId: "@gumadeiras:matrix.example.org",
    });

    failedDecryptListener("!room:example.org", {
      event_id: "$enc-self",
      sender: "@gumadeiras:matrix.example.org",
    });
    await flushTasks();

    expectWarnContextFields(logger, 1, "Failed to decrypt message", {
      roomId: "!room:example.org",
      eventId: "$enc-self",
      sender: "@gumadeiras:matrix.example.org",
      senderMatchesOwnUser: true,
    });
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      "matrix: failed to decrypt a message from this same Matrix user. This usually means another Matrix device did not share the room key, or another OpenClaw runtime is using the same account. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
      {
        roomId: "!room:example.org",
        eventId: "$enc-self",
        sender: "@gumadeiras:matrix.example.org",
      },
    );
  });

  it("keeps decrypt failures before healthy sync on the generic warning path", async () => {
    const { logger, failedDecryptListener, flushTasks, healthySync } = healthySyncHarness(false);

    failedDecryptListener("!room:example.org", {
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

    failedDecryptListener("!room:example.org", {
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

    expectWarnContextFields(
      logger,
      4,
      "matrix: repeated fresh encrypted messages are still failing to decrypt after Matrix resumed healthy sync. This device may still be missing new room keys. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
      { sampleEventIds: ["$enc-wave-1-1", "$enc-wave-1-2", "$enc-wave-1-3"] },
    );
    expectWarnContextFields(
      logger,
      8,
      "matrix: repeated fresh encrypted messages are still failing to decrypt after Matrix resumed healthy sync. This device may still be missing new room keys. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
      { sampleEventIds: ["$enc-wave-2-1", "$enc-wave-2-2", "$enc-wave-2-3"] },
    );
  });

  it("resets tracked failures when healthy sync restarts before the old window expires", async () => {
    const harness = healthySyncHarness();
    const { logger, healthySync } = harness;
    await failureWave(harness, "first");
    healthySync.sinceMs = Date.now();
    await failureWave(harness, "second", (index) => index);

    expectWarnContextFields(logger, 5, "Failed to decrypt fresh post-healthy-sync message", {
      eventId: "$enc-second-1",
      freshAfterHealthySync: true,
      postHealthySyncFailureCount: 1,
    });
    expectWarnContextFields(logger, 6, "Failed to decrypt fresh post-healthy-sync message", {
      eventId: "$enc-second-2",
      freshAfterHealthySync: true,
      postHealthySyncFailureCount: 2,
    });
    expectWarnContextFields(logger, 7, "Failed to decrypt fresh post-healthy-sync message", {
      eventId: "$enc-second-3",
      freshAfterHealthySync: true,
      postHealthySyncFailureCount: 3,
    });
    expectWarnContextFields(
      logger,
      8,
      "matrix: repeated fresh encrypted messages are still failing to decrypt after Matrix resumed healthy sync. This device may still be missing new room keys. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
      { sampleEventIds: ["$enc-second-1", "$enc-second-2", "$enc-second-3"] },
    );
  });

  it("logs decrypt guidance when getUserId fails during lookup", async () => {
    const { logger, logVerboseMessage, failedDecryptListener, flushTasks } = createHarness({
      accountId: "ops",
      selfUserIdError: new Error("lookup failed"),
    });

    failedDecryptListener("!room:example.org", {
      event_id: "$enc-lookup-fail",
      sender: "@gumadeiras:matrix.example.org",
    });
    await flushTasks();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expectWarnContextFields(logger, 1, "Failed to decrypt message", {
      roomId: "!room:example.org",
      eventId: "$enc-lookup-fail",
      senderMatchesOwnUser: false,
    });
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix: failed resolving self user id for decrypt warning: Error: lookup failed",
    );
  });
});
