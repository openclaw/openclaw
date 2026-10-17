import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const { MemoryIndexManager } = await import("./manager.js");

describe("memory search sync warnings", () => {
  const { createConfig: createCfg, getPersistentManager } = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("keeps nested causes when background search maintenance fails", async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = await getPersistentManager(createCfg({ provider: "none", minScore: 0 }));
    await manager.sync({ reason: "test" });
    Reflect.set(manager, "dirty", true);
    const cause = Object.assign(new Error("database is not open"), { code: "ERR_INVALID_STATE" });
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    const getSpy = vi
      .spyOn(MemoryIndexManager, "get")
      .mockImplementation(async (params) =>
        params.purpose === "maintenance"
          ? Promise.reject(new Error("memory index maintenance failed", { cause }))
          : originalGet(params),
      );

    try {
      await manager.search("zebra", { maxResults: 5, minScore: 0 });
      await manager.close?.();
      const warning = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(warning).toContain("memory sync failed (search)");
      expect(warning).toContain("memory index maintenance failed");
      expect(warning).toContain("database is not open");
      expect(warning).toContain("ERR_INVALID_STATE");
    } finally {
      getSpy.mockRestore();
      warnSpy.mockRestore();
      resetLogger();
    }
  });
});
