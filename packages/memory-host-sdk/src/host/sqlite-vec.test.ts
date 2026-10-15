// Memory Host SDK tests cover sqlite vec behavior.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

function mockMissingSqliteVecPackage(): void {
  vi.doMock("sqlite-vec", () => {
    const err = new Error("Cannot find package 'sqlite-vec' imported from sqlite-vec.test.ts");
    Object.assign(err, { code: "ERR_MODULE_NOT_FOUND" });
    throw err;
  });
}

function mockFailingSqliteVecPackage(): void {
  vi.doMock("sqlite-vec", () => ({
    getLoadablePath: () => {
      throw new Error("bundled sqlite-vec load failed");
    },
  }));
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

function createDbMock(params?: { readonly healthError?: Error }) {
  const get = vi.fn(() => ({ version: "v0.1.9" }));
  const prepare = vi.fn(() => {
    if (params?.healthError) {
      throw params.healthError;
    }
    return { get };
  });
  return {
    db: {
      isOpen: true,
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
      prepare,
    },
    get,
    prepare,
  };
}

afterEach(() => {
  vi.doUnmock("sqlite-vec");
  vi.doUnmock("./sqlite-vec-platform-variant.js");
  vi.resetModules();
});

describe("loadSqliteVecExtension", () => {
  it("rejects a connection revoked while the native module imports", async () => {
    const started = createDeferred();
    const imported = createDeferred();
    vi.doMock("sqlite-vec", async () => {
      started.resolve();
      await imported.promise;
      return { getLoadablePath: () => "/fixture/vec0" };
    });
    mockPlatformVariantResolver(undefined);
    const { loadSqliteVecExtension } = await importLoader();
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    // Observe the unsafe call without crashing Node versions that dereference a closed handle.
    const enable = vi.spyOn(db, "enableLoadExtension").mockImplementation(() => {});
    const loading = loadSqliteVecExtension({ db });
    await started.promise;
    db.close();
    imported.resolve();

    const result = await loading;
    expect(enable).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("database is closed"),
    });
  });

  it("rejects a loaded extension when sqlite-vec functions are unavailable", async () => {
    mockMissingSqliteVecPackage();
    const { loadSqliteVecExtension } = await importLoader();
    const { db } = createDbMock({ healthError: new Error("no such function: vec_version") });

    const result = await loadSqliteVecExtension({
      db: db as never,
      extensionPath: "/opt/openclaw/sqlite-vec.so",
    });

    expect(result).toEqual({
      ok: false,
      error:
        "sqlite-vec health check failed after loading /opt/openclaw/sqlite-vec.so | no such function: vec_version",
    });
    expect(db.loadExtension).toHaveBeenCalledWith("/opt/openclaw/sqlite-vec.so");
    expect(db.enableLoadExtension).toHaveBeenLastCalledWith(false);
  });

  it("returns a valid memory.search extensionPath hint when sqlite-vec is absent", async () => {
    mockMissingSqliteVecPackage();
    mockPlatformVariantResolver(undefined);
    const { loadSqliteVecExtension } = await importLoader();
    const { db } = createDbMock();

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(
        /^sqlite-vec package is not installed\. Set memory\.search\.store\.vector\.extensionPath, or an agent-specific memory\.search\.store\.vector\.extensionPath, to a sqlite-vec loadable extension path\. Original error: (?:\[vitest\] There was an error when mocking a module\. If you are using "vi\.mock" factory, make sure there are no top level variables inside, since this call is hoisted to top of the file\. Read more: https:\/\/vitest\.dev\/api\/vi\.html#vi-mock \| )?Cannot find package 'sqlite-vec' imported from sqlite-vec\.test\.ts \| ERR_MODULE_NOT_FOUND$/u,
      ),
    });
    expect(result.error).not.toContain("memory.store.vector.extensionPath");
    expect(db.enableLoadExtension).not.toHaveBeenCalled();
    expect(db.loadExtension).not.toHaveBeenCalled();
  });

  it("falls back to the platform variant when bundled sqlite-vec load fails", async () => {
    mockFailingSqliteVecPackage();
    mockPlatformVariantResolver({
      pkg: "sqlite-vec-linux-x64",
      extensionPath: "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    });
    const { loadSqliteVecExtension } = await importLoader();
    const { db, prepare } = createDbMock();

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result).toEqual({
      ok: true,
      extensionPath: "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    });
    expect(db.loadExtension).toHaveBeenCalledWith(
      "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    );
    expect(prepare).toHaveBeenCalledWith("SELECT vec_version() AS version");
  });

  it("rejects a platform variant when sqlite-vec functions are unavailable", async () => {
    mockMissingSqliteVecPackage();
    mockPlatformVariantResolver({
      pkg: "sqlite-vec-linux-x64",
      extensionPath: "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    });
    const { loadSqliteVecExtension } = await importLoader();
    const { db } = createDbMock({ healthError: new Error("no such function: vec_version") });

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result).toEqual({
      ok: false,
      error:
        "sqlite-vec platform variant sqlite-vec-linux-x64 failed to load from /install/node_modules/sqlite-vec-linux-x64/vec0.so. Set memory.search.store.vector.extensionPath, or an agent-specific memory.search.store.vector.extensionPath, to a sqlite-vec loadable extension path. Original error: sqlite-vec health check failed after loading /install/node_modules/sqlite-vec-linux-x64/vec0.so | no such function: vec_version",
    });
  });

  it("preserves bundled sqlite-vec and platform variant errors when both fail", async () => {
    mockFailingSqliteVecPackage();
    mockPlatformVariantResolver({
      pkg: "sqlite-vec-linux-x64",
      extensionPath: "/install/node_modules/sqlite-vec-linux-x64/vec0.so",
    });
    const { loadSqliteVecExtension } = await importLoader();
    const { db } = createDbMock();
    db.loadExtension.mockImplementation(() => {
      throw new Error("platform variant failed");
    });

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result).toEqual({
      ok: false,
      error:
        "sqlite-vec package failed to load, and platform variant sqlite-vec-linux-x64 failed to load from /install/node_modules/sqlite-vec-linux-x64/vec0.so. Set memory.search.store.vector.extensionPath, or an agent-specific memory.search.store.vector.extensionPath, to a sqlite-vec loadable extension path. Package error: bundled sqlite-vec load failed. Variant error: platform variant failed",
    });
  });
});
