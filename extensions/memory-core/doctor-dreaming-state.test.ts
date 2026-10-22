import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { createDoctorContext, resetDoctorPluginState } from "./doctor-contract-api.test-support.js";
import {
  readDailyIngestionState,
  readSessionIngestionState,
  writeDailyIngestionState,
} from "./src/dreaming-ingestion-state.js";
import * as state from "./src/dreaming-state.js";
import {
  readPhaseSignalStore,
  readStore as readRecallStore,
} from "./src/short-term-promotion-store.js";
import { resetMemoryCoreDreamingStateForTests } from "./src/test-helpers.js";

const migration = stateMigrations.find((entry) => entry.id === "memory-core-dreams-json-to-sqlite");
if (!migration) {
  throw new Error("Missing dreaming state migration");
}

let rootDir = "";
let workspaceDir = "";
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  await resetDoctorPluginState();
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-core-dreaming-"));
  workspaceDir = path.join(rootDir, "workspace");
  await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
  env = { ...process.env, OPENCLAW_STATE_DIR: path.join(rootDir, "state") };
  state.configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
});

afterEach(async () => {
  await resetDoctorPluginState();
  resetMemoryCoreDreamingStateForTests();
  await fs.rm(rootDir, { recursive: true, force: true });
});

const context = () => createDoctorContext(env);
const openStore = (namespace: string) =>
  context().openPluginStateKeyedStore({ namespace, maxEntries: 50_000 });

const migrationParams = () => ({
  config: { agents: { entries: { main: { workspace: workspaceDir } } } },
  env,
  stateDir: path.join(rootDir, "state"),
  oauthDir: path.join(rootDir, "oauth"),
  context: context(),
});
const detect = () => migration.detectLegacyState(migrationParams());
const migrate = () => migration.migrateLegacyState(migrationParams());
const put = (namespace: string, key: string, value: object, workspace = workspaceDir) =>
  state.writeMemoryCoreWorkspaceEntry({ namespace, key, value, workspaceDir: workspace });

async function writeRetiredDreamingFiles(contents: string) {
  const paths = [
    "daily-ingestion.json",
    "session-ingestion.json",
    "short-term-recall.json",
    "phase-signals.json",
  ].map((name) => path.join(workspaceDir, "memory", ".dreams", name));
  await Promise.all(paths.map((filePath) => fs.writeFile(filePath, contents)));
  return {
    paths,
    async expectUnchanged() {
      for (const filePath of paths) {
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe(contents);
        await expect(fs.access(`${filePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  };
}

async function expectNoMigration() {
  await expect(detect()).resolves.toBeNull();
  await expect(migrate()).resolves.toEqual({
    changes: [],
    warnings: [],
  });
}

it("refuses pre-July dreaming JSON without importing or archiving it", async () => {
  const retired = await writeRetiredDreamingFiles('{"version":1}\n');
  await put(
    state.DREAMING_DAILY_INGESTION_NAMESPACE,
    "memory/2026-07-01.md",
    { mtimeMs: 1, size: 42 },
    path.join(rootDir, "another-workspace"),
  );
  const result = await migrate();
  expect(result).toEqual({
    changes: [],
    warnings: retired.paths.map((filePath) =>
      expect.stringContaining(`no longer migrated (${filePath})`),
    ),
  });
  await expect(detect()).resolves.toEqual({
    preview: result.warnings.map((warning) => `- ${warning}`),
  });
  await retired.expectUnchanged();
  expect(await readDailyIngestionState(workspaceDir)).toEqual({ version: 1, files: {} });
  expect(await readSessionIngestionState(workspaceDir)).toEqual({
    version: 3,
    files: {},
    seenMessages: {},
  });
});

it("preserves July keyed dreaming state when retired JSON files remain", async () => {
  const retired = await writeRetiredDreamingFiles("{unread retired JSON");
  const timestamp = "2026-07-01T12:00:00.000Z";
  const memoryPath = "memory/2026-07-01.md";
  const key = `memory:${memoryPath}:1:1`;
  const sessionKey = "main/session.jsonl";
  const daily = { mtimeMs: 1, size: 42 };
  const session = {
    mtimeMs: 2,
    size: 91,
    contentHash: "july-hash",
    lineCount: 3,
    lastContentLine: 3,
  };
  const recall = {
    key,
    path: memoryPath,
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: "Move backups to S3 Glacier.",
    recallCount: 1,
    totalScore: 0.9,
    maxScore: 0.9,
    queryHashes: ["hash-a"],
    firstRecalledAt: timestamp,
    lastRecalledAt: timestamp,
  };
  const phase = { key, lightHits: 1, remHits: 2, lastLightAt: timestamp, lastRemAt: timestamp };
  const fixtures = [
    [state.DREAMING_DAILY_INGESTION_NAMESPACE, memoryPath, daily],
    [state.DREAMING_SESSION_INGESTION_FILES_NAMESPACE, sessionKey, session],
    [
      state.DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      `${sessionKey}:0`,
      { scope: sessionKey, index: 0, hashes: ["seen-a", "seen-b"] },
    ],
    [state.SHORT_TERM_RECALL_NAMESPACE, key, recall],
    [state.SHORT_TERM_PHASE_SIGNAL_NAMESPACE, key, phase],
  ] satisfies Array<[string, string, object]>;
  // Persist the v2026.7.1-beta.1 envelope independently of today's workspace writer.
  const normalizedWorkspace = path.resolve(workspaceDir).replace(/\\/g, "/");
  const workspaceKey = createHash("sha256")
    .update(process.platform === "win32" ? normalizedWorkspace.toLowerCase() : normalizedWorkspace)
    .digest("hex");
  const stores = [];
  for (const [namespace, id, value] of fixtures) {
    const store = openStore(namespace);
    await store.register(`${workspaceKey}:${createHash("sha256").update(id).digest("hex")}`, {
      version: 1,
      workspaceKey,
      workspaceDir: path.resolve(workspaceDir),
      key: id,
      value,
    });
    stores.push(store);
  }
  const before = await Promise.all(stores.map((store) => store.entries()));
  await expectNoMigration();
  expect(await Promise.all(stores.map((store) => store.entries()))).toEqual(before);
  await retired.expectUnchanged();
  expect((await readDailyIngestionState(workspaceDir)).files[memoryPath]).toEqual(daily);
  expect(await readSessionIngestionState(workspaceDir)).toEqual({
    version: 3,
    files: { [sessionKey]: session },
    seenMessages: { [sessionKey]: ["seen-a", "seen-b"] },
  });
  const { entries: recalls } = await readRecallStore(workspaceDir, timestamp);
  const { entries: phases } = await readPhaseSignalStore(workspaceDir, timestamp);
  expect(recalls[key]).toMatchObject(recall);
  expect(phases[key]).toMatchObject(phase);
  const updated = { mtimeMs: 3, size: 43 };
  await writeDailyIngestionState(workspaceDir, {
    version: 1,
    files: { [memoryPath]: updated },
  });
  expect((await readDailyIngestionState(workspaceDir)).files[memoryPath]).toEqual(updated);
});

it("recognizes empty canonical stores only when their existing markers distinguish them", async () => {
  const retired = await writeRetiredDreamingFiles("{retained rollback bytes");
  for (const key of ["recall", "phase"]) {
    await put(state.SHORT_TERM_META_NAMESPACE, key, { updatedAt: "2026-07-01T12:00:00.000Z" });
  }
  const acknowledgementNamespace = "legacy-dreaming-source-acknowledgements";
  for (const label of ["daily ingestion", "session ingestion"]) {
    await put(acknowledgementNamespace, `legacy-source:${label}`, { sha256: "a".repeat(64) });
  }
  const acknowledgements = openStore(acknowledgementNamespace);
  const before = await acknowledgements.entries();
  await expectNoMigration();
  expect(await acknowledgements.entries()).toEqual(before);
  await acknowledgements.clear();
  const ambiguous = await migrate();
  expect(ambiguous).toEqual({
    changes: [],
    warnings: [
      expect.stringContaining("Memory Core daily ingestion"),
      expect.stringContaining("Memory Core session ingestion"),
    ],
  });
  expect(ambiguous.warnings[0]).toContain("an empty ingestion store cannot be distinguished");
  expect(await acknowledgements.entries()).toEqual([]);
  await retired.expectUnchanged();
});
