import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { sandboxListCommand } from "../../commands/sandbox.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  withArtifactPreservingStateReads,
  withDisposableOpenClawStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../../state/openclaw-state-db-readonly.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { registerSandboxBackend } from "./backend.js";
import {
  readBrowserRegistry,
  readRegisteredSandboxRuntimeIds,
  readRegistry,
  readRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "./registry.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

function fixture() {
  const root = tempDirs.make("openclaw-sandbox-reader-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  return { root, databasePath: path.join(root, "state", "openclaw.sqlite") };
}

const container = {
  containerName: "fixture-container",
  backendId: "fixture",
  sessionKey: "agent:main",
  createdAtMs: 1,
  lastUsedAtMs: 2,
  image: "fixture:image",
};
const browser = {
  containerName: "fixture-browser",
  sessionKey: "agent:main",
  createdAtMs: 3,
  lastUsedAtMs: 4,
  image: "fixture:browser",
  cdpPort: 9222,
};

async function seed() {
  await updateRegistry(container);
  await updateBrowserRegistry(browser);
}

function watchNativeSql() {
  const { DatabaseSync, StatementSync } = requireNodeSqlite();
  return [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
}

it.each([
  { mode: "cached", otherRows: 0 },
  { mode: "fresh", otherRows: 0 },
  { mode: "cached", otherRows: 512 },
  { mode: "fresh", otherRows: 512 },
] as const)(
  "reads all four sandbox projections off the parent thread with a $mode source and $otherRows unrelated rows",
  async ({ mode, otherRows }) => {
    expect(isMainThread).toBe(true);
    const { databasePath } = fixture();
    await seed();
    if (otherRows) {
      // A shared state database can be much larger than its sandbox registry.
      runOpenClawStateWriteTransaction(({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .insertInto("plugin_state_entries")
            .values(
              Array.from({ length: otherRows }, (_, index) => ({
                plugin_id: "fixture",
                namespace: "unrelated",
                entry_key: String(index),
                value_json: JSON.stringify({ text: "x".repeat(16 * 1024) }),
                created_at: 1,
                expires_at: null,
              })),
            ),
        );
      });
    }
    const sourceBytes = ["", "-wal"].reduce(
      (total, suffix) =>
        total +
        (fs.existsSync(databasePath + suffix) ? fs.statSync(databasePath + suffix).size : 0),
      0,
    );
    if (mode === "fresh") {
      await closeOpenClawStateDatabaseAsync();
    }
    const calls = watchNativeSql();
    const startedAt = performance.now();
    expect(await readRegistry()).toEqual({
      entries: [{ ...container, runtimeLabel: container.containerName, configLabelKind: "Image" }],
    });
    expect(await readRegistryEntry(container.containerName)).toMatchObject(container);
    expect(
      await readRegisteredSandboxRuntimeIds({ backendId: "fixture", scopeKey: "agent:main" }),
    ).toEqual([container.containerName]);
    expect(await readBrowserRegistry()).toEqual({ entries: [browser] });
    const mainThreadSqlCalls = calls.reduce((total, call) => total + call.mock.calls.length, 0);
    console.info("sandbox registry read", {
      mode,
      otherRows,
      sourceBytes,
      mainThreadSqlCalls,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    expect(mainThreadSqlCalls).toBe(0);
  },
);

it("lists persisted sandbox runtime state through the actual CLI without parent SQLite", async () => {
  fixture();
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
  const calls = watchNativeSql();
  try {
    await sandboxListCommand({ browser: false, json: true }, runtime);
    expect(JSON.parse(runtime.log.mock.calls[0]?.[0])).toEqual({
      containers: [
        {
          ...container,
          runtimeLabel: container.containerName,
          configLabelKind: "Image",
          running: true,
          imageMatch: true,
        },
      ],
      browsers: [],
    });
    const mainThreadSqlCalls = calls.reduce((total, call) => total + call.mock.calls.length, 0);
    console.info("sandbox CLI listing", { mainThreadSqlCalls });
    expect(mainThreadSqlCalls).toBe(0);
  } finally {
    restore();
  }
});

it("keeps all absent registry reads noncreating", async () => {
  const { databasePath } = fixture();
  expect(await readRegistry()).toEqual({ entries: [] });
  expect(await readRegistryEntry("missing")).toBeNull();
  expect(
    await readRegisteredSandboxRuntimeIds({ backendId: "fixture", scopeKey: "missing" }),
  ).toEqual([]);
  expect(await readBrowserRegistry()).toEqual({ entries: [] });
  expect(fs.existsSync(databasePath)).toBe(false);
});

it("reads inherited snapshot bytes while the canonical registry changes", async () => {
  fixture();
  await seed();
  await withOpenClawStateDatabaseReadSnapshot(async () => {
    await updateRegistry({ ...container, lastUsedAtMs: 99 });
    expect(await readRegistryEntry(container.containerName)).toMatchObject({ lastUsedAtMs: 2 });
    expect((await readRegistry()).entries).toEqual([
      expect.objectContaining({ containerName: container.containerName, lastUsedAtMs: 2 }),
    ]);
  });
  expect(await readRegistryEntry(container.containerName)).toMatchObject({ lastUsedAtMs: 99 });
});

it("joins admitted sandbox reads before the disposable source scope exits", async () => {
  const { databasePath } = fixture();
  await seed();
  let outcome: unknown;
  await withDisposableOpenClawStateReads(databasePath, async () => {
    void readRegistryEntry(container.containerName).then(
      (entry) => {
        outcome = entry;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
  });
  expect(outcome).toMatchObject(container);
});

it("preserves a cold artifact-protected source without creating sidecars", async () => {
  const { databasePath } = fixture();
  await seed();
  await closeOpenClawStateDatabaseAsync();
  const before = fs.readFileSync(databasePath);
  const artifacts = () => fs.readdirSync(path.dirname(databasePath)).toSorted();
  const names = artifacts();
  await withArtifactPreservingStateReads(async () => {
    expect(await readRegistryEntry(container.containerName)).toMatchObject(container);
    expect(await readBrowserRegistry()).toEqual({ entries: [browser] });
  });
  expect(fs.readFileSync(databasePath)).toEqual(before);
  expect(artifacts()).toEqual(names);
});

it("keeps the selected source when the ambient state directory changes before settlement", async () => {
  fixture();
  await seed();
  const selected = readRegistryEntry(container.containerName);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-sandbox-unrelated-"));
  expect(await selected).toMatchObject(container);
  expect(await readRegistry()).toEqual({ entries: [] });
});

it("ignores malformed registry payloads without rewriting them", async () => {
  fixture();
  await seed();
  const { db } = openOpenClawStateDatabase();
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .updateTable("sandbox_registry_entries")
      .set({ entry_json: "not-json" })
      .where("container_name", "=", container.containerName),
  );
  expect(await readRegistryEntry(container.containerName)).toBeNull();
  expect(await readRegistry()).toEqual({ entries: [] });
  expect(
    await readRegisteredSandboxRuntimeIds({ backendId: "fixture", scopeKey: "agent:main" }),
  ).toEqual([]);
  expect(await readBrowserRegistry()).toEqual({ entries: [browser] });
  expect(
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("sandbox_registry_entries")
        .select("entry_json")
        .where("container_name", "=", container.containerName),
    ).rows,
  ).toEqual([{ entry_json: "not-json" }]);
});
