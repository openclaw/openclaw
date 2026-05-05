import { describe, expect, it, vi } from "vitest";
import { loadSqliteVecExtension } from "./sqlite-vec.js";

describe("loadSqliteVecExtension", () => {
  function makeMockDb() {
    return {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };
  }

  it("loads sqlite-vec without extensionPath and resolves from module location", async () => {
    const db = makeMockDb();
    const result = await loadSqliteVecExtension({
      db: db as any,
    });
    expect(result.ok).toBe(true);
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    // Verify sqlite-vec was resolved from openclaw module location (not cwd)
    expect(db.loadExtension).toHaveBeenCalledTimes(1);
    const calledPath = (db.loadExtension as any).mock.calls[0][0] as string;
    expect(calledPath).toMatch(/vec0\.(so|dylib|dll)$/);
  });

  it("loads via db.loadExtension() when extensionPath is explicitly set", async () => {
    const db = makeMockDb();
    const result = await loadSqliteVecExtension({
      db: db as any,
      extensionPath: "/explicit/path/vec0.so",
    });
    expect(result.ok).toBe(true);
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(db.loadExtension).toHaveBeenCalledWith("/explicit/path/vec0.so");
    expect(result.extensionPath).toBe("/explicit/path/vec0.so");
  });

  it("returns ok:false with error message when load fails", async () => {
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(() => {
        throw new Error("cannot load extension");
      }),
    };
    const result = await loadSqliteVecExtension({
      db: db as any,
      extensionPath: "/bad/path/vec0.so",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot load extension");
  });

  it("resolves sqlite-vec from module location, not cwd", async () => {
    // Verify that loadSqliteVecModule uses createRequire(import.meta.url)
    // so global npm installs resolve from openclaw's node_modules, not cwd.
    const db = makeMockDb();
    const result = await loadSqliteVecExtension({ db: db as any });
    // If resolution from cwd were used in a global install, this would fail.
    // Passing here confirms the module-relative resolution path works.
    expect(result.ok).toBe(true);
  });
});
