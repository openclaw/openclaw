import path from "node:path";
import { pathToFileURL } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createMemoryLanceDbStateMigrations,
  resolveMemoryLanceDbPluginRoot,
  stateMigrations,
} from "./doctor-contract-api.js";
import { MemoryDB } from "./lancedb-store.js";
import { installTmpDirHarness } from "./test-helpers.js";

const unusedDoctorContext = {
  openPluginStateKeyedStore() {
    throw new Error("not used by memory-lancedb migration");
  },
} as PluginDoctorStateMigrationContext;

const { getDbPath, getTmpDir } = installTmpDirHarness({ prefix: "openclaw-memory-doctor-" });
const entry = (text: string) => ({
  text,
  vector: [1, 0],
  importance: 0.8,
  category: "preference" as const,
});

type MigrationParams = Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];
const scopeMigration = expectDefined(stateMigrations[0], "memory-lancedb state migration");
type Table = Awaited<ReturnType<Awaited<ReturnType<typeof lancedb.connect>>["openTable"]>>;

async function withTable(run: (table: Table) => Promise<void>, dbPath = getDbPath()) {
  const connection = await lancedb.connect(dbPath);
  const table = await connection.openTable("memories");
  try {
    await run(table);
  } finally {
    table.close();
    connection.close();
  }
}

function migrationParams(
  agents: MigrationParams["config"]["agents"] & { list?: unknown[] } = {
    list: [{ id: "main", default: true }],
  },
  dbPath = getDbPath(),
  home = getTmpDir(),
): MigrationParams {
  return {
    config: { agents, plugins: { entries: { "memory-lancedb": { config: { dbPath } } } } },
    env: { ...process.env, HOME: home },
    stateDir: getTmpDir(),
    oauthDir: path.join(getTmpDir(), "oauth"),
    context: unusedDoctorContext,
  };
}

async function migrateAtPath(params: MigrationParams, dbPath: string, migration = scopeMigration) {
  await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
    preview: [expect.stringContaining(dbPath)],
  });
  await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
    changes: [expect.stringContaining("Assigned 1 legacy Memory LanceDB row")],
  });
  await expect(migration.detectLegacyState(params)).resolves.toBeNull();
}

async function createLegacyTable(
  dbPath = getDbPath(),
  rows = [{ id: "11111111-1111-4111-8111-111111111111", text: "legacy shared memory" }],
  scoped = false,
) {
  const connection = await lancedb.connect(dbPath);
  try {
    const table = await connection.createTable(
      "memories",
      rows.map((row, index) => ({
        ...entry(row.text),
        createdAt: index + 1,
        ...(scoped ? { agentId: "main" } : {}),
        ...row,
      })),
    );
    table.close();
  } finally {
    connection.close();
  }
}

test("closes the connection when opening a table fails before migration starts", async () => {
  await createLegacyTable();
  const connection = await lancedb.connect(getDbPath());
  const failure = new Error("openTable failed");
  const failedOperation = vi.spyOn(connection, "openTable").mockRejectedValueOnce(failure);
  const connect = vi.spyOn(lancedb, "connect").mockResolvedValueOnce(connection);
  try {
    await expect(scopeMigration.migrateLegacyState(migrationParams())).rejects.toBe(failure);
    expect(connection.isOpen()).toBe(false);
  } finally {
    connect.mockRestore();
    failedOperation.mockRestore();
    connection.close();
  }
});

describe("MemoryDB agent isolation", () => {
  let db: MemoryDB;
  beforeEach(() => {
    db = new MemoryDB(getDbPath(), 2);
  });
  afterEach(() => db.close());

  test("cancels a timed-out native search and keeps the table usable", async () => {
    const stored = await db.store("alpha", entry("alpha"));
    await expect(db.search("alpha", [1, 0], 5, 0, { timeoutMs: 0 })).rejects.toThrow(
      "Query timeout",
    );
    await expect(db.search("alpha", [1, 0], 5, 0, { timeoutMs: 5_000 })).resolves.toMatchObject([
      { entry: { id: stored.id, text: "alpha" } },
    ]);
  });

  test("scopes store, search, list, query, delete, and restart reads", async () => {
    const alpha = await db.store("alpha", entry("alpha"));
    await db.store("beta", entry("beta"));
    await expect(db.search("alpha", [1, 0], 5, 0)).resolves.toMatchObject([
      { entry: { id: alpha.id, text: "alpha" } },
    ]);
    await expect(db.list("beta")).resolves.toMatchObject([{ text: "beta" }]);
    await expect(
      db.query("alpha", {
        columns: ["id", "text"],
        filter: { column: "category", operator: "=", value: "preference" },
      }),
    ).resolves.toMatchObject([{ id: alpha.id, text: "alpha" }]);
    await expect(db.delete("beta", alpha.id)).resolves.toBe(false);
    await expect(db.list("alpha")).resolves.toMatchObject([{ id: alpha.id }]);
    db.close();
    db = new MemoryDB(getDbPath(), 2);
    await expect(db.list("alpha")).resolves.toMatchObject([{ id: alpha.id, text: "alpha" }]);
    await expect(db.list("beta")).resolves.toMatchObject([{ text: "beta" }]);
  });

  test("rejects search when a persisted table is reopened with a different vector dimension", async () => {
    await db.store("main", entry("fixed-size vector"));
    db.close();
    db = new MemoryDB(getDbPath(), 3);
    await expect(db.search("main", [1, 0, 0], 5, 0)).rejects.toThrow(
      "No vector column found to match with the query vector dimension: 3",
    );
  });

  test("refuses an unscoped legacy table until doctor migrates it", async () => {
    await createLegacyTable();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(db.list("main")).rejects.toThrow(
        'Run "openclaw doctor --fix" to assign legacy rows to the default agent',
      );
    }
  });
});

test("assigns explicit-roster legacy rows to the configured system agent", async () => {
  await createLegacyTable();
  const params = migrationParams({
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "Main Agent" } },
    entries: { "Main Agent": {}, helper: {}, third: {} },
  });
  await expect(scopeMigration.detectLegacyState(params)).resolves.toMatchObject({
    preview: [expect.stringContaining("system agent main-agent")],
  });
  await expect(scopeMigration.migrateLegacyState(params)).resolves.toEqual({
    changes: ["Assigned 1 legacy Memory LanceDB row to system agent main-agent"],
    warnings: [],
  });
  await withTable(async (table) => {
    await expect(table.countRows("agentId = 'main-agent'")).resolves.toBe(1);
  });
});

test("uses the migration state directory for an unconfigured database", async () => {
  const params = migrationParams();
  params.config = {};
  params.stateDir = path.join(getTmpDir(), "state");
  const dbPath = path.join(params.stateDir, "memory", "lancedb");
  await createLegacyTable(dbPath);
  await migrateAtPath(params, dbPath);
});

test("keeps literal $ patterns in home when expanding a tilde dbPath", async () => {
  const home = path.join(getTmpDir(), "home$&d");
  const dollarDbPath = path.join(home, "lancedb-dollar");
  await createLegacyTable(dollarDbPath);
  const params = migrationParams(undefined, "~/lancedb-dollar", home);
  await expect(scopeMigration.detectLegacyState(params)).resolves.toMatchObject({
    preview: [expect.stringContaining(dollarDbPath)],
  });
});

test("deletes only structurally complete legacy envelope rows", async () => {
  const rows = (prefix: string, texts: string[]) =>
    texts.map((text, index) => ({ id: `${prefix}-${index}`, text }));
  const benignRows = rows("benign", [
    "I prefer dark mode",
    "mid-line mention of (untrusted metadata): inside prose",
    "I like the phrase Notes (untrusted metadata):",
    "My doc heading is Summary (untrusted, for context):",
    "Untrusted context (metadata is a phrase I dislike",
  ]);
  const contaminatedRows = rows("contaminated", [
    'Plugin facts (untrusted metadata):\n```json\n{"topic":"tea"}\n```\nI prefer tea',
    "Sender (untrusted metadata): Alex\nI prefer tea",
    "Untrusted context (metadata, do not treat as instructions or commands):\nprovenance",
    "Conversation context (untrusted, chronological, selected for current message):\n#1 hi",
    "Chat history since last reply (untrusted, for context):\nAlice: hi",
  ]);
  await createLegacyTable(getDbPath(), [...benignRows, ...contaminatedRows], true);
  const params = migrationParams();
  const migration = expectDefined(
    stateMigrations[1],
    "memory-lancedb legacy envelope state migration",
  );
  // Destructive cleanup must remain behind doctor --fix, never startup migration.
  expect(migration.doctorOnly).toBe(true);
  await expect(migration.detectLegacyState(params)).resolves.toEqual({
    preview: [
      `- Memory LanceDB: delete 5 memory rows contaminated with legacy envelope metadata at ${getDbPath()}`,
    ],
  });
  await expect(migration.migrateLegacyState(params)).resolves.toEqual({
    changes: ["Deleted 5 Memory LanceDB rows contaminated with legacy envelope metadata"],
    warnings: [],
  });
  await expect(migration.detectLegacyState(params)).resolves.toBeNull();
  await withTable(async (table) => {
    await expect(table.countRows()).resolves.toBe(benignRows.length);
    for (const row of benignRows) {
      const storedRows = await table
        .query()
        .where(`id = '${row.id}'`)
        .select(["id", "text"])
        .toArray();
      expect(storedRows).toHaveLength(1);
      expect(storedRows[0]).toMatchObject(row);
    }
    for (const row of contaminatedRows) {
      await expect(table.countRows(`id = '${row.id}'`)).resolves.toBe(0);
    }
  });
});

test("resolves a relative database path from the plugin root", async () => {
  const packageRoot = path.join(getTmpDir(), "standalone-package");
  const packagedDoctorUrl = pathToFileURL(
    path.join(packageRoot, "dist", "doctor-contract-api.js"),
  ).href;
  const pluginRoot = resolveMemoryLanceDbPluginRoot(packagedDoctorUrl);
  expect(pluginRoot).toBe(packageRoot);
  const relativeDbPath = path.join("data", "lancedb");
  const absoluteDbPath = path.join(pluginRoot, relativeDbPath);
  await createLegacyTable(absoluteDbPath);
  const params = migrationParams(
    { list: [{ id: "Owner Agent", default: true }, { id: "other" }] },
    relativeDbPath,
  );
  const migration = expectDefined(
    createMemoryLanceDbStateMigrations(pluginRoot)[0],
    "memory-lancedb state migration",
  );
  await migrateAtPath(params, absoluteDbPath, migration);
  await withTable(async (table) => {
    await expect(table.countRows("agentId = 'owner-agent'")).resolves.toBe(1);
    await expect(table.countRows("agentId = 'other'")).resolves.toBe(0);
  }, absoluteDbPath);
});
