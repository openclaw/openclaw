import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const builtinManager = vi.hoisted(() => ({}));
const memoryIndexGet = vi.hoisted(() => vi.fn(async () => builtinManager));
const closeMemoryIndexManagersForAgent = vi.hoisted(() => vi.fn(async () => {}));

// mock-isolation: keep index/database workers isolated while testing acquisition errors and cleanup routing.
vi.mock("../../manager-runtime.js", () => ({
  MemoryIndexManager: { get: memoryIndexGet },
  closeMemoryIndexManagersForAgent,
}));

import { closeMemorySearchManager, getMemorySearchManager } from "./search-manager.js";

describe("builtin memory search manager", () => {
  beforeEach(() => {
    memoryIndexGet.mockClear();
    memoryIndexGet.mockResolvedValue(builtinManager);
    closeMemoryIndexManagersForAgent.mockClear();
  });

  it("preserves the builtin initialization error code", async () => {
    memoryIndexGet.mockRejectedValueOnce(
      Object.assign(new Error("index unavailable"), {
        code: "SQLITE_READONLY_WORKER_SCOPE_CLOSED",
      }),
    );

    await expect(
      getMemorySearchManager({ cfg: {} as OpenClawConfig, agentId: "main" }),
    ).resolves.toMatchObject({
      manager: null,
      error: "index unavailable",
      code: "SQLITE_READONLY_WORKER_SCOPE_CLOSED",
    });
  });

  it("normalizes the agent id before scoped cleanup", async () => {
    const cfg = {} as OpenClawConfig;
    await getMemorySearchManager({ cfg, agentId: " Main " });

    await closeMemorySearchManager({ cfg, agentId: " Main " });

    expect(closeMemoryIndexManagersForAgent).toHaveBeenCalledWith({ agentId: "main" });
  });
});
