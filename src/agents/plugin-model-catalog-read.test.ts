import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_WORKER_TRANSFER_FRAME_BYTES } from "../infra/sqlite-worker-transfer.js";
import * as workerCpu from "../infra/worker-cpu.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { createCurrentOpenClawAgentDatabaseFixtures } from "../state/openclaw-agent-db.test-support.js";
import { clearOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { seedOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { loadPersistedPluginModelCatalogs } from "./plugin-model-catalog-execution.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    await drainGlobalSingletonLifecycleState();
    vi.restoreAllMocks();
    cleanup();
  }),
);

function catalogContents(name: string): string {
  return JSON.stringify({
    generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
    providers: {
      fixture: {
        api: "openai-completions",
        models: [{ id: "fixture-model", name }],
      },
    },
  });
}

function createFixture(contents: string) {
  const root = tempDirs.make("openclaw-plugin-catalog-read-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const agentDir = path.join(root, "agents", "main", "agent");
  const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
  createCurrentOpenClawAgentDatabaseFixtures(path.join(root, "template.sqlite"), [
    { path: databasePath, agentId: "main" },
  ]);
  using database = openNodeSqliteDatabase(databasePath);
  database
    .prepare("INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
    .run("plugin-model-catalog-v1", "fixture", contents, 1);
  return {
    root,
    env,
    agentDir,
    databasePath,
    read: () => loadPersistedPluginModelCatalogs(agentDir, ["fixture"], env),
  };
}

function observeCatalogWorkers(onMessage?: (message: unknown) => void) {
  const workers: Worker[] = [];
  const frames: number[] = [];
  const createWorker = workerCpu.createCpuTrackedWorker;
  vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((url, options) => {
    const worker = createWorker(url, options);
    const data: unknown = options?.workerData;
    if (isRecord(data) && data.pluginCatalogRead === true) {
      workers.push(worker);
      worker.on("message", (message: unknown) => {
        if (
          isRecord(message) &&
          message.status === "request" &&
          isRecord(message.value) &&
          Array.isArray(message.value.frames)
        ) {
          for (const frame of message.value.frames) {
            if (isRecord(frame) && frame.bytes instanceof Uint8Array) {
              frames.push(frame.bytes.byteLength);
            }
          }
        }
        onMessage?.(message);
      });
    }
    return worker;
  });
  return { workers, frames };
}

it("reads without creating shared state and observes canonical replacements on the same worker", async () => {
  const first = catalogContents("first");
  const fixture = createFixture(first);
  const observation = observeCatalogWorkers();
  const missingDir = path.join(fixture.root, "agents", "missing", "agent");
  await expect(
    loadPersistedPluginModelCatalogs(missingDir, undefined, fixture.env),
  ).resolves.toEqual([]);
  expect(fs.existsSync(missingDir)).toBe(false);
  expect(observation.workers).toHaveLength(0);

  const sql = observeHostDataSql();
  try {
    await expect(fixture.read()).resolves.toEqual([{ pluginId: "fixture", contents: first }]);
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
  expect(fs.existsSync(resolveOpenClawStateSqlitePath(fixture.env))).toBe(false);
  expect(observation.workers).toHaveLength(1);
  const reader = observation.workers[0];

  const second = catalogContents("second");
  await replacePersistedPluginModelCatalogs({
    agentDir: fixture.agentDir,
    env: fixture.env,
    pluginCatalogWrites: { [encodePluginModelCatalogRelativePath("fixture")]: second },
  });
  await expect(fixture.read()).resolves.toEqual([{ pluginId: "fixture", contents: second }]);
  expect(observation.workers).toEqual([reader]);
});

it("rejects quarantine and tracked schema damage after warm reads, then accepts cleared quarantine", async () => {
  const contents = catalogContents("quarantine fixture");
  const fixture = createFixture(contents);
  await expect(fixture.read()).resolves.toEqual([{ pluginId: "fixture", contents }]);
  seedOpenClawDatabaseQuarantine({
    env: fixture.env,
    path: fixture.databasePath,
    kind: "agent",
    reason: "synthetic verified damage",
  });
  await expect(fixture.read()).rejects.toThrow(/quarantined.*synthetic verified damage/);

  expect(clearOpenClawDatabaseQuarantine(fixture.databasePath, { env: fixture.env })).toBe(true);
  await expect(fixture.read()).resolves.toEqual([{ pluginId: "fixture", contents }]);
  {
    using database = openNodeSqliteDatabase(fixture.databasePath);
    database.exec(
      "ALTER TABLE session_canonical_validation_pending RENAME TO displaced_validation_pending",
    );
  }
  await expect(fixture.read()).rejects.toThrow(
    /Session metadata unavailable \(table-missing: session_canonical_validation_pending\)/,
  );
});

it("bounds large catalog transfers and refuses a replaced source before exposing its result", async () => {
  const contents = catalogContents(`${"catalog".repeat(1_300_000)}🌊`);
  const fixture = createFixture(contents);
  let replaceBeforeDelivery = false;
  const replacementPath = path.join(fixture.root, "replacement.sqlite");
  const observation = observeCatalogWorkers((message) => {
    if (replaceBeforeDelivery && isRecord(message) && message.status === "ok") {
      replaceBeforeDelivery = false;
      fs.renameSync(fixture.databasePath, `${fixture.databasePath}.retired`);
      fs.renameSync(replacementPath, fixture.databasePath);
    }
  });
  await expect(fixture.read()).resolves.toEqual([{ pluginId: "fixture", contents }]);
  expect(observation.frames.length).toBeGreaterThan(1);
  expect(
    observation.frames.every((bytes) => bytes > 0 && bytes <= SQLITE_WORKER_TRANSFER_FRAME_BYTES),
  ).toBe(true);
  expect(observation.frames.reduce((total, bytes) => total + bytes, 0)).toBeGreaterThan(
    SQLITE_WORKER_TRANSFER_FRAME_BYTES,
  );

  fs.copyFileSync(fixture.databasePath, replacementPath);
  replaceBeforeDelivery = true;
  await expect(fixture.read()).rejects.toThrow("identity changed");
  expect(replaceBeforeDelivery).toBe(false);
});
