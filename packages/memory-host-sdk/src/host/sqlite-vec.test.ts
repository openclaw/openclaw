import { afterEach, describe, expect, it, vi } from "vitest";

function mockMissingSqliteVecPackage(): void {
  vi.doMock("sqlite-vec", () => {
    const err = new Error("Cannot find package 'sqlite-vec' imported from sqlite-vec.test.ts");
    Object.assign(err, { code: "ERR_MODULE_NOT_FOUND" });
    throw err;
  });
}

function mockPlatformVariantResolver(
  value: { pkg: string; extensionPath: string } | undefined,
): void {
  vi.doMock("./sqlite-vec-platform-variant.js", () => ({
    resolveSqliteVecPlatformVariant: () => value,
  }));
}

async function importLoader() {
  return import("./sqlite-vec.js");
}

afterEach(() => {
  vi.doUnmock("sqlite-vec");
  vi.doUnmock("./sqlite-vec-platform-variant.js");
  vi.resetModules();
});

describe("loadSqliteVecExtension", () => {
  it("loads explicit extensionPath without importing bundled sqlite-vec", async () => {
    mockMissingSqliteVecPackage();
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };

    await expect(
      loadSqliteVecExtension({
        db: db as never,
        extensionPath: "/opt/openclaw/sqlite-vec.so",
      }),
    ).resolves.toEqual({ ok: true, extensionPath: "/opt/openclaw/sqlite-vec.so" });
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(db.loadExtension).toHaveBeenCalledWith("/opt/openclaw/sqlite-vec.so");
  });

  it("returns a valid memorySearch extensionPath hint when sqlite-vec is absent", async () => {
    mockMissingSqliteVecPackage();
    mockPlatformVariantResolver(undefined);
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("sqlite-vec package is not installed.");
    expect(result.error).toContain("agents.defaults.memorySearch.store.vector.extensionPath");
    expect(result.error).toContain("agent-specific memorySearch.store.vector.extensionPath");
    expect(result.error).not.toContain("memory.store.vector.extensionPath");
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(db.loadExtension).not.toHaveBeenCalled();
  });

  it("falls back to the platform-specific sqlite-vec variant when only that package is installed", async () => {
    mockMissingSqliteVecPackage();
    mockPlatformVariantResolver({
      pkg: "sqlite-vec-linux-x64",
      extensionPath: "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    });
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result).toEqual({
      ok: true,
      extensionPath: "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    });
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(db.loadExtension).toHaveBeenCalledWith(
      "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    );
  });

  it("preserves the extensionPath config hint when the platform variant loadExtension call throws", async () => {
    mockMissingSqliteVecPackage();
    mockPlatformVariantResolver({
      pkg: "sqlite-vec-linux-x64",
      extensionPath: "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    });
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn().mockImplementation(() => {
        throw new Error("dlopen failed: file not found");
      }),
    };

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("sqlite-vec-linux-x64");
    expect(result.error).toContain("agents.defaults.memorySearch.store.vector.extensionPath");
    expect(result.error).toContain("dlopen failed: file not found");
  });
});
