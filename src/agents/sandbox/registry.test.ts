import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { sandboxRegistryPublication } from "./registry-publication.js";
import {
  completeSandboxRegistryReservation,
  readBrowserRegistry,
  assertSandboxRegistryEntryCurrent,
  assertSandboxBrowserRegistryEntryCurrent,
  readRegisteredSandboxRuntimeIds,
  readRegistry,
  readRegistryEntry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  removeSandboxRegistryGeneration,
  removeSandboxRegistryRuntime,
  reserveSandboxRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "./registry.js";
import { writeSandboxRegistryInDatabase, type SandboxRegistryWrite } from "./registry.kernel.js";
import { captureSandboxStateOwner } from "./state-owner.js";

type SandboxBrowserRegistryEntry = import("./registry.js").SandboxBrowserRegistryEntry;
type SandboxRegistryEntry = import("./registry.js").SandboxRegistryEntry;
type Facts = Extract<
  Parameters<Parameters<typeof sandboxRegistryPublication.subscribeFacts>[0]>[0],
  { facts: unknown }
>;
const cleanups: Array<() => void> = [];

function observeFacts(listener: (receipt: Facts) => void) {
  cleanups.push(
    sandboxRegistryPublication.subscribeFacts((receipt) => {
      if ("facts" in receipt) {
        listener(receipt);
      }
    }),
  );
}

function observeSql() {
  const calls = observeMainThreadSql();
  cleanups.push(calls.restore);
  calls.calibrate();
  return calls;
}

function forbidSql() {
  vi.spyOn(sqliteQueries, "executeSqliteQuerySync").mockImplementation(() => {
    throw new Error("Registry writes must not execute SQL on the host");
  });
}

const expectEntry = (name: string) => expect(readRegistryEntry(name)).resolves;
const reserveEntry = (overrides: Partial<SandboxRegistryEntry> = {}) =>
  reserveSandboxRegistryEntry(
    containerEntry({
      backendId: "boundary",
      workspaceDir: "/synthetic/workspace",
      ...overrides,
    }),
  );
const nativeWrite = (write: SandboxRegistryWrite) =>
  runOpenClawStateWriteTransaction(({ db }) => writeSandboxRegistryInDatabase(db, write));
const postimage = (entry_json: unknown) => ({
  kind: "postimage",
  value: expect.objectContaining({ entry_json }),
});

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stop of cleanups.splice(0).toReversed()) {
      stop();
    }
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
let stateDir: string;
beforeEach(() => {
  stateDir = dirs.make("sandbox-registry-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

function browserEntry(
  overrides: Partial<SandboxBrowserRegistryEntry> = {},
): SandboxBrowserRegistryEntry {
  return {
    ...containerEntry(),
    containerName: "browser-a",
    image: "openclaw-browser:test",
    cdpPort: 9222,
    ...overrides,
  };
}

function containerEntry(overrides: Partial<SandboxRegistryEntry> = {}): SandboxRegistryEntry {
  return {
    containerName: "container-a",
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "openclaw-sandbox:test",
    ...overrides,
  };
}

describe("registry race safety", () => {
  it("publishes every native batch row before observers and discards nested or outer rollback", () => {
    const facts = new Map<string, unknown>();
    const observed: string[][] = [];
    observeFacts(({ facts: batch }) => {
      for (const [key, fact] of batch) {
        facts.set(key, fact);
      }
    });
    const write = (db: Parameters<typeof writeSandboxRegistryInDatabase>[0], name: string) => {
      writeSandboxRegistryInDatabase(db, {
        operation: "update",
        entry: containerEntry({ containerName: name }),
      });
      deferSqlitePostCommitPublication(db, () => observed.push([...facts.keys()]));
    };
    runOpenClawStateWriteTransaction(({ db }) => {
      write(db, "first");
      expect(() =>
        runOpenClawStateWriteTransaction(({ db: nested }) => {
          write(nested, "rolled-back");
          throw new Error("rollback savepoint");
        }),
      ).toThrow("rollback savepoint");
      write(db, "second");
      expect(observed).toEqual([]);
      expect(facts.size).toBe(0);
    });
    const committedKeys = [
      JSON.stringify(["container", "first"]),
      JSON.stringify(["container", "second"]),
    ];
    expect(observed).toEqual([committedKeys, committedKeys]);
    expect(() =>
      runOpenClawStateWriteTransaction(({ db }) => {
        writeSandboxRegistryInDatabase(db, { operation: "remove", containerName: "first" });
        deferSqlitePostCommitPublication(db, () => observed.push([...facts.keys()]));
        throw new Error("rollback outer");
      }),
    ).toThrow("rollback outer");
    expect(observed).toHaveLength(2);
    nativeWrite({ operation: "remove", containerName: "first" });
    expect(facts.get(committedKeys[0]!)).toEqual({ kind: "absent" });
  });

  it("cannot restore a newer native deletion when a committed worker receipt arrives late", async () => {
    const entry = containerEntry();
    nativeWrite({ operation: "update", entry });
    const observe = admission.observeSqliteWorkerCommittedFacts;
    vi.spyOn(admission, "observeSqliteWorkerCommittedFacts").mockImplementation((owner, listener) =>
      observe(owner, (receipt) => {
        nativeWrite({ operation: "remove", containerName: entry.containerName });
        listener(receipt);
      }),
    );
    const published: unknown[] = [];
    observeFacts((receipt) => published.push(...receipt.facts.values()));
    await updateRegistry({ ...entry, lastUsedAtMs: 2 });
    await expectEntry(entry.containerName).toBeNull();
    expect(published).toEqual([{ kind: "absent" }, { kind: "unknown" }]);
  });

  it("keeps reservation and removal intent SQL off the caller thread", async () => {
    await updateRegistry(containerEntry({ containerName: "admission-fixture" }));
    const calls = observeSql();
    const publications: Facts[] = [];
    observeFacts((receipt) => publications.push(receipt));
    const removeRuntime = vi.fn(async () => {});
    const reserved = await reserveEntry({
      containerName: "reserved-boundary",
      sessionKey: "agent:boundary",
    });
    expect(reserved).toMatchObject({
      containerName: "reserved-boundary",
      runtimeState: "pending",
    });
    await removeSandboxRegistryRuntime(reserved, removeRuntime);
    expect(removeRuntime).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        containerName: "reserved-boundary",
        runtimeState: "removing-pending",
      }),
    );
    await expectEntry(reserved.containerName).toBeNull();
    const key = JSON.stringify(["container", reserved.containerName]);
    expect(publications.map((receipt) => receipt.facts.get(key))).toEqual([
      postimage(JSON.stringify(reserved)),
      postimage(expect.stringContaining('"runtimeState":"removing-pending"')),
      { kind: "absent" },
    ]);
    expect(new Set(publications.map((receipt) => receipt.source.identity)).size).toBe(1);
    calls.expectIdle();
  });

  it("preserves a runtime whose activity advanced after the prune scan", async () => {
    const entry = await reserveEntry();
    const now = 2 * 60 * 60 * 1000;
    await updateRegistry({ ...entry, lastUsedAtMs: now });
    const removeRuntime = vi.fn(async () => {});
    await removeSandboxRegistryRuntime(entry, removeRuntime, {
      prune: { now, idleHours: 1, maxAgeDays: 0 },
    });
    expect(removeRuntime).not.toHaveBeenCalled();
    await expectEntry(entry.containerName).toMatchObject({
      lastUsedAtMs: now,
      runtimeState: "pending",
    });
  });

  it("settles accepted removal across direct database close", async ({ signal }) => {
    const entry = await reserveEntry();
    const providerEntered = createDeferred();
    const releaseProvider = createDeferred();
    const removeRuntime = vi.fn(async () => {
      providerEntered.resolve();
      await releaseProvider.promise;
    });
    const removing = removeSandboxRegistryRuntime(entry, removeRuntime);
    let closing: Promise<void> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          providerEntered.promise,
          removing,
          "Removal settled before its provider accepted cleanup",
        ),
        signal,
      );
      closing = closeOpenClawStateDatabaseAsync();
      releaseProvider.resolve();
      await withinTest(Promise.all([removing, closing]), signal);
      expect(removeRuntime).toHaveBeenCalledOnce();
      await expectEntry(entry.containerName).toBeNull();
    } finally {
      releaseProvider.resolve();
      await Promise.allSettled([removing, closing]);
    }
  });

  it("refuses queued browser publication after hosted custody is released", async () => {
    const owner = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: path.join(stateDir, "openclaw.json"),
        role: "gateway",
      },
    });
    try {
      await updateRegistry(containerEntry());
      const assertCurrent = await captureSandboxStateOwner();
      const publication = updateBrowserRegistry(browserEntry(), assertCurrent);
      owner.release();
      await expect(publication).rejects.toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
      await expect(readBrowserRegistry()).resolves.toEqual({ entries: [] });
    } finally {
      owner.release();
    }
  });

  it("settles browser activity in workers while preserving captured fields and workspace custody", async () => {
    // Admit the schema before observing the runtime write boundary.
    await updateRegistry(containerEntry());
    forbidSql();
    const entry = browserEntry({ workspaceDir: "/original/workspace", cdpPort: 0 });
    const reservation = updateBrowserRegistry(entry);
    entry.image = "changed-after-dispatch";
    entry.workspaceDir = "/changed-after-dispatch";
    await reservation;
    await updateBrowserRegistry(
      browserEntry({ createdAtMs: 99, lastUsedAtMs: 2, image: "ignored" }),
    );
    await expect(readBrowserRegistry()).resolves.toEqual({
      entries: [browserEntry({ workspaceDir: "/original/workspace", lastUsedAtMs: 2 })],
    });
    const [selected] = (await readBrowserRegistry()).entries;
    expect(() => assertSandboxBrowserRegistryEntryCurrent(selected!)).not.toThrow();
    await updateBrowserRegistry(browserEntry({ workspaceDir: "/other/workspace" }));
    expect(() => assertSandboxBrowserRegistryEntryCurrent(selected!)).toThrow("owner changed");
  });

  it("captures a Podman target and preserves immutable fields across usage updates", async () => {
    const target = {
      key: "machine:target-a",
      globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
    };
    const entry = containerEntry({
      backendId: "podman",
      backendTarget: target,
      createdAtMs: 11,
      workspaceDir: "/original/workspace",
    });
    const initialWrite = updateRegistry(entry);
    target.globalArgs[1] = "ssh://changed-after-dispatch/run/podman/podman.sock";
    entry.createdAtMs = 99;
    entry.image = "changed-after-dispatch";
    entry.workspaceDir = "/changed-after-dispatch";
    await initialWrite;
    await updateRegistry(
      containerEntry({
        backendId: "podman",
        lastUsedAtMs: 2,
        workspaceDir: "/later/workspace",
      }),
    );

    await expectEntry("container-a").toMatchObject({
      backendId: "podman",
      backendTarget: {
        key: "machine:target-a",
        globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
      },
      lastUsedAtMs: 2,
      createdAtMs: 11,
      image: "openclaw-sandbox:test",
      workspaceDir: "/original/workspace",
    });
  });

  it("settles runtime registry writes in the worker and retains pending completion rules", async () => {
    const entry = containerEntry({
      backendId: "docker",
      runtimeState: "pending",
      workspaceDir: "/original/workspace",
    });
    await updateRegistry(entry);
    forbidSql();
    await updateRegistry({ ...entry, lastUsedAtMs: 2, createdAtMs: 99, image: "ignored-update" });
    await completeSandboxRegistryReservation({
      ...entry,
      lastUsedAtMs: 3,
      image: "initialized-image",
    });
    await completeSandboxRegistryReservation({
      ...entry,
      lastUsedAtMs: 4,
      image: "ignored-ready",
    });
    await expectEntry(entry.containerName).toMatchObject({
      runtimeState: "ready",
      createdAtMs: 1,
      lastUsedAtMs: 4,
      image: "initialized-image",
      workspaceDir: "/original/workspace",
    });
    await completeSandboxRegistryReservation(entry, true);
    await expectEntry(entry.containerName).toBeNull();
    await updateRegistry({ ...entry, containerName: "direct-remove" });
    await removeRegistryEntry("direct-remove", { preserveRemovalIntent: true });
    await expectEntry("direct-remove").toBeNull();
  });

  it("refuses pending publication, completion or retirement after removal intent", async () => {
    for (const state of ["missing", "removing", "removing-pending"] as const) {
      const entry = containerEntry({ containerName: state, backendId: "docker" });
      if (state !== "missing") {
        await updateRegistry({ ...entry, runtimeState: state });
      }
      const before = await readRegistryEntry(entry.containerName);
      if (state !== "missing") {
        await expect(updateRegistry({ ...entry, runtimeState: "pending" })).rejects.toThrow(
          "Sandbox runtime was removed or is being removed",
        );
      }
      for (const retired of [false, true]) {
        await expect(completeSandboxRegistryReservation(entry, retired)).rejects.toThrow(
          "Sandbox runtime was removed or is being removed",
        );
      }
      await expectEntry(entry.containerName).toEqual(before);
      await removeRegistryEntry(entry.containerName, { preserveRemovalIntent: true });
      await expectEntry(entry.containerName).toEqual(before);
      await removeRegistryEntry(entry.containerName);
      await expectEntry(entry.containerName).toBeNull();
    }
  });

  it("refuses completion and retirement of a replaced reservation in the worker", async () => {
    const original = await reserveEntry({ workspaceDir: "/original/workspace" });
    await removeRegistryEntry(original.containerName);
    const replacement = await reserveSandboxRegistryEntry({
      ...original,
      createdAtMs: original.createdAtMs + 1,
      workspaceDir: "/replacement/workspace",
    });
    const calls = observeSql();
    expect(() => assertSandboxRegistryEntryCurrent(original)).toThrow("generation changed");
    expect(() => assertSandboxRegistryEntryCurrent(replacement)).not.toThrow();
    expect(() => assertSandboxRegistryEntryCurrent({ ...replacement })).not.toThrow();
    await updateRegistry({ ...replacement, lastUsedAtMs: 999 });
    expect(() => assertSandboxRegistryEntryCurrent(replacement)).not.toThrow();
    for (const retired of [false, true]) {
      await expect(completeSandboxRegistryReservation(original, retired)).rejects.toThrow(
        "Sandbox runtime generation changed",
      );
    }
    await expectEntry(original.containerName).toMatchObject({
      ...replacement,
      lastUsedAtMs: 999,
    });
    calls.expectIdle();
  });

  it("reads registered runtime IDs for one backend and scope newest first", async () => {
    for (const [containerName, backendId, sessionKey, lastUsedAtMs] of [
      ["openshell-older", "openshell", "agent:main", 10],
      ["openshell-newer", "openshell", "agent:main", 20],
      ["docker-same-scope", "docker", "agent:main", 30],
      ["openshell-other-scope", "openshell", "agent:other", 40],
    ] as const) {
      await updateRegistry(containerEntry({ containerName, backendId, sessionKey, lastUsedAtMs }));
    }

    await expect(
      readRegisteredSandboxRuntimeIds({
        backendId: "openshell",
        scopeKey: "agent:main",
      }),
    ).resolves.toEqual(["openshell-newer", "openshell-older"]);
  });

  it("stores unsafe container names without writing path-derived files", async () => {
    await updateRegistry(containerEntry({ containerName: "../escape" }));

    const registry = await readRegistry();

    expect(registry.entries.map((entry) => entry.containerName)).toEqual(["../escape"]);
    await expect(fs.access(`${stateDir}/escape.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["container", "browser"] as const)(
    "keeps concurrent %s updates in deterministic name order",
    async (kind) => {
      await Promise.all(
        ["c", "a", "b"].map((name, index) => {
          const containerName = `${kind}-${name}`;
          return kind === "container"
            ? updateRegistry(containerEntry({ containerName }))
            : updateBrowserRegistry(browserEntry({ containerName, cdpPort: 9222 + index }));
        }),
      );
      const registry = await (kind === "container" ? readRegistry() : readBrowserRegistry());
      expect(registry.entries.map((entry) => entry.containerName)).toEqual(
        ["a", "b", "c"].map((name) => `${kind}-${name}`),
      );
    },
  );

  it.each(["container", "name", "generation"] as const)(
    "prevents a queued update from overtaking %s removal",
    async (removal) => {
      if (removal === "container") {
        await updateRegistry(containerEntry({ containerName: "container-x" }));
        await Promise.all([
          updateRegistry(containerEntry({ containerName: "container-x", configHash: "updated" })),
          removeRegistryEntry("container-x"),
        ]);
        expect((await readRegistry()).entries).toHaveLength(0);
        return;
      }
      const entry = browserEntry({ containerName: "browser-x" });
      await updateBrowserRegistry(entry);
      await updateRegistry(containerEntry({ containerName: "browser-x" }));
      // Neither call is awaited: removal must follow the already accepted activity write.
      const updatePromise = updateBrowserRegistry({ ...entry, lastUsedAtMs: 2 });
      const removePromise =
        removal === "name"
          ? removeBrowserRegistryEntry("browser-x")
          : removeSandboxRegistryGeneration("browser", entry, () => {});
      await Promise.all([updatePromise, removePromise]);

      const registry = await readBrowserRegistry();
      expect(registry.entries).toHaveLength(0);
      await expectEntry("browser-x").toMatchObject({
        containerName: "browser-x",
      });
    },
  );
});
