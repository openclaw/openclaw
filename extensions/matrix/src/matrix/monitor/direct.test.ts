import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { describe, expect, it, vi } from "vitest";
import { createDirectRoomTracker } from "./direct.js";

function createMockClient(params: {
  isDm?: boolean;
  senderDirect?: boolean;
  selfDirect?: boolean;
  members?: string[];
}) {
  const members = params.members ?? ["@alice:example.org", "@bot:example.org"];
  return {
    dms: {
      update: vi.fn().mockResolvedValue(undefined),
      isDm: vi.fn().mockReturnValue(params.isDm === true),
    },
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    getJoinedRoomMembers: vi.fn().mockResolvedValue(members),
    getRoomStateEvent: vi
      .fn()
      .mockImplementation(async (_roomId: string, _event: string, stateKey: string) => {
        if (stateKey === "@alice:example.org") {
          return { is_direct: params.senderDirect === true };
        }
        if (stateKey === "@bot:example.org") {
          return { is_direct: params.selfDirect === true };
        }
        return {};
      }),
  } as unknown as MatrixClient;
}

describe("createDirectRoomTracker", () => {
  it("treats m.direct rooms as DMs", async () => {
    const tracker = createDirectRoomTracker(createMockClient({ isDm: true }));
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
  });

  it("does not classify 2-member rooms as DMs without direct flags", async () => {
    const client = createMockClient({ isDm: false });
    const tracker = createDirectRoomTracker(client);
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
    expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it("uses is_direct member flags when present", async () => {
    const tracker = createDirectRoomTracker(createMockClient({ senderDirect: true }));
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
  });
});
