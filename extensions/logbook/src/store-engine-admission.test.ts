import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, expect, it, vi } from "vitest";
import { LogbookStore } from "./store.js";

const engine = vi.hoisted(() => ({
  input: { connection: "postgresql://unused" },
  execute: vi.fn(),
  close: vi.fn(async () => {}),
  run: vi.fn(),
}));

// mock-isolation: Reject unadmitted transport writes without launching a worker.
vi.mock("openclaw/plugin-sdk/database-engine-runtime", () => ({
  getDatabaseEngineInput: () => engine.input,
  openEngineWorkerStore: async () => ({ execute: engine.execute, close: engine.close }),
  runEngineStoreOperation: engine.run,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

it("admits retention pruning through the selected PostgreSQL engine", async () => {
  engine.execute.mockRejectedValue(new Error("PostgreSQL writes require host admission"));
  engine.run.mockImplementation(
    async (
      _worker: unknown,
      input: unknown,
      writes: boolean,
      operation: (scope: { execute: () => Promise<number> }) => Promise<number>,
    ) => {
      expect(input).toEqual(engine.input);
      if (!writes) {
        throw new Error("PostgreSQL retention requires write admission");
      }
      return operation({ execute: async () => 7 });
    },
  );
  const store = await LogbookStore.open(
    tempDirs.make("logbook-engine-admission-"),
    new URL("file:///unused-logbook-worker.js"),
  );
  try {
    expect(await store.pruneFrames(123)).toBe(7);
  } finally {
    await store.close();
  }
});
