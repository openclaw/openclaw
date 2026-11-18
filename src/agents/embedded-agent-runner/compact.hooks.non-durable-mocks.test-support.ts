import { vi } from "vitest";

/** Mocks the runtime modules that the non-durable compaction fixture replaces. */
export function mockNonDurableCompactionRuntime(getModelRegistryRuntime: () => unknown): void {
  vi.doMock("./prepared-compaction-session.js", async () => ({
    ...(await vi.importActual<typeof import("./prepared-compaction-session.js")>(
      "./prepared-compaction-session.js",
    )),
    needsCompactionSessionAdapter: () => true,
  }));
  vi.doMock("../sessions/model-registry-runtime.js", () => ({
    getModelRegistryRuntime,
  }));
}
