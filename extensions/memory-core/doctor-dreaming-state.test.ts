import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { createDoctorContext, resetDoctorPluginState } from "./doctor-contract-api.test-support.js";
import {
  readDailyIngestionState,
  readSessionIngestionState,
  writeDailyIngestionState,
} from "./src/dreaming-ingestion-state.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  configureMemoryCoreDreamingState,
  writeMemoryCoreWorkspaceEntry,
} from "./src/dreaming-state.js";
import {
  readPhaseSignalStore,
  readStore as readRecallStore,
} from "./src/short-term-promotion-store.js";
import { resetMemoryCoreDreamingStateForTests } from "./src/test-helpers.js";

function dreamingStateMigration() {
  const migration = stateMigrations.find(
    (entry) => entry.id === "memory-core-dreams-json-to-sqlite",
  );
  if (!migration) {
    throw new Error("Missing dreaming state migration");
  }
  return migration;
}

describe("memory-core dreaming state migration boundary", () => {
  let rootDir = "";
  let workspaceDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    await resetDoctorPluginState();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-core-dreaming-"));
    workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(rootDir, "state") };
  });

  afterEach(async () => {
    await resetDoctorPluginState();
    resetMemoryCoreDreamingStateForTests();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function context() {
    return createDoctorContext(env);
  }

  function migrationParams() {
    return {
      config: { agents: { list: [{ id: "main", workspace: workspaceDir }] } },
      env,
      stateDir: path.join(rootDir, "state"),
      oauthDir: path.join(rootDir, "oauth"),
      context: context(),
    };
  }

  async function writeRetiredDreamingFiles(contents: string) {
    const paths = [
      "daily-ingestion.json",
      "session-ingestion.json",
      "short-term-recall.json",
      "phase-signals.json",
    ].map((name) => path.join(workspaceDir, "memory", ".dreams", name));
    await Promise.all(paths.map((filePath) => fs.writeFile(filePath, contents)));
    return paths;
  }

  async function expectRetiredDreamingFilesUnchanged(paths: string[], contents: string) {
    for (const filePath of paths) {
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(contents);
      await expect(fs.access(`${filePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }

  it("refuses pre-July dreaming JSON without importing or archiving it", async () => {
    const contents = '{"version":1,"files":{},"seenMessages":{},"entries":{}}\n';
    const paths = await writeRetiredDreamingFiles(contents);
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    await writeMemoryCoreWorkspaceEntry({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir: path.join(rootDir, "another-workspace"),
      key: "memory/2026-07-01.md",
      value: { mtimeMs: 1, size: 42 },
    });
    const migration = dreamingStateMigration();
    const result = await migration.migrateLegacyState(migrationParams());
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual(
      paths.map((filePath) => expect.stringContaining(`no longer migrated (${filePath})`)),
    );
    expect(result).not.toHaveProperty("warningDisposition");
    await expect(migration.detectLegacyState(migrationParams())).resolves.toEqual({
      preview: result.warnings.map((warning) => `- ${warning}`),
    });
    await expectRetiredDreamingFilesUnchanged(paths, contents);
    expect(await readDailyIngestionState(workspaceDir)).toEqual({ version: 1, files: {} });
    expect(await readSessionIngestionState(workspaceDir)).toEqual({
      version: 3,
      files: {},
      seenMessages: {},
    });
  });

  it("preserves July keyed dreaming state when retired JSON files remain", async () => {
    const paths = await writeRetiredDreamingFiles("{unread retired JSON");
    const timestamp = "2026-07-01T12:00:00.000Z";
    const memoryPath = "memory/2026-07-01.md";
    const memoryKey = `memory:${memoryPath}:1:1`;
    const sessionKey = "main/session.jsonl";
    const fixtures = [
      {
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        key: memoryPath,
        value: { mtimeMs: 1, size: 42 },
      },
      {
        namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        key: sessionKey,
        value: { mtimeMs: 2, size: 91, contentHash: "july-hash", lineCount: 3, lastContentLine: 3 },
      },
      {
        namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
        key: `${sessionKey}:0`,
        value: { scope: sessionKey, index: 0, hashes: ["seen-a", "seen-b"] },
      },
      {
        namespace: SHORT_TERM_RECALL_NAMESPACE,
        key: memoryKey,
        value: {
          key: memoryKey,
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
        },
      },
      {
        namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
        key: memoryKey,
        value: {
          key: memoryKey,
          lightHits: 1,
          remHits: 2,
          lastLightAt: timestamp,
          lastRemAt: timestamp,
        },
      },
    ];
    // Persist the v2026.7.1-beta.1 envelope independently of today's workspace writer.
    const normalizedWorkspace = path.resolve(workspaceDir).replace(/\\/g, "/");
    const workspaceKey = createHash("sha256")
      .update(
        process.platform === "win32" ? normalizedWorkspace.toLowerCase() : normalizedWorkspace,
      )
      .digest("hex");
    const stores = [];
    for (const fixture of fixtures) {
      const store = context().openPluginStateKeyedStore({
        namespace: fixture.namespace,
        maxEntries: 50_000,
      });
      await store.register(
        `${workspaceKey}:${createHash("sha256").update(fixture.key).digest("hex")}`,
        {
          version: 1,
          workspaceKey,
          workspaceDir: path.resolve(workspaceDir),
          key: fixture.key,
          value: fixture.value,
        },
      );
      stores.push(store);
    }
    const before = await Promise.all(stores.map((store) => store.entries()));
    const migration = dreamingStateMigration();
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(await Promise.all(stores.map((store) => store.entries()))).toEqual(before);
    await expectRetiredDreamingFilesUnchanged(paths, "{unread retired JSON");
    expect((await readDailyIngestionState(workspaceDir)).files[memoryPath]).toEqual({
      mtimeMs: 1,
      size: 42,
    });
    expect(await readSessionIngestionState(workspaceDir)).toEqual({
      version: 3,
      files: {
        [sessionKey]: {
          mtimeMs: 2,
          size: 91,
          contentHash: "july-hash",
          lineCount: 3,
          lastContentLine: 3,
        },
      },
      seenMessages: { [sessionKey]: ["seen-a", "seen-b"] },
    });
    expect((await readRecallStore(workspaceDir, timestamp)).entries[memoryKey]?.recallCount).toBe(
      1,
    );
    expect((await readPhaseSignalStore(workspaceDir, timestamp)).entries[memoryKey]?.remHits).toBe(
      2,
    );
    await writeDailyIngestionState(workspaceDir, {
      version: 1,
      files: { [memoryPath]: { mtimeMs: 3, size: 43 } },
    });
    expect((await readDailyIngestionState(workspaceDir)).files[memoryPath]).toEqual({
      mtimeMs: 3,
      size: 43,
    });
  });

  it("recognizes empty canonical stores only when their existing markers distinguish them", async () => {
    const paths = await writeRetiredDreamingFiles("{retained rollback bytes");
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    for (const key of ["recall", "phase"]) {
      await writeMemoryCoreWorkspaceEntry({
        namespace: SHORT_TERM_META_NAMESPACE,
        workspaceDir,
        key,
        value: { updatedAt: "2026-07-01T12:00:00.000Z" },
      });
    }
    const acknowledgementNamespace = "legacy-dreaming-source-acknowledgements";
    for (const label of ["daily ingestion", "session ingestion"]) {
      await writeMemoryCoreWorkspaceEntry({
        namespace: acknowledgementNamespace,
        workspaceDir,
        key: `legacy-source:${label}`,
        value: { sha256: "a".repeat(64) },
      });
    }
    const acknowledgements = context().openPluginStateKeyedStore({
      namespace: acknowledgementNamespace,
      maxEntries: 50_000,
    });
    const before = await acknowledgements.entries();
    const migration = dreamingStateMigration();
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(await acknowledgements.entries()).toEqual(before);
    await acknowledgements.clear();
    const ambiguous = await migration.migrateLegacyState(migrationParams());
    expect(ambiguous.changes).toEqual([]);
    expect(ambiguous.warnings).toEqual([
      expect.stringContaining("Memory Core daily ingestion"),
      expect.stringContaining("Memory Core session ingestion"),
    ]);
    expect(ambiguous.warnings[0]).toContain("an empty ingestion store cannot be distinguished");
    expect(await acknowledgements.entries()).toEqual([]);
    await expectRetiredDreamingFilesUnchanged(paths, "{retained rollback bytes");
  });
});
