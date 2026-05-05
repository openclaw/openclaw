import { afterEach, describe, expect, it, vi } from "vitest";

function mockMissingSqliteVecPackage(): void {
  vi.doMock("sqlite-vec", () => {
    const err = new Error("Cannot find package 'sqlite-vec' imported from sqlite-vec.test.ts");
    Object.assign(err, { code: "ERR_MODULE_NOT_FOUND" });
    throw err;
  });
}

async function importLoader() {
  return import("./sqlite-vec.js");
}

afterEach(() => {
  vi.doUnmock("sqlite-vec");
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

  it("retries without .dll suffix on Windows when bundled load fails", async () => {
    const loadablePath = "C:\\sqlite-vec\\vec0.dll";
    vi.doMock("sqlite-vec", () => ({
      getLoadablePath: () => loadablePath,
      load: vi.fn().mockImplementation(() => {
        throw new Error("no such module: vec0");
      }),
    }));
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const result = await loadSqliteVecExtension({ db: db as never });
      expect(result.ok).toBe(true);
      expect(result.extensionPath).toBe("C:\\sqlite-vec\\vec0");
      expect(db.loadExtension).toHaveBeenCalledWith("C:\\sqlite-vec\\vec0");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("chains both errors when Windows .dll retry also fails", async () => {
    const loadablePath = "C:\\sqlite-vec\\vec0.dll";
    vi.doMock("sqlite-vec", () => ({
      getLoadablePath: () => loadablePath,
      load: vi.fn().mockImplementation(() => {
        throw new Error("first: no such module: vec0");
      }),
    }));
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn().mockImplementation(() => {
        throw new Error("retry: no such module: vec0");
      }),
    };

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const result = await loadSqliteVecExtension({ db: db as never });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("both load attempts failed on Windows");
      expect(result.error).toContain("retry: no such module: vec0");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("does not retry on non-Windows platforms when bundled load fails", async () => {
    const loadablePath = "/usr/lib/sqlite-vec/vec0.so";
    vi.doMock("sqlite-vec", () => ({
      getLoadablePath: () => loadablePath,
      load: vi.fn().mockImplementation(() => {
        throw new Error("no such module: vec0");
      }),
    }));
    const { loadSqliteVecExtension } = await importLoader();
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const result = await loadSqliteVecExtension({ db: db as never });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("no such module");
      expect(db.loadExtension).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
