import { EventEmitter } from "node:events";
import { ClientEvent, createClient, MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { Room, RoomEvent } from "matrix-js-sdk/lib/models/room.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import type { MatrixClient } from "../sdk.js";
import {
  emitMatrixMembershipForRoom,
  registerMatrixClientBridge,
} from "../sdk/client-event-bridge.js";
import type { MatrixDecryptBridge } from "../sdk/decrypt-bridge.js";
import type { MatrixRawEvent } from "../sdk/types.js";
import { createDirectRoomTracker } from "./direct.js";
import { registerMatrixMonitorEvents } from "./events.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", () => ({
  reportChannelRoomJoin: vi.fn(async () => ({ kind: "posted" })),
}));

const selfUserId = "@bot:example.org";
const remoteUserId = "@avery:example.org";
const roomId = "!planning:example.org";
const reportJoin = vi.mocked(reportChannelRoomJoin);

function createHarness(
  options: {
    direct?: boolean;
    membersUnavailable?: boolean;
    historyUnavailable?: boolean;
    groupPolicy?: "open" | "allowlist" | "disabled";
    roomEnabled?: boolean;
    roomAliasEnabled?: boolean;
    aliasesUnavailable?: boolean;
  } = {},
) {
  reportJoin.mockClear();
  const emitter = new EventEmitter();
  const sdk = createClient({ baseUrl: "https://matrix.example.org", userId: selfUserId });
  const room = new Room(roomId, sdk, selfUserId);
  sdk.reEmitter.reEmit(room, [RoomEvent.MyMembership]);
  const tasks: Promise<void>[] = [];
  const messages: MatrixRawEvent[] = ["newest", "older"].map((body, index) => ({
    event_id: `$message-${index}`,
    sender: remoteUserId,
    type: "m.room.message",
    origin_server_ts: 20 - index,
    content: { msgtype: "m.text", body },
  }));
  const doRequest = vi.fn(async () => {
    if (options.historyUnavailable) {
      throw new Error("history denied");
    }
    return { chunk: messages };
  });
  const pluginClient = Object.assign(emitter, {
    getUserId: async () => selfUserId,
    getJoinedRoomMembers: async () => {
      if (options.membersUnavailable) {
        throw new Error("membership unavailable");
      }
      return options.direct
        ? [selfUserId, remoteUserId]
        : [selfUserId, remoteUserId, "@casey:example.org"];
    },
    getRoomStateEvent: async (_roomId: string, type: string) => {
      if (type === "m.room.canonical_alias" && options.aliasesUnavailable) {
        throw new Error("aliases unavailable");
      }
      const state = {
        "m.room.name": { name: "Planning" },
        "m.room.topic": { topic: "Release planning" },
        "m.room.member": { is_direct: options.direct === true },
        "m.room.canonical_alias": { alias: "#planning:example.org" },
      };
      return state[type as keyof typeof state] ?? {};
    },
    dms: { update: async () => true, isDm: () => options.direct === true },
    hydrateEvents: async (_roomId: string, events: MatrixRawEvent[]) => events,
    doRequest,
  }) as unknown as MatrixClient;
  const cfg: CoreConfig = {
    agents: { entries: { planner: {} } },
    bindings: [{ agentId: "planner", match: { channel: "matrix", accountId: "work" } }],
    channels: { matrix: { accounts: { work: {} } } },
  };
  const params: Parameters<typeof registerMatrixMonitorEvents>[0] = {
    cfg,
    client: pluginClient,
    auth: { accountId: "work", userId: selfUserId } as MatrixAuth,
    allowFrom: [],
    dmEnabled: true,
    dmPolicy: "pairing" as const,
    readStoreAllowFrom: vi.fn(async () => []),
    directTracker: createDirectRoomTracker(pluginClient),
    groupPolicy: options.groupPolicy ?? "open",
    roomsConfig:
      options.roomAliasEnabled !== undefined
        ? { "#planning:example.org": { enabled: options.roomAliasEnabled } }
        : options.roomEnabled === undefined
          ? undefined
          : { [roomId]: { enabled: options.roomEnabled } },
    needsRoomAliasesForConfig: options.roomAliasEnabled !== undefined,
    getRoomInfo: createMatrixRoomInfoResolver(pluginClient).getRoomInfo,
    logVerboseMessage: vi.fn(),
    warnedEncryptedRooms: new Set<string>(),
    warnedCryptoMissingRooms: new Set<string>(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    formatNativeDependencyHint: vi.fn(() => ""),
    runDetachedTask: (_label: string, task: () => Promise<void>) => {
      const pending = task();
      tasks.push(pending);
      return pending;
    },
  };
  registerMatrixMonitorEvents(params);
  const bridgeParams = { client: sdk, emitter, room, selfUserId };
  registerMatrixClientBridge({
    client: sdk,
    emitter,
    decryptBridge: {
      shouldEmitUnencryptedMessage: () => false,
    } as unknown as MatrixDecryptBridge<MatrixRawEvent>,
    emitMembershipForRoom: (currentRoom) =>
      emitMatrixMembershipForRoom({ ...bridgeParams, room: currentRoom }),
    getSelfUserId: () => selfUserId,
    setCurrentSyncState: vi.fn(),
  });
  let sequence = 0;
  const membership = (value: string, emitRaw = true) => {
    const event = new MatrixEvent({
      event_id: `$membership-${sequence++}`,
      room_id: roomId,
      type: "m.room.member",
      sender: selfUserId,
      state_key: selfUserId,
      origin_server_ts: Date.now(),
      content: { membership: value },
    });
    room.currentState.setStateEvents([event]);
    room.recalculate();
    if (emitRaw) {
      sdk.emit(ClientEvent.Event, event);
    }
    return event;
  };
  return {
    joinRoom: async () => {
      sdk.emit(ClientEvent.Sync, SyncState.Prepared, null);
      membership("join");
      await Promise.all(tasks);
    },
    ...params,
    emitter,
    sdk,
    room,
    membership,
    doRequest,
    ready: () => sdk.emit(ClientEvent.Sync, SyncState.Prepared, null),
    snapshot: () => emitMatrixMembershipForRoom(bridgeParams),
    flush: () => Promise.all(tasks),
  };
}

function joinParams() {
  expect(reportJoin).toHaveBeenCalledTimes(1);
  const params = reportJoin.mock.calls[0]?.[0];
  if (!params) {
    throw new Error("Expected a Matrix join introduction");
  }
  return params;
}

describe("Matrix join introductions through the SDK bridge", () => {
  it("never introduces into an already-joined room during startup recovery", async () => {
    const h = createHarness();
    h.sdk.emit(ClientEvent.Sync, SyncState.Error, null);
    h.sdk.emit(ClientEvent.Sync, SyncState.Catchup, SyncState.Error);
    const joins = vi.fn<(roomId: string, event: MatrixRawEvent) => void>();
    h.emitter.on("room.join", joins);
    h.membership("join");
    h.sdk.emit(ClientEvent.Room, h.room);
    h.ready();
    h.snapshot();
    await h.flush();
    expect(joins).toHaveBeenCalledTimes(3);
    expect(joins.mock.calls.map((call) => call[1].membershipProvenance)).toEqual([
      "snapshot",
      "snapshot",
      "snapshot",
    ]);
    expect(reportJoin).not.toHaveBeenCalled();
    expect(h.doRequest).not.toHaveBeenCalled();
  });

  it.each([
    { previous: undefined, historyUnavailable: false },
    { previous: "invite", historyUnavailable: false },
    { previous: undefined, historyUnavailable: true },
  ])(
    "introduces the bot on a $previous-to-join transition (history unavailable: $historyUnavailable) with the account route and oldest-first history",
    async ({ previous, historyUnavailable }) => {
      const h = createHarness({ historyUnavailable });
      if (previous) {
        h.membership(previous);
      }
      await h.joinRoom();
      const params = joinParams();
      expect(params).toMatchObject({
        channel: "matrix",
        accountId: "work",
        conversationId: roomId,
        deliverTo: `room:${roomId}`,
        roomAllowed: true,
        route: { agentId: "planner", sessionKey: `agent:planner:matrix:channel:${roomId}` },
      });
      expect(await params.resolveRoomContext({ messageLimit: 100 })).toEqual({
        title: "Planning",
        purpose: "Release planning",
        ...(historyUnavailable
          ? {}
          : {
              recentMessages: [
                { sender: remoteUserId, text: "older" },
                { sender: remoteUserId, text: "newest" },
              ],
            }),
      });
      expect(h.readStoreAllowFrom).not.toHaveBeenCalled();
    },
  );

  it("waits for a real transition after a new-room lifecycle snapshot and ignores duplicate raw delivery", async () => {
    const h = createHarness();
    h.ready();
    const event = h.membership("join", false);
    h.sdk.emit(ClientEvent.Room, h.room);
    await h.flush();
    expect(reportJoin).not.toHaveBeenCalled();
    h.sdk.emit(ClientEvent.Event, event);
    h.sdk.emit(ClientEvent.Event, event);
    await h.flush();
    expect(reportJoin).toHaveBeenCalledTimes(1);
  });

  it.each([{ direct: true }, { membersUnavailable: true }])(
    "never introduces when direct-room exclusion cannot admit a group: %j",
    async (options) => {
      const h = createHarness(options);
      await h.joinRoom();
      expect(reportJoin).not.toHaveBeenCalled();
      expect(h.doRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    { groupPolicy: "disabled", roomAllowed: false },
    { groupPolicy: "allowlist", roomAllowed: false },
    { roomEnabled: false, roomAllowed: false },
    { roomAliasEnabled: false, roomAllowed: false },
    { roomAliasEnabled: false, aliasesUnavailable: true, roomAllowed: false },
    { groupPolicy: "allowlist", roomAliasEnabled: true, roomAllowed: true },
  ] as const)(
    "reports room admission without reading history: %j",
    async ({ roomAllowed, ...options }) => {
      const h = createHarness(options);
      await h.joinRoom();
      expect(reportJoin).toHaveBeenCalledWith(expect.objectContaining({ roomAllowed }));
      expect(h.doRequest).not.toHaveBeenCalled();
    },
  );
});
