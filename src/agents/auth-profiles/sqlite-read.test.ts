import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { prepareAgentAuthProfileRowsRead, type AuthProfileRowRead } from "./sqlite-read.js";

const worker = vi.hoisted(() => ({ execute: vi.fn(), close: vi.fn() }));
const identity = vi.hoisted(() => vi.fn());

vi.mock("../../infra/sqlite-worker-identity.js", () => ({
  inspectDatabasePathIdentitySync: identity,
}));
vi.mock("../../infra/sqlite-worker-store.js", () => ({
  openSqliteWorkerStore: async () => worker,
  runSqliteWorkerStoreOperation: async (
    scope: typeof worker,
    operation: (scope: typeof worker) => Promise<unknown>,
  ) => operation(scope),
}));
vi.mock("../../state/openclaw-state-worker-store.js", () => ({}));
vi.mock("../../state/openclaw-state-db-readonly.js", () => ({
  isArtifactPreservingStateRead: () => false,
}));

const rows: AuthProfileRowRead = {
  store: { status: "readable", raw: { version: 1, profiles: {} } },
  state: { status: "missing", reason: "row" },
};

beforeEach(() => {
  identity
    .mockReset()
    .mockReturnValue({ key: "file:original", canonicalPath: "/fixture/auth.sqlite" });
  worker.execute.mockReset().mockResolvedValue(rows);
  worker.close.mockReset().mockResolvedValue(undefined);
});

describe("prepared auth profile row reads", () => {
  it("rejects a result invalidated while worker close settles", async () => {
    const read = prepareAgentAuthProfileRowsRead("/fixture/auth.sqlite");
    worker.close.mockImplementation(async () => {
      identity.mockReturnValue({ key: "file:replacement", canonicalPath: "/fixture/auth.sqlite" });
    });

    await expect(read.read()).rejects.toThrow("Auth profile database file identity changed");
  });

  it("retains both read and cleanup failures with the original worker classification", async () => {
    const readFailure = new SqliteWorkerError("read unavailable", "unavailable");
    const cleanupFailure = new Error("cleanup failed");
    worker.execute.mockRejectedValue(readFailure);
    worker.close.mockRejectedValue(cleanupFailure);

    await expect(
      prepareAgentAuthProfileRowsRead("/fixture/auth.sqlite").read(),
    ).rejects.toMatchObject({
      errors: [readFailure, cleanupFailure],
      cause: readFailure,
      code: "unavailable",
    });
  });

  it("keeps a cleanup-only failure intact", async () => {
    const cleanupFailure = new Error("cleanup failed");
    worker.close.mockRejectedValue(cleanupFailure);

    await expect(prepareAgentAuthProfileRowsRead("/fixture/auth.sqlite").read()).rejects.toBe(
      cleanupFailure,
    );
  });
});
