// Buzz tests cover the lightweight config-backed directory contract.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buzzDirectoryContractPlugin } from "../directory-contract-api.js";

const ROOM_A = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const ROOM_B = "940d0c32-4eb7-46d7-9d5b-d975aaef87f7";
const ROOM_C = "a11f29e0-21bc-43d9-b1b5-2b8bb3abc4ef";
const ROOM_D = "cb710159-4fe8-4d82-a664-cd02e2994c91";

describe("Buzz directory contract", () => {
  it("lists enabled configured rooms with query and limit filtering", async () => {
    const cfg = {
      channels: {
        buzz: {
          groups: {
            [ROOM_D]: {},
            [ROOM_B]: { enabled: false },
            [ROOM_C]: {},
            [ROOM_A]: {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const all = [ROOM_A, ROOM_C, ROOM_D];
    for (const [query, limit, rooms] of [
      [ROOM_A.slice(0, 8).toUpperCase(), 1, [ROOM_A]],
      ["  BUZZ:  ", 2, [ROOM_A, ROOM_C]],
      ["  ", 1, [ROOM_A]],
      [null, null, all],
      ["missing", 1, []],
    ] as const) {
      await expect(
        buzzDirectoryContractPlugin.directory.listGroups({
          cfg,
          accountId: "default",
          query,
          limit,
        }),
      ).resolves.toEqual(
        rooms.map((roomId) => ({
          kind: "group",
          id: `buzz:${roomId}`,
          name: roomId,
          raw: { roomId },
        })),
      );
    }
    await expect(
      buzzDirectoryContractPlugin.directory.listPeers({
        cfg,
        accountId: "default",
        query: null,
        limit: null,
      }),
    ).resolves.toEqual([]);
  });
});
