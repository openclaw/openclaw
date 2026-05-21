import { describe, expect, it, vi } from "vitest";
import { inspectMatrixDirectRoomEvidence } from "./direct-room.js";
import type { MatrixClient } from "./sdk.js";

function createClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
    getRoomStateEvent: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as MatrixClient;
}

describe("inspectMatrixDirectRoomEvidence", () => {
  it("does not retry getUserId when callers explicitly pass a missing self user", async () => {
    const getUserId = vi.fn(async () => "@bot:example.org");
    const client = createClient({ getUserId });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!dm:example.org",
      remoteUserId: "@alice:example.org",
      selfUserId: null,
    });

    expect(getUserId).not.toHaveBeenCalled();
    expect(result.strict).toBe(false);
  });

  it("resolves selfUserId when callers leave it undefined", async () => {
    const getUserId = vi.fn(async () => "@bot:example.org");
    const client = createClient({ getUserId });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!dm:example.org",
      remoteUserId: "@alice:example.org",
    });

    expect(getUserId).toHaveBeenCalledTimes(1);
    expect(result.strict).toBe(true);
  });

  it("honors an explicit is_direct: false on the bot's own member event as a strict-DM veto", async () => {
    // Two joined members would otherwise satisfy the strict-DM heuristic, but
    // the bot's local m.room.member event carries is_direct: false — meaning
    // the room was intentionally created as a group (e.g. /createRoom with
    // is_direct: false). The classification must follow the explicit signal,
    // not the bare member count.
    const client = createClient({
      getRoomStateEvent: vi.fn(async (_roomId: string, _eventType: string, stateKey: string) =>
        stateKey === "@bot:example.org" ? { is_direct: false } : { is_direct: true },
      ),
    });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!group:example.org",
      remoteUserId: "@alice:example.org",
    });

    expect(result.strict).toBe(false);
    expect(result.memberStateFlag).toBe(false);
    expect(result.viaMemberState).toBe(false);
  });

  it("treats absent is_direct on the bot's member event as no signal (strict by member count)", async () => {
    // When the bot's member event has no is_direct field at all, fall back to
    // the legacy strict-by-member-count behavior so we don't regress rooms
    // that have always been treated as DMs.
    const client = createClient({
      getRoomStateEvent: vi.fn(async () => ({})),
    });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!dm:example.org",
      remoteUserId: "@alice:example.org",
    });

    expect(result.strict).toBe(true);
    expect(result.memberStateFlag).toBe(null);
  });
});
