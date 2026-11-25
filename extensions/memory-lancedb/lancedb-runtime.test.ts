import { afterEach, assert, expect, test, vi } from "vitest";

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
    // Capture the synthetic host only during module load.
    return await vi.importActual<LoaderModule>("./lancedb-runtime.js");
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", archDescriptor);
  }
}

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
  // Replacement distinguishes the owner cache from Vite's module cache.
  expect((await loadLanceDbModule()) === first).toBe(true);
});

test.each([
  ["darwin", "memory-lancedb: LanceDB runtime is unavailable on darwin-x64."],
  ["linux", "memory-lancedb: bundled @lancedb/lancedb dependency is unavailable."],
] as const)("handles an unavailable %s runtime", async (platform, diagnostic) => {
  const dependencyFailure = new Error("dependency unavailable");
  vi.doMock("@lancedb/lancedb", () => {
    throw dependencyFailure;
  });
  const { loadLanceDbModule } = await loadRuntimeForHost(platform, "x64");
  const error = await loadLanceDbModule().catch((cause: unknown) => cause);
  expect(error).toHaveProperty("message", expect.stringContaining(diagnostic));
  assert(error && typeof error === "object" && "cause" in error);
  const importFailure = error.cause;
  assert(importFailure && typeof importFailure === "object" && "cause" in importFailure);
  expect(importFailure.cause).toBe(dependencyFailure);
  if (platform === "linux") {
    const connect = vi.fn();
    vi.doMock("@lancedb/lancedb", () => ({ connect }));
    const available = await import("@lancedb/lancedb");
    expect(available.connect).toBe(connect);
    // Do not reset the SUT: that would mask a sticky rejection.
    expect(await loadLanceDbModule()).toBe(available);
  }
});
