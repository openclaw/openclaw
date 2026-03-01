import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { describe, expect, it, vi } from "vitest";
import { createDirectRoomTracker } from "./direct.js";

describe("createDirectRoomTracker", () => {
  it("uses m.direct cache before member state checks", async () => {
    const roomId = "!room:example.org";
    const senderId = "@sender:example.org";
    const client = {
      dms: {
        isDm: vi.fn().mockReturnValue(true),
        update: vi.fn().mockResolvedValue(undefined),
      },
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      getRoomStateEvent: vi.fn(),
    } as unknown as MatrixClient;
    const tracker = createDirectRoomTracker(client);

    const result = await tracker.isDirectMessage({ roomId, senderId });

    expect(result).toBe(true);
    expect(client.getRoomStateEvent).not.toHaveBeenCalled();
  });

  it("treats m.room.member is_direct=true as direct", async () => {
    const roomId = "!room:example.org";
    const senderId = "@sender:example.org";
    const client = {
      dms: {
        isDm: vi.fn().mockReturnValue(false),
        update: vi.fn().mockResolvedValue(undefined),
      },
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      getRoomStateEvent: vi.fn().mockResolvedValue({ is_direct: true }),
    } as unknown as MatrixClient;
    const tracker = createDirectRoomTracker(client);

    const result = await tracker.isDirectMessage({ roomId, senderId });

    expect(result).toBe(true);
    expect(client.getRoomStateEvent).toHaveBeenCalledWith(roomId, "m.room.member", senderId);
  });

  it("does not treat member count alone as direct", async () => {
    const roomId = "!room:example.org";
    const senderId = "@sender:example.org";
    const client = {
      dms: {
        isDm: vi.fn().mockReturnValue(false),
        update: vi.fn().mockResolvedValue(undefined),
      },
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      getRoomStateEvent: vi.fn().mockResolvedValue({}),
    } as unknown as MatrixClient;
    const tracker = createDirectRoomTracker(client);

    const result = await tracker.isDirectMessage({ roomId, senderId });

    expect(result).toBe(false);
    expect(client.getRoomStateEvent).toHaveBeenCalledTimes(2);
  });
});
