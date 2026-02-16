import type { PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";
import { matrixPlugin } from "./channel.js";
import { setMatrixRuntime } from "./runtime.js";

vi.mock("@vector-im/matrix-bot-sdk", () => ({
  ConsoleLogger: class {
    trace = vi.fn();
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
  MatrixClient: class {},
  LogService: {
    setLogger: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  SimpleFsStorageProvider: class {},
  RustSdkCryptoStorageProvider: class {},
}));

describe("matrix directory", () => {
  beforeEach(() => {
    setMatrixRuntime({
      state: {
        resolveStateDir: (_env, homeDir) => homeDir(),
      },
    } as PluginRuntime);
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: ["matrix:@alice:example.org", "bob"] },
          groupAllowFrom: ["@dana:example.org"],
          groups: {
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
      matrixPlugin.directory!.listPeers({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
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
      matrixPlugin.directory!.listGroups({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "room:!room1:example.org" },
        { kind: "group", id: "#alias:example.org" },
      ]),
    );
  });

  it("resolves replyToMode from account config", () => {
    const cfg = {
      channels: {
        matrix: {
          replyToMode: "off",
          accounts: {
            Assistant: {
              replyToMode: "all",
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.threading?.resolveReplyToMode).toBeTruthy();
    expect(
      matrixPlugin.threading?.resolveReplyToMode?.({
        cfg,
        accountId: "assistant",
        chatType: "direct",
      }),
    ).toBe("all");
    expect(
      matrixPlugin.threading?.resolveReplyToMode?.({
        cfg,
        accountId: "default",
        chatType: "direct",
      }),
    ).toBe("off");
  });

  it("resolves group mention policy from account config", () => {
    const cfg = {
      channels: {
        matrix: {
          groups: {
            "!room:example.org": { requireMention: true },
          },
          accounts: {
            Assistant: {
              groups: {
                "!room:example.org": { requireMention: false },
              },
            },
          },
        },
      },
    } as unknown as CoreConfig;

    expect(matrixPlugin.groups.resolveRequireMention({ cfg, groupId: "!room:example.org" })).toBe(
      true,
    );
    expect(
      matrixPlugin.groups.resolveRequireMention({
        cfg,
        accountId: "assistant",
        groupId: "!room:example.org",
      }),
    ).toBe(false);
  });
});
