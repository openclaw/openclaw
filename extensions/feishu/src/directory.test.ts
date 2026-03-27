import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

import {
  listFeishuDirectoryGroups,
  listFeishuDirectoryGroupsLive,
  listFeishuDirectoryPeers,
  listFeishuDirectoryPeersLive,
} from "./directory.js";

describe("feishu directory (config-backed)", () => {
  function createStaticConfig(): ClawdbotConfig {
    return {
      channels: {
        feishu: {
          enabled: true,
          allowFrom: ["user:alice", "user:bob"],
          dms: {
            "user:carla": {},
          },
          groups: {
            "chat-1": {},
          },
          groupAllowFrom: ["chat-2"],
        },
      },
    } as ClawdbotConfig;
  }

  function createLiveConfig(): ClawdbotConfig {
    return {
      channels: {
        feishu: {
          enabled: true,
          appId: "app-id",
          appSecret: "app-secret",
          allowFrom: ["user:alice", "user:bob"],
          dms: {
            "user:carla": {},
          },
          groups: {
            "chat-1": {},
          },
          groupAllowFrom: ["chat-2"],
        },
      },
    } as ClawdbotConfig;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges allowFrom + dms into peer entries", async () => {
    const cfg = createStaticConfig();
    const peers = await listFeishuDirectoryPeers({ cfg, query: "a" });
    expect(peers).toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "carla" },
    ]);
  });

  it("normalizes spaced provider-prefixed peer entries", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          allowFrom: [" feishu:user:ou_alice "],
          dms: {
            " lark:dm:ou_carla ": {},
          },
          groups: {},
          groupAllowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const peers = await listFeishuDirectoryPeers({ cfg });
    expect(peers).toEqual([
      { kind: "user", id: "ou_alice" },
      { kind: "user", id: "ou_carla" },
    ]);
  });

  it("merges groups map + groupAllowFrom into group entries", async () => {
    const cfg = createStaticConfig();
    const groups = await listFeishuDirectoryGroups({ cfg });
    expect(groups).toEqual([
      { kind: "group", id: "chat-1" },
      { kind: "group", id: "chat-2" },
    ]);
  });

  it("falls back to static peers on live lookup failure by default", async () => {
    const cfg = createLiveConfig();
    createFeishuClientMock.mockReturnValueOnce({
      contact: {
        user: {
          list: vi.fn(async () => {
            throw new Error("token expired");
          }),
        },
      },
    });

    const peers = await listFeishuDirectoryPeersLive({ cfg, query: "a" });
    expect(peers).toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "carla" },
    ]);
  });

  it("surfaces live peer lookup failures when fallback is disabled", async () => {
    const cfg = createLiveConfig();
    createFeishuClientMock.mockReturnValueOnce({
      contact: {
        user: {
          list: vi.fn(async () => {
            throw new Error("token expired");
          }),
        },
      },
    });

    await expect(listFeishuDirectoryPeersLive({ cfg, fallbackToStatic: false })).rejects.toThrow(
      "token expired",
    );
  });

  it("surfaces live group lookup failures when fallback is disabled", async () => {
    const cfg = createLiveConfig();
    createFeishuClientMock.mockReturnValueOnce({
      im: {
        chat: {
          list: vi.fn(async () => ({ code: 999, msg: "forbidden" })),
        },
      },
    });

    await expect(listFeishuDirectoryGroupsLive({ cfg, fallbackToStatic: false })).rejects.toThrow(
      "forbidden",
    );
  });
});
