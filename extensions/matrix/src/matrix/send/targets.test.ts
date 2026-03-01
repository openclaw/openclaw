import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventType } from "./types.js";

let resolveMatrixRoomId: typeof import("./targets.js").resolveMatrixRoomId;
let normalizeThreadId: typeof import("./targets.js").normalizeThreadId;

beforeEach(async () => {
  vi.resetModules();
  ({ resolveMatrixRoomId, normalizeThreadId } = await import("./targets.js"));
});

describe("resolveMatrixRoomId", () => {
  it("uses m.direct when available", async () => {
    const userId = "@user:example.org";
    const client = {
      getAccountData: vi.fn().mockResolvedValue({
        [userId]: ["!room:example.org"],
      }),
      getJoinedRooms: vi.fn(),
      getJoinedRoomMembers: vi.fn(),
      setAccountData: vi.fn(),
    } as unknown as MatrixClient;

    const roomId = await resolveMatrixRoomId(client, userId);

    expect(roomId).toBe("!room:example.org");
    // oxlint-disable-next-line typescript/unbound-method
    expect(client.getJoinedRooms).not.toHaveBeenCalled();
    // oxlint-disable-next-line typescript/unbound-method
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("falls back to joined rooms and persists m.direct", async () => {
    const userId = "@fallback:example.org";
    const roomId = "!room:example.org";
    const setAccountData = vi.fn().mockResolvedValue(undefined);
    const client = {
      getAccountData: vi.fn().mockRejectedValue(new Error("nope")),
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      getJoinedRooms: vi.fn().mockResolvedValue([roomId]),
      getJoinedRoomMembers: vi.fn().mockResolvedValue(["@bot:example.org", userId]),
      getRoomStateEvent: vi.fn().mockResolvedValue({ is_direct: true }),
      setAccountData,
    } as unknown as MatrixClient;

    const resolved = await resolveMatrixRoomId(client, userId);

    expect(resolved).toBe(roomId);
    expect(setAccountData).toHaveBeenCalledWith(
      EventType.Direct,
      expect.objectContaining({ [userId]: [roomId] }),
    );
  });

  it("continues when a room member lookup fails", async () => {
    const userId = "@continue:example.org";
    const roomId = "!good:example.org";
    const setAccountData = vi.fn().mockResolvedValue(undefined);
    const getJoinedRoomMembers = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(["@bot:example.org", userId]);
    const client = {
      getAccountData: vi.fn().mockRejectedValue(new Error("nope")),
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      getJoinedRooms: vi.fn().mockResolvedValue(["!bad:example.org", roomId]),
      getJoinedRoomMembers,
      getRoomStateEvent: vi.fn().mockResolvedValue({ is_direct: true }),
      setAccountData,
    } as unknown as MatrixClient;

    const resolved = await resolveMatrixRoomId(client, userId);

    expect(resolved).toBe(roomId);
    expect(setAccountData).toHaveBeenCalled();
  });

  it("does not infer direct room from member count only", async () => {
    const userId = "@group:example.org";
    const roomId = "!group:example.org";
    const client = {
      getAccountData: vi.fn().mockRejectedValue(new Error("nope")),
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      getJoinedRooms: vi.fn().mockResolvedValue([roomId]),
      getJoinedRoomMembers: vi
        .fn()
        .mockResolvedValue(["@bot:example.org", userId, "@extra:example.org"]),
      getRoomStateEvent: vi.fn().mockResolvedValue({}),
      setAccountData: vi.fn().mockResolvedValue(undefined),
    } as unknown as MatrixClient;

    await expect(resolveMatrixRoomId(client, userId)).rejects.toThrow(
      "m.direct missing or is_direct not set",
    );
  });
});

describe("normalizeThreadId", () => {
  it("returns null for empty thread ids", () => {
    expect(normalizeThreadId("   ")).toBeNull();
    expect(normalizeThreadId("$thread")).toBe("$thread");
  });
});
