import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { describe, expect, it, vi } from "vitest";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
}));

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
  const cfg = {} as ClawdbotConfig;

  function makeStaticAccount() {
    return {
      configured: false,
      config: {
        allowFrom: ["user:alice", "user:bob"],
        dms: {
          "user:carla": {},
        },
        groups: {
          "chat-1": {},
        },
        groupAllowFrom: ["chat-2"],
      },
    };
  }

  resolveFeishuAccountMock.mockImplementation(() => makeStaticAccount());

  it("merges allowFrom + dms into peer entries", async () => {
    const peers = await listFeishuDirectoryPeers({ cfg, query: "a" });
    expect(peers).toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "carla" },
    ]);
  });

  it("merges groups map + groupAllowFrom into group entries", async () => {
    const groups = await listFeishuDirectoryGroups({ cfg });
    expect(groups).toEqual([
      { kind: "group", id: "chat-1" },
      { kind: "group", id: "chat-2" },
    ]);
  });

  it("falls back to static peers on live lookup failure by default", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      ...makeStaticAccount(),
      configured: true,
    });
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
    resolveFeishuAccountMock.mockReturnValueOnce({
      ...makeStaticAccount(),
      configured: true,
    });
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
    resolveFeishuAccountMock.mockReturnValueOnce({
      ...makeStaticAccount(),
      configured: true,
    });
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
