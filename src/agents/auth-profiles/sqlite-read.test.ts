import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as snapshots from "../../infra/sqlite-snapshot-source.js";
import * as identity from "../../infra/sqlite-worker-identity.js";
import * as coordinator from "../../infra/state-database-coordinator.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as resources from "../../state/openclaw-agent-db-resources.js";
import * as rootResources from "../../state/openclaw-state-db-cache.js";
import * as rootContext from "../../state/openclaw-state-worker-context.js";
import { prepareAgentAuthProfileRowsRead } from "./sqlite-read.js";
import type { AuthProfileRowRead } from "./types.js";

const child = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../infra/sqlite-readonly-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/sqlite-readonly-worker.js")>()),
  runSqliteReadOnlyWorker: child.read,
}));

const rows: AuthProfileRowRead = {
  store: { status: "readable", raw: { version: 1, profiles: {} } },
  state: { status: "missing", reason: "row" },
  cacheable: true,
};
const readers = new Set<ReturnType<typeof prepareAgentAuthProfileRowsRead>>();
function prepare(env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/fixture" }) {
  const reader = prepareAgentAuthProfileRowsRead({
    databasePath: "/fixture/auth.sqlite",
    agentId: "main",
    env,
  });
  readers.add(reader);
  return reader;
}

beforeEach(() => {
  vi.spyOn(identity, "inspectDatabasePathIdentitySync").mockReturnValue({
    key: "file:original",
    canonicalPath: "/fixture/auth.sqlite",
  });
  vi.spyOn(rootContext, "captureOpenClawStateWorkerContext").mockReturnValue({
    environment: { OPENCLAW_STATE_DIR: "/fixture" },
    coordinatorRuntime: { directory: "/fixture/coordinator", keepAlive: false },
    admission: {
      databasePath: "/fixture/state.sqlite",
      identity: { key: "file:root", canonicalPath: "/fixture/state.sqlite" },
      assertCurrent: () => {},
    },
  });
  vi.spyOn(coordinator, "prepareStateDatabaseSourceExclusion").mockReturnValue(undefined);
  child.read.mockReset().mockResolvedValue(rows);
});

afterEach(async () => {
  await Promise.all([...readers].map((reader) => reader.dispose()));
  readers.clear();
  vi.restoreAllMocks();
});

describe("prepared auth profile row reads", () => {
  it("retains revocable read authority even when persisted rows come from a cache", async () => {
    const reader = prepare();
    reader.assertCurrent();
    expect(resources.hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
    await Promise.all(resources.revokeAgentDatabaseResources({ path: "/fixture/auth.sqlite" }));
    expect(() => reader.assertCurrent()).toThrow("Auth profile read owner was revoked");
    expect(child.read).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "retains failed snapshot cleanup for disposal retry (read failure: %s)",
    async (failRead) => {
      const cleanup = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
      vi.spyOn(coordinator, "prepareStateDatabaseSourceExclusion").mockReturnValue(() => {});
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockResolvedValue({
        location: "/fixture/private/auth.sqlite",
        cleanupRoot: "/fixture/private",
        cleanup: () => false,
        cleanupAsync: cleanup,
      });
      const registerAgent = resources.registerOpenClawAgentDatabaseAsyncResource;
      const agentRegistration = vi
        .spyOn(resources, "registerOpenClawAgentDatabaseAsyncResource")
        .mockImplementation((resource) => vi.fn(registerAgent(resource)));
      const registerRoot = rootResources.registerOpenClawStateDatabaseAsyncResource;
      const rootRegistration = vi
        .spyOn(rootResources, "registerOpenClawStateDatabaseAsyncResource")
        .mockImplementation((resource) => vi.fn(registerRoot(resource)));
      const readError = new Error("original fixture read failure");
      if (failRead) {
        child.read.mockRejectedValue(readError);
      }
      const reader = prepare();
      try {
        const failure: unknown = await reader.read().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(child.read).toHaveBeenCalledWith(
          "/fixture/private/auth.sqlite",
          expect.objectContaining({ source: "snapshot" }),
        );
        const cleanupFailure = expect.objectContaining({
          message: "SQLite read-only worker snapshot cleanup failed: /fixture/private",
        });
        if (failRead) {
          expect(failure).toBeInstanceOf(AggregateError);
          expect(failure).toHaveProperty("cause", readError);
          expect(failure).toHaveProperty("errors", [readError, cleanupFailure]);
        } else {
          expect(failure).toEqual(cleanupFailure);
        }
        const unregisterAgent = agentRegistration.mock.results[0]?.value;
        const unregisterRoot = rootRegistration.mock.results[0]?.value;
        expect(resources.hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
        await expect(reader.dispose()).rejects.toThrow("Auth profile snapshot cleanup failed");
        expect(cleanup).toHaveBeenCalledTimes(2);
        expect(resources.hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
        expect(unregisterAgent).not.toHaveBeenCalled();
        expect(unregisterRoot).not.toHaveBeenCalled();

        cleanup.mockResolvedValue(true);
        await reader.dispose();
        await reader.dispose();
        expect(cleanup).toHaveBeenCalledTimes(3);
        expect(resources.hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
        expect(unregisterAgent).toHaveBeenCalledTimes(1);
        expect(unregisterRoot).toHaveBeenCalledTimes(1);
      } finally {
        cleanup.mockResolvedValue(true);
        await reader.dispose();
      }
    },
  );

  it("rejects rows whose source identity changed before the child settled", async () => {
    const reader = prepare();
    child.read.mockImplementation(async () => {
      vi.mocked(identity.inspectDatabasePathIdentitySync).mockReturnValue({
        key: "file:replacement",
        canonicalPath: "/fixture/auth.sqlite",
      });
      return rows;
    });
    await expect(reader.read()).rejects.toThrow("Auth profile database file identity changed");
  });

  it("captures environment and retains the agent owner through child settlement", async () => {
    const registration = vi.spyOn(resources, "registerOpenClawAgentDatabaseAsyncResource");
    const env = { OPENCLAW_STATE_DIR: "/fixture/original" };
    const reader = prepare(env);
    env.OPENCLAW_STATE_DIR = "/fixture/replaced";
    const entered = createDeferredCore();
    const release = createDeferredCore<AuthProfileRowRead>();
    child.read.mockImplementation(async () => {
      entered.resolve();
      return release.promise;
    });
    const reading = reader.read();
    let disposed = false;
    let closing: Promise<void> | undefined;
    try {
      await Promise.race([
        entered.promise,
        reading.then(() => {
          throw new Error("Child was not entered");
        }),
      ]);
      expect(registration).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", path: "/fixture/auth.sqlite" }),
      );
      expect(child.read).toHaveBeenCalledWith(
        "/fixture/auth.sqlite",
        expect.objectContaining({
          mode: "auth-profile-rows",
          source: "canonical",
          expectedIdentity: "file:original",
          env: { OPENCLAW_STATE_DIR: "/fixture/original" },
        }),
      );
      closing = reader.dispose().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);
      release.resolve(rows);
      await expect(reading).rejects.toThrow("Auth profile read owner closed");
      await closing;
      expect(disposed).toBe(true);
    } finally {
      release.resolve(rows);
      await Promise.allSettled([reading, closing ?? reader.dispose()]);
    }
  });

  it("keeps captured authority checkable after ordinary disposal but rejects new reads", async () => {
    const reader = prepare();
    await expect(reader.read()).resolves.toEqual(rows);
    await reader.dispose();
    expect(() => reader.assertCurrent()).not.toThrow();
    await expect(reader.read()).rejects.toThrow("Auth profile read owner closed");
  });
});
