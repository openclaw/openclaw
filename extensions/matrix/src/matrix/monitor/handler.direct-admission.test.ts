import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../send.js")>();
  return {
    ...actual,
    sendMessageMatrix: vi.fn(async () => ({
      messageId: "$pairing",
      roomId: "!room:example.org",
    })),
  };
});
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixClient } from "../sdk.js";
import { createDirectRoomTracker } from "./direct.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

const ROOM = "!room:example.org";

function client(params: { isDm?: boolean; direct?: boolean }) {
  const state: Record<string, unknown> = {};
  if (params.direct !== undefined) {
    state[`${ROOM}|m.room.member|@bot:example.org`] = { is_direct: params.direct };
  }
  const dmRoomIds = new Set<string>();
  if (params.isDm) {
    dmRoomIds.add(ROOM);
  }
  return {
    dms: {
      update: vi.fn(async () => false),
      isDm: (roomId: string) => dmRoomIds.has(roomId),
    },
    getUserId: async () => "@bot:example.org",
    getJoinedRoomMembers: async () => ["@alice:example.org", "@bot:example.org"],
    getRoomStateEvent: async (roomId: string, eventType: string, stateKey = "") => {
      const value = state[`${roomId}|${eventType}|${stateKey}`];
      if (value === undefined) {
        throw new Error("missing");
      }
      return value;
    },
    setAccountData: vi.fn(async () => {}),
  };
}

async function admit(tracker: ReturnType<typeof createDirectRoomTracker>) {
  const upsertPairingRequest = vi.fn(async () => ({ code: "PAIRCODE", created: true }));
  let dispatchCount = 0;
  const logs: string[] = [];
  const harness = createHarness({
    directTracker: tracker,
    dmPolicy: "pairing",
    allowFrom: [],
    groupPolicy: "allowlist",
    roomsConfig: {},
    upsertPairingRequest,
    dispatchInboundMessage: async () => {
      dispatchCount += 1;
      return {
        queuedFinal: false,
        counts: { final: 0, block: 0, tool: 0 },
      };
    },
    logVerboseMessage: (message) => {
      logs.push(message);
    },
  });
  await harness.handler(
    ROOM,
    createMatrixTextMessageEvent({
      eventId: "$m",
      body: "hello",
      sender: "@alice:example.org",
    }),
  );
  return {
    pairingWrites: upsertPairingRequest.mock.calls.length,
    dispatch: dispatchCount,
    logs,
  };
}

describe("matrix monitor admission from the direct-room tracker", () => {
  beforeEach(() => {
    installMatrixMonitorTestRuntime();
  });

  it("drops an unnamed two-member room before pairing", async () => {
    const tracker = createDirectRoomTracker(client({}) as unknown as MatrixClient);
    const result = await admit(tracker);
    expect(result.pairingWrites).toBe(0);
    expect(result.dispatch).toBe(0);
    expect(result.logs.some((line) => line.includes("drop room message"))).toBe(true);
  });

  it("still pairs a room already stored in m.direct", async () => {
    const tracker = createDirectRoomTracker(client({ isDm: true }) as unknown as MatrixClient);
    const result = await admit(tracker);
    expect(result.pairingWrites).toBe(1);
    expect(result.dispatch).toBe(0);
  });

  it("still pairs a room whose member event says is_direct", async () => {
    const tracker = createDirectRoomTracker(client({ direct: true }) as unknown as MatrixClient);
    const result = await admit(tracker);
    expect(result.pairingWrites).toBe(1);
  });
});
