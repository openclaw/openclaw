import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { describe, expect, it, vi } from "vitest";

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn(() => ({
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
  })),
}));

import { listFeishuDirectoryGroups, listFeishuDirectoryPeers } from "./directory.js";

describe("feishu directory (config-backed)", () => {
  const cfg = {} as ClawdbotConfig;

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
});
