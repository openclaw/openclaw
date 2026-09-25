import { afterEach, describe, expect, test, vi } from "vitest";

type LoaderModule = typeof import("./lancedb-runtime.js");

async function loadRuntimeForHost(platform: NodeJS.Platform, arch: NodeJS.Architecture) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  if (!platformDescriptor || !archDescriptor) {
    throw new Error("Expected native process platform and architecture descriptors");
  }
  vi.resetModules();
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
    Object.defineProperty(process, "arch", { ...archDescriptor, value: arch });
    // The loader captures host identity when its module is loaded. Restore the
    // real process before requesting the mocked native dependency or running assertions.
    return await vi.importActual<LoaderModule>("./lancedb-runtime.js");
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", archDescriptor);
  }
}

async function rejectedLoad(load: () => Promise<unknown>): Promise<unknown> {
  try {
    await load();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the dependency load to reject");
}

function expectDependencyCause(error: unknown, dependencyFailure: Error) {
  // Vitest wraps a throwing manual module factory once; the product must keep
  // that import failure as cause instead of replacing or flattening it.
  if (!error || typeof error !== "object" || !("cause" in error)) {
    throw new Error("Expected the loader failure to retain its import cause");
  }
  const importFailure = error.cause;
  if (!importFailure || typeof importFailure !== "object" || !("cause" in importFailure)) {
    throw new Error("Expected the dependency import failure as cause");
  }
  expect(importFailure.cause).toBe(dependencyFailure);
}

describe("lancedb runtime loader", () => {
  afterEach(() => {
    vi.doUnmock("@lancedb/lancedb");
    vi.resetModules();
  });

  test("uses the bundled module when it is already available", async () => {
    const connect = vi.fn();
    const importBundled = vi.fn(() => ({ connect }));
    vi.doMock("@lancedb/lancedb", importBundled);
    const { loadLanceDbModule } = await loadRuntimeForHost("linux", "x64");
    expect(importBundled).not.toHaveBeenCalled();
    const [first, concurrent] = await Promise.all([loadLanceDbModule(), loadLanceDbModule()]);
    expect(first.connect).toBe(connect);
    expect(concurrent).toBe(first);
    expect(importBundled).toHaveBeenCalledTimes(1);

    const replacementConnect = vi.fn();
    vi.doMock("@lancedb/lancedb", () => ({ connect: replacementConnect }));
    const replacement = await import("@lancedb/lancedb");
    expect(replacement.connect).toBe(replacementConnect);
    expect(replacement).not.toBe(first);
    // The dependency replacement witness above makes this an owner-cache
    // assertion, rather than merely observing Vite's own module cache.
    expect((await loadLanceDbModule()) === first).toBe(true);
  });

  test("fails clearly on Intel macOS instead of attempting an unsupported native install", async () => {
    const dependencyFailure = new Error("Cannot find native binding");
    vi.doMock("@lancedb/lancedb", () => {
      throw dependencyFailure;
    });
    const { loadLanceDbModule } = await loadRuntimeForHost("darwin", "x64");
    const error = await rejectedLoad(loadLanceDbModule);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("memory-lancedb: LanceDB runtime is unavailable on darwin-x64."),
    );
    expectDependencyCause(error, dependencyFailure);
  });

  test("fails fast when package dependencies are missing", async () => {
    const dependencyFailure = new Error("Cannot find package '@lancedb/lancedb'");
    vi.doMock("@lancedb/lancedb", () => {
      throw dependencyFailure;
    });
    const { loadLanceDbModule } = await loadRuntimeForHost("linux", "x64");
    const error = await rejectedLoad(loadLanceDbModule);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(
        "memory-lancedb: bundled @lancedb/lancedb dependency is unavailable.",
      ),
    );
    expectDependencyCause(error, dependencyFailure);
  });

  test("clears the cached failure so later calls can retry the package import", async () => {
    const dependencyFailure = new Error("network down");
    vi.doMock("@lancedb/lancedb", () => {
      throw dependencyFailure;
    });
    const { loadLanceDbModule } = await loadRuntimeForHost("linux", "x64");
    expectDependencyCause(await rejectedLoad(loadLanceDbModule), dependencyFailure);

    const connect = vi.fn();
    vi.doMock("@lancedb/lancedb", () => ({ connect }));
    const available = await import("@lancedb/lancedb");
    expect(available.connect).toBe(connect);
    // Only the dependency changed; the same SUT closure must discard its failed
    // load and recover. Resetting the SUT here would mask a sticky rejection.
    expect(await loadLanceDbModule()).toBe(available);
  });
});
