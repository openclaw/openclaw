import { describe, expect, it } from "vitest";

import type { CoreConfig } from "./types.js";

import { matrixPlugin } from "./channel.js";

describe("matrix directory", () => {
  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: ["matrix:@alice:example.org", "bob"] },
          rooms: {
            "!room1:example.org": { users: ["@carol:example.org"] },
            "#alias:example.org": { users: [] },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.directory).toBeTruthy();
    expect(matrixPlugin.directory?.listPeers).toBeTruthy();
    expect(matrixPlugin.directory?.listGroups).toBeTruthy();

    await expect(
      matrixPlugin.directory!.listPeers({ cfg, accountId: undefined, query: undefined, limit: undefined }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "user:@alice:example.org" },
        { kind: "user", id: "bob", name: "incomplete id; expected @user:server" },
        { kind: "user", id: "user:@carol:example.org" },
      ]),
    );

    await expect(
      matrixPlugin.directory!.listGroups({ cfg, accountId: undefined, query: undefined, limit: undefined }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "room:!room1:example.org" },
        { kind: "group", id: "#alias:example.org" },
      ]),
    );
  });
});
