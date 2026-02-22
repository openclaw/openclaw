import type { PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { dejoyPlugin } from "./channel.js";
import { setDeJoyRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const mockRuntime: RuntimeEnv = {} as RuntimeEnv;

describe("dejoy directory", () => {
  beforeEach(() => {
    setDeJoyRuntime({
      state: {
        resolveStateDir: (_env, homeDir) => homeDir?.() ?? "",
      },
    } as PluginRuntime);
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        dejoy: {
          dm: { allowFrom: ["dejoy:@alice:example.org", "bob"] },
          groupAllowFrom: ["@dana:example.org"],
          groups: {
            "!room1:example.org": { users: ["@carol:example.org"] },
            "#alias:example.org": { users: [] },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(dejoyPlugin.directory).toBeTruthy();
    expect(dejoyPlugin.directory?.listPeers).toBeTruthy();
    expect(dejoyPlugin.directory?.listGroups).toBeTruthy();

    await expect(
      dejoyPlugin.directory!.listPeers!({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: mockRuntime,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "user:@alice:example.org" },
        { kind: "user", id: "bob", name: "incomplete id; expected @user:server" },
        { kind: "user", id: "user:@carol:example.org" },
        { kind: "user", id: "user:@dana:example.org" },
      ]),
    );

    await expect(
      dejoyPlugin.directory!.listGroups!({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: mockRuntime,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "room:!room1:example.org" },
        { kind: "group", id: "#alias:example.org" },
      ]),
    );
  });
});
