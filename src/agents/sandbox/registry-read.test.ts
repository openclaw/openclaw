import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { sandboxListCommand } from "../../commands/sandbox.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  executeSqliteQuerySync as execute,
  getNodeSqliteKysely as query,
} from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
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
const listedContainer = {
  ...container,
  runtimeLabel: container.containerName,
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
  const paths = fixture();
  await updateRegistry(container);
  await updateBrowserRegistry(browser);
  return paths;
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
    expect(await readRegistryEntry(container.containerName)).toMatchObject(container);
    expect(await readIds()).toEqual([container.containerName]);
    expect(await readBrowserRegistry()).toEqual({ entries: [browser] });
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
  const { databasePath } = mode === "absent" ? fixture() : await seed();
  if (mode === "malformed") {
    const { db } = openOpenClawStateDatabase();
    execute(
      db,
      query<DB>(db)
        .updateTable("sandbox_registry_entries")
        .set({ entry_json: "not-json" })
        .where("container_name", "=", container.containerName),
    );
  }
  expect(await readRegistry()).toEqual({ entries: [] });
  expect(await readRegistryEntry(container.containerName)).toBeNull();
  expect(await readIds(mode === "absent" ? "missing" : "agent:main")).toEqual([]);
  expect(await readBrowserRegistry()).toEqual({ entries: mode === "absent" ? [] : [browser] });
  if (mode === "absent") {
    expect(fs.existsSync(databasePath)).toBe(false);
  } else {
    const { db } = openOpenClawStateDatabase();
    const row = query<DB>(db)
      .selectFrom("sandbox_registry_entries")
      .select("entry_json")
      .where("container_name", "=", container.containerName);
    expect(execute(db, row).rows).toEqual([{ entry_json: "not-json" }]);
  }
});
