import fs from "node:fs/promises";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { sandboxListCommand } from "../../commands/sandbox.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  executeSqliteQuerySync as execute,
  getNodeSqliteKysely as query,
} from "../../infra/kysely-sync.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import { registerSandboxBackend } from "./backend.js";
import { sandboxRegistryPublication } from "./registry-publication.js";
import {
  completeSandboxRegistryReservation as completeReservation,
  readBrowserRegistry,
  assertSandboxRegistryEntryCurrent as assertCurrent,
  assertSandboxBrowserRegistryEntryCurrent as assertBrowserCurrent,
  assertSandboxRegistryRetirementCurrent as assertRetirementCurrent,
  readRegisteredSandboxRuntimeIds,
  readRegistry,
  readRegistryEntry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  removeSandboxRegistryGeneration,
  removeSandboxRegistryRuntime as removeRuntime,
  reserveSandboxRegistryEntry as reserveEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "./registry.js";
import { writeSandboxRegistryInDatabase } from "./registry.kernel.js";
import { acquireSandboxGatewayOwner, useSandboxRegistryState } from "./registry.test-support.js";
import { captureSandboxStateOwner } from "./state-owner.js";

type SandboxBrowserRegistryEntry = import("./registry.js").SandboxBrowserRegistryEntry;
type SandboxRegistryEntry = import("./registry.js").SandboxRegistryEntry;

const fixture = useSandboxRegistryState("openclaw-sandbox-registry-");

function browserEntry(
  overrides: Partial<SandboxBrowserRegistryEntry> = {},
): SandboxBrowserRegistryEntry {
  return {
    ...containerEntry({ containerName: "browser-a", image: "openclaw-browser:test" }),
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

const reserve = (backendId: string) =>
  reserveEntry(containerEntry({ backendId, workspaceDir: "/synthetic/workspace" }));
const forbidHostSql = () =>
  vi.spyOn(sqliteQueries, "executeSqliteQuerySync").mockImplementation(() => {
    throw new Error("Registry writes must not execute SQL on the host");
  });

const expectEntry = (name: string, entry: Partial<SandboxRegistryEntry>) =>
  expect(readRegistryEntry(name)).resolves.toMatchObject(entry);
const expectAbsent = (name: string) => expect(readRegistryEntry(name)).resolves.toBeNull();
const writeNative = (write: Parameters<typeof writeSandboxRegistryInDatabase>[1]) =>
  runOpenClawStateWriteTransaction(({ db }) => writeSandboxRegistryInDatabase(db, write));

type RegistryReceipt = Extract<
  Parameters<Parameters<typeof sandboxRegistryPublication.subscribeFacts>[0]>[0],
  { facts: unknown }
>;

function recordRegistryFacts() {
  const facts = new Map<string, unknown>();
  const receipts: RegistryReceipt[] = [];
  const unsubscribe = sandboxRegistryPublication.subscribeFacts((change) => {
    if ("facts" in change) {
      receipts.push(change);
      for (const [key, fact] of change.facts) {
        facts.set(key, fact);
      }
    }
  });
  return { facts, receipts, [Symbol.dispose]: unsubscribe };
}

describe("registry race safety", () => {
  it.each(["container", "browser"] as const)(
    "keeps retirement authority current across %s activity, replacement, and unknown writes",
    async (kind) => {
      const update = (patch: { lastUsedAtMs?: number; createdAtMs?: number } = {}) =>
        kind === "container"
          ? updateRegistry(containerEntry({ runtimeState: "removing", ...patch }))
          : updateBrowserRegistry(browserEntry(patch));
      const read = kind === "container" ? readRegistry : readBrowserRegistry;
      await update();
      const [selected] = (await read()).entries;
      await expect(assertRetirementCurrent(kind, selected!)).resolves.toBeUndefined();
      await update({ lastUsedAtMs: 2 });
      await expect(assertRetirementCurrent(kind, selected!)).resolves.toBeUndefined();

      await removeSandboxRegistryGeneration(kind, selected!);
      await expect(assertRetirementCurrent(kind, selected!)).rejects.toThrow("generation changed");
      await update({ createdAtMs: 2 });
      await expect(assertRetirementCurrent(kind, selected!)).rejects.toThrow("generation changed");
      const [replacement] = (await read()).entries;
      await expect(assertRetirementCurrent(kind, replacement!)).resolves.toBeUndefined();
      // A superseded worker receipt leaves the generation unknown until it is read again.
      const observe = admission.observeSqliteWorkerCommittedFacts;
      vi.spyOn(admission, "observeSqliteWorkerCommittedFacts").mockImplementation(
        (owner, listener) =>
          observe(owner, (receipt) => {
            writeNative(
              kind === "container"
                ? { operation: "update", entry: { ...replacement!, lastUsedAtMs: 4 } }
                : {
                    operation: "updateBrowser",
                    entry: browserEntry({ createdAtMs: 2, lastUsedAtMs: 4 }),
                  },
            );
            listener(receipt);
          }),
      );
      await update({ createdAtMs: 2, lastUsedAtMs: 3 });
      await expect(assertRetirementCurrent(kind, replacement!)).rejects.toThrow(
        "generation changed",
      );
    },
  );

  it("publishes every native batch row before observers and discards nested or outer rollback", () => {
    using recording = recordRegistryFacts();
    const { facts } = recording;
    const observed: string[][] = [];
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
    writeNative({ operation: "remove", containerName: "first" });
    expect(facts.get(committedKeys[0]!)).toEqual({ kind: "absent" });
  });

  it("cannot restore a newer native deletion when a committed worker receipt arrives late", async () => {
    const entry = containerEntry();
    writeNative({ operation: "update", entry });
    const observe = admission.observeSqliteWorkerCommittedFacts;
    vi.spyOn(admission, "observeSqliteWorkerCommittedFacts").mockImplementation((owner, listener) =>
      observe(owner, (receipt) => {
        writeNative({ operation: "remove", containerName: entry.containerName });
        listener(receipt);
      }),
    );
    using recording = recordRegistryFacts();
    await updateRegistry({ ...entry, lastUsedAtMs: 2 });
    await expectAbsent(entry.containerName);
    expect(recording.receipts.flatMap((receipt) => Array.from(receipt.facts.values()))).toEqual([
      { kind: "absent" },
      { kind: "unknown" },
    ]);
  });

  it("keeps reservation and removal intent SQL off the caller thread", async () => {
    await updateRegistry(containerEntry({ containerName: "admission-fixture" }));
    const calls = observeMainThreadSql();
    calls.calibrate();
    using recording = recordRegistryFacts();
    const { receipts: publications } = recording;
    const cleanup = vi.fn(async () => {});
    const reserved = await reserve("boundary");
    expect(reserved).toMatchObject({ containerName: "container-a", runtimeState: "pending" });
    await removeRuntime(reserved, cleanup);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        containerName: reserved.containerName,
        runtimeState: "removing-pending",
      }),
    );
    await expectAbsent(reserved.containerName);
    const key = JSON.stringify(["container", reserved.containerName]);
    expect(
      publications.map((receipt) => {
        const fact = receipt.facts.get(key);
        return fact?.kind === "postimage" ? fact.value.entry_json : fact?.kind;
      }),
    ).toEqual([
      JSON.stringify(reserved),
      expect.stringContaining('"runtimeState":"removing-pending"'),
      "absent",
    ]);
    expect(new Set(publications.map((receipt) => receipt.source.identity)).size).toBe(1);
    calls.expectIdle();
  });

  it("preserves a runtime whose activity advanced after the prune scan", async () => {
    const entry = await reserve("prune-boundary");
    const now = 2 * 60 * 60 * 1000;
    await updateRegistry({ ...entry, lastUsedAtMs: now });
    const cleanup = vi.fn(async () => {});
    await removeRuntime(entry, cleanup, {
      prune: { now, idleHours: 1, maxAgeDays: 0 },
    });
    expect(cleanup).not.toHaveBeenCalled();
    await expectEntry(entry.containerName, {
      lastUsedAtMs: now,
      runtimeState: "pending",
    });
  });

  it("settles accepted removal across direct database close", async ({ signal }) => {
    const entry = await reserve("close-boundary");
    const provider = createEnteredGate();
    const cleanup = vi.fn(provider.wait);
    const removing = removeRuntime(entry, cleanup);
    let closing: Promise<void> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          provider.entered,
          removing,
          "Removal settled before its provider accepted cleanup",
        ),
        signal,
      );
      closing = closeOpenClawStateDatabaseAsync();
      provider.release();
      await withinTest(Promise.all([removing, closing]), signal);
      expect(cleanup).toHaveBeenCalledOnce();
      await expectAbsent(entry.containerName);
    } finally {
      provider.release();
      await Promise.allSettled([removing, closing]);
    }
  });

  it("refuses queued browser publication after hosted custody is released", async () => {
    using owner = acquireSandboxGatewayOwner(fixture.root);
    await updateRegistry(containerEntry());
    const assertOwner = await captureSandboxStateOwner();
    const publication = updateBrowserRegistry(browserEntry(), assertOwner);
    owner.release();
    await expect(publication).rejects.toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
    await expect(readBrowserRegistry()).resolves.toEqual({ entries: [] });
  });

  it("settles browser activity in workers while preserving immutable fields and workspace custody", async () => {
    await updateRegistry(containerEntry());
    forbidHostSql();
    const entry = browserEntry({ workspaceDir: "/original/workspace", cdpPort: 0 });
    await updateBrowserRegistry(entry);
    await updateBrowserRegistry(
      browserEntry({ createdAtMs: 99, lastUsedAtMs: 2, image: "ignored" }),
    );
    await expect(readBrowserRegistry()).resolves.toEqual({
      entries: [browserEntry({ workspaceDir: "/original/workspace", lastUsedAtMs: 2 })],
    });
    const [selected] = (await readBrowserRegistry()).entries;
    expect(() => assertBrowserCurrent(selected!)).not.toThrow();
    await updateBrowserRegistry(browserEntry({ workspaceDir: "/other/workspace" }));
    expect(() => assertBrowserCurrent(selected!)).toThrow("owner changed");
  });

  it("preserves the Podman target and immutable fields across usage updates", async () => {
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
    await updateRegistry(entry);
    await updateRegistry(
      containerEntry({
        backendId: "podman",
        lastUsedAtMs: 2,
        workspaceDir: "/later/workspace",
      }),
    );

    await expectEntry("container-a", { ...entry, lastUsedAtMs: 2 });
  });

  it("settles runtime registry writes in the worker and retains pending completion rules", async () => {
    const entry = containerEntry({
      backendId: "docker",
      runtimeState: "pending",
      workspaceDir: "/original/workspace",
    });
    await updateRegistry(entry);
    forbidHostSql();
    await updateRegistry({ ...entry, lastUsedAtMs: 2, createdAtMs: 99, image: "ignored-update" });
    await completeReservation({ ...entry, lastUsedAtMs: 3, image: "initialized-image" });
    await completeReservation({ ...entry, lastUsedAtMs: 4, image: "ignored-ready" });
    await expectEntry(entry.containerName, {
      runtimeState: "ready",
      createdAtMs: 1,
      lastUsedAtMs: 4,
      image: "initialized-image",
      workspaceDir: "/original/workspace",
    });
    await completeReservation(entry, true);
    await expectAbsent(entry.containerName);
    await updateRegistry({ ...entry, containerName: "direct-remove" });
    await removeRegistryEntry("direct-remove", { preserveRemovalIntent: true });
    await expectAbsent("direct-remove");
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
        await expect(completeReservation(entry, retired)).rejects.toThrow(
          "Sandbox runtime was removed or is being removed",
        );
      }
      await expect(readRegistryEntry(entry.containerName)).resolves.toEqual(before);
      await removeRegistryEntry(entry.containerName, { preserveRemovalIntent: true });
      await expect(readRegistryEntry(entry.containerName)).resolves.toEqual(before);
      await removeRegistryEntry(entry.containerName);
      await expectAbsent(entry.containerName);
    }
  });

  it("refuses completion and retirement of a replaced reservation in the worker", async () => {
    const original = await reserveEntry(
      containerEntry({ backendId: "generation-boundary", workspaceDir: "/original/workspace" }),
    );
    await removeRegistryEntry(original.containerName);
    const replacement = await reserveEntry({
      ...original,
      createdAtMs: original.createdAtMs + 1,
      workspaceDir: "/replacement/workspace",
    });
    const calls = observeMainThreadSql();
    calls.calibrate();
    expect(() => assertCurrent(original)).toThrow("generation changed");
    expect(() => assertCurrent(replacement)).not.toThrow();
    expect(() => assertCurrent({ ...replacement })).not.toThrow();
    await updateRegistry({ ...replacement, lastUsedAtMs: 999 });
    expect(() => assertCurrent(replacement)).not.toThrow();
    for (const retired of [false, true]) {
      await expect(completeReservation(original, retired)).rejects.toThrow(
        "Sandbox runtime generation changed",
      );
    }
    await expectEntry(original.containerName, { ...replacement, lastUsedAtMs: 999 });
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
      readRegisteredSandboxRuntimeIds({ backendId: "openshell", scopeKey: "agent:main" }),
    ).resolves.toEqual(["openshell-newer", "openshell-older"]);
  });

  it("stores unsafe container names without writing path-derived files", async () => {
    await updateRegistry(containerEntry({ containerName: "../escape" }));

    const registry = await readRegistry();

    expect(registry.entries.map((entry) => entry.containerName)).toEqual(["../escape"]);
    await expect(fs.access(`${fixture.root}/escape.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
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
      await expectEntry("browser-x", { containerName: "browser-x" });
    },
  );
});

const readerContainer = containerEntry({ backendId: "fixture", lastUsedAtMs: 2 });
const readerBrowser = browserEntry({ createdAtMs: 3, lastUsedAtMs: 4 });
const listedContainer = {
  ...readerContainer,
  runtimeLabel: readerContainer.containerName,
  configLabelKind: "Image",
};
const readIds = (scopeKey = "agent:main") =>
  readRegisteredSandboxRuntimeIds({ backendId: "fixture", scopeKey });
const unrelatedRows = Array.from({ length: 512 }, (_, index) => ({
  plugin_id: "fixture",
  namespace: "unrelated",
  entry_key: String(index),
  value_json: JSON.stringify({ text: "x".repeat(16 * 1024) }),
  created_at: 1,
  expires_at: null,
}));

async function seed() {
  await updateRegistry(readerContainer);
  await updateBrowserRegistry(readerBrowser);
}

it.each(["cached", "fresh"])(
  "reads all four sandbox projections off the parent thread with a %s source and unrelated data",
  async (mode) => {
    expect(isMainThread).toBe(true);
    await seed();
    runOpenClawStateWriteTransaction(({ db }) =>
      execute(db, query<DB>(db).insertInto("plugin_state_entries").values(unrelatedRows)),
    );
    if (mode === "fresh") {
      await closeOpenClawStateDatabaseAsync();
    }
    requireNodeSqlite();
    const calls = observeMainThreadSql();
    expect(await readRegistry()).toEqual({ entries: [listedContainer] });
    expect(await readRegistryEntry(readerContainer.containerName)).toMatchObject(readerContainer);
    expect(await readIds()).toEqual([readerContainer.containerName]);
    expect(await readBrowserRegistry()).toEqual({ entries: [readerBrowser] });
    expect(calls.count()).toBe(0);
  },
);

it("lists persisted sandbox runtime state through the actual CLI without parent SQLite", async () => {
  await seed();
  setRuntimeConfigSnapshot({});
  const restore = registerSandboxBackend("fixture", {
    factory: async () => {
      throw new Error("Listing must not provision a runtime");
    },
    manager: {
      describeRuntime: async () => ({ running: true, configLabelMatch: true }),
      removeRuntime: async () => {
        throw new Error("Listing must not remove a runtime");
      },
    },
  });
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  requireNodeSqlite();
  const calls = observeMainThreadSql();
  try {
    await sandboxListCommand({ browser: false, json: true }, runtime);
    expect(JSON.parse(runtime.log.mock.calls[0]?.[0])).toEqual({
      containers: [{ ...listedContainer, running: true, imageMatch: true }],
      browsers: [],
    });
    expect(calls.count()).toBe(0);
  } finally {
    restore();
  }
});

it.each(["absent", "malformed"])("reads %s registry state without mutating it", async (mode) => {
  const databasePath = path.join(fixture.root, "state", "openclaw.sqlite");
  if (mode === "malformed") {
    await seed();
    const { db } = openOpenClawStateDatabase();
    execute(
      db,
      query<DB>(db)
        .updateTable("sandbox_registry_entries")
        .set({ entry_json: "not-json" })
        .where("container_name", "=", readerContainer.containerName),
    );
  }
  expect(await readRegistry()).toEqual({ entries: [] });
  expect(await readRegistryEntry(readerContainer.containerName)).toBeNull();
  expect(await readIds(mode === "absent" ? "missing" : "agent:main")).toEqual([]);
  expect(await readBrowserRegistry()).toEqual({
    entries: mode === "absent" ? [] : [readerBrowser],
  });
  if (mode === "absent") {
    await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    const { db } = openOpenClawStateDatabase();
    const row = query<DB>(db)
      .selectFrom("sandbox_registry_entries")
      .select("entry_json")
      .where("container_name", "=", readerContainer.containerName);
    expect(execute(db, row).rows).toEqual([{ entry_json: "not-json" }]);
  }
});
