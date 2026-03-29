import { describe, expect, it, vi } from "vitest";
import { inspectMatrixDirectRoomEvidence, isStrictDirectMembership } from "./direct-room.js";
import type { MatrixClient } from "./sdk.js";

function createClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", "@alice:example.org"]),
    getRoomStateEvent: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as MatrixClient;
}

describe("isStrictDirectMembership", () => {
  const selfUserId = "@bot:example.org";
  const remoteUserId = "@alice:example.org";
  const twoMembers = [selfUserId, remoteUserId];
  const threeMembers = [selfUserId, remoteUserId, "@charlie:example.org"];

  describe("is_direct flag priority", () => {
    it("returns true when is_direct=true and both users are members", () => {
      const result = isStrictDirectMembership({
        selfUserId,
        remoteUserId,
        joinedMembers: twoMembers,
        isDirectFlag: true,
      });
      expect(result).toBe(true);
    });

    it("returns true when is_direct=true regardless of member count", () => {
      const result = isStrictDirectMembership({
        selfUserId,
        remoteUserId,
        joinedMembers: threeMembers,
        isDirectFlag: true,
      });
      expect(result).toBe(true);
    });

    it("returns false when is_direct=false even with 2 members", () => {
      const result = isStrictDirectMembership({
        selfUserId,
        remoteUserId,
        joinedMembers: twoMembers,
        isDirectFlag: false,
      });
      expect(result).toBe(false);
    });

    it("returns false when is_direct=false with 3 members", () => {
      const result = isStrictDirectMembership({
        selfUserId,
        remoteUserId,
        joinedMembers: threeMembers,
        isDirectFlag: false,
      });
      expect(result).toBe(false);
    });
  });

  describe("fallback to 2-member check", () => {
    it("returns true for 2-member room when is_direct is null", () => {
      const result = isStrictDirectMembership({
        selfUserId,
        remoteUserId,
        joinedMembers: twoMembers,
        isDirectFlag: null,
      });
      expect(result).toBe(true);
    });

    it("returns false for 3-member room when is_direct is null", () => {
      const result = isStrictDirectMembership({
        selfUserId,
        remoteUserId,
        joinedMembers: threeMembers,
        isDirectFlag: null,
      });
      expect(result).toBe(false);
    });

    it("returns false when self user not in members list", () => {
      const result = isStrictDirectMembership({
        selfUserId: "@other:example.org",
        remoteUserId,
        joinedMembers: twoMembers,
        isDirectFlag: null,
      });
      expect(result).toBe(false);
    });

    it("returns false when remote user not in members list", () => {
      const result = isStrictDirectMembership({
        selfUserId,
        remoteUserId: "@other:example.org",
        joinedMembers: twoMembers,
        isDirectFlag: null,
      });
      expect(result).toBe(false);
    });

    it("returns false when is_direct is undefined (backward compat)", () => {
      const result = isStrictDirectMembership({
        selfUserId,
        remoteUserId,
        joinedMembers: twoMembers,
      });
      expect(result).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns false when selfUserId is null", () => {
      const result = isStrictDirectMembership({
        selfUserId: null,
        remoteUserId,
        joinedMembers: twoMembers,
        isDirectFlag: true,
      });
      expect(result).toBe(false);
    });

    it("returns false when remoteUserId is null", () => {
      const result = isStrictDirectMembership({
        selfUserId,
        remoteUserId: null,
        joinedMembers: twoMembers,
        isDirectFlag: true,
      });
      expect(result).toBe(false);
    });

    it("returns false when joinedMembers is empty", () => {
      const result = isStrictDirectMembership({
        selfUserId,
        remoteUserId,
        joinedMembers: [],
        isDirectFlag: true,
      });
      expect(result).toBe(false);
    });

    it("handles empty string user IDs", () => {
      const result = isStrictDirectMembership({
        selfUserId: "",
        remoteUserId,
        joinedMembers: twoMembers,
        isDirectFlag: true,
      });
      expect(result).toBe(false);
    });
  });
});

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

  it("detects DM via is_direct flag (2-member room)", async () => {
    const client = createClient({
      getRoomStateEvent: vi.fn(async () => ({ is_direct: true })),
    });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!dm:example.org",
      remoteUserId: "@alice:example.org",
    });

    expect(result.strict).toBe(true);
    expect(result.viaMemberState).toBe(true);
  });

  it("rejects 2-member group room (is_direct=false)", async () => {
    const client = createClient({
      getRoomStateEvent: vi.fn(async (_roomId, _type, userId) => {
        // Return is_direct=false for both users
        return { is_direct: false };
      }),
    });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!group:example.org",
      remoteUserId: "@alice:example.org",
    });

    expect(result.strict).toBe(false);
    expect(result.viaMemberState).toBe(false);
  });

  it("accepts 3-member DM when is_direct=true", async () => {
    const client = createClient({
      getJoinedRoomMembers: vi.fn(async () => [
        "@bot:example.org",
        "@alice:example.org",
        "@charlie:example.org",
      ]),
      getRoomStateEvent: vi.fn(async () => ({ is_direct: true })),
    });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!dm:example.org",
      remoteUserId: "@alice:example.org",
    });

    expect(result.strict).toBe(true);
    expect(result.viaMemberState).toBe(true);
  });

  it("falls back to 2-member check when is_direct is unavailable", async () => {
    const client = createClient({
      getRoomStateEvent: vi.fn(async () => {
        throw new Error("State event not found");
      }),
    });

    const result = await inspectMatrixDirectRoomEvidence({
      client,
      roomId: "!dm:example.org",
      remoteUserId: "@alice:example.org",
    });

    expect(result.strict).toBe(true);
    expect(result.viaMemberState).toBe(false);
  });
});
