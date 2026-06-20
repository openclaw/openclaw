// Memory Core tests cover doctor migration of legacy dreaming state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { testing as dreamingTesting } from "./src/dreaming-phases.js";
import {
  configureMemoryCoreDreamingState,
  DREAMING_DAILY_INGESTION_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  resetMemoryCoreDreamingStateForTests,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./src/dreaming-state.js";
import { testing as shortTermTesting } from "./src/short-term-promotion.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("memory-core", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("memory-core doctor dreaming migration", () => {
  let rootDir = "";
  let workspaceDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-core-doctor-"));
    workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(rootDir, "state") };
  });

  afterEach(async () => {
    resetMemoryCoreDreamingStateForTests();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function context(): PluginDoctorStateMigrationContext {
    return createDoctorContext(env);
  }

  function migrationParams(
    config: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: workspaceDir }],
      },
    },
  ) {
    return {
      config,
      env,
      stateDir: path.join(rootDir, "state"),
      oauthDir: path.join(rootDir, "oauth"),
      context: context(),
    };
  }

  function migrationById(id: string) {
    const migration = stateMigrations.find((entry) => entry.id === id);
    if (!migration) {
      throw new Error(`Missing migration ${id}`);
    }
    return migration;
  }

  it("imports persistent legacy dreaming state and ignores transient locks", async () => {
    const dreamsDir = path.join(workspaceDir, "memory", ".dreams");
    const dailyPath = path.join(dreamsDir, "daily-ingestion.json");
    const sessionPath = path.join(dreamsDir, "session-ingestion.json");
    const recallPath = path.join(dreamsDir, "short-term-recall.json");
    const phasePath = path.join(dreamsDir, "phase-signals.json");
    const lockPath = path.join(dreamsDir, "short-term-promotion.lock");

    await fs.writeFile(
      dailyPath,
      JSON.stringify({
        version: 1,
        files: {
          "memory/2026-04-05.md": {
            size: 42,
            mtimeMs: 1,
            contentHash: "daily-hash",
            ingestedAt: "2026-04-05T10:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        version: 1,
        files: {
          "main/session.jsonl": {
            size: 91,
            mtimeMs: 2,
            lineCount: 3,
            lastContentLine: 3,
            contentHash: "session-hash",
            ingestedAt: "2026-04-05T11:00:00.000Z",
          },
        },
        seenMessages: {
          "main/session.jsonl": ["seen-a", "seen-b"],
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      recallPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-05T12:00:00.000Z",
        entries: {
          "memory:memory/2026-04-05.md:1:1": {
            key: "memory:memory/2026-04-05.md:1:1",
            path: "memory/2026-04-05.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: "Move backups to S3 Glacier.",
            recallCount: 1,
            totalScore: 0.9,
            maxScore: 0.9,
            firstRecalledAt: "2026-04-05T12:00:00.000Z",
            lastRecalledAt: "2026-04-05T12:00:00.000Z",
            queryHashes: ["hash-a"],
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      phasePath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-05T13:00:00.000Z",
        entries: {
          "memory:memory/2026-04-05.md:1:1": {
            key: "memory:memory/2026-04-05.md:1:1",
            lightHits: 1,
            remHits: 2,
            lastLightAt: "2026-04-05T12:00:00.000Z",
            lastRemAt: "2026-04-05T13:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(lockPath, `${process.pid}:${Date.now()}\n`, "utf8");

    const migration = migrationById("memory-core-dreams-json-to-sqlite");
    const preview = await migration.detectLegacyState(migrationParams());
    expect(preview?.preview).toEqual([
      expect.stringContaining("Memory Core daily ingestion"),
      expect.stringContaining("Memory Core session ingestion"),
      expect.stringContaining("Memory Core short-term recall"),
      expect.stringContaining("Memory Core phase signals"),
    ]);
    expect(preview?.preview.join("\n")).not.toContain("short-term-promotion.lock");

    const result = await migration.migrateLegacyState(migrationParams());
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core daily ingestion -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core daily ingestion legacy source"),
      "Migrated Memory Core session ingestion -> SQLite plugin state (2 row(s))",
      expect.stringContaining("Archived Memory Core session ingestion legacy source"),
      "Migrated Memory Core short-term recall -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core short-term recall legacy source"),
      "Migrated Memory Core phase signals -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core phase signals legacy source"),
    ]);

    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    await expect(fs.access(`${dailyPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${sessionPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${recallPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${phasePath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(lockPath)).resolves.toBeUndefined();

    const daily = await dreamingTesting.readDailyIngestionState(workspaceDir, "main");
    expect(daily.files["memory/2026-04-05.md"]?.mtimeMs).toBe(1);
    const session = await dreamingTesting.readSessionIngestionState(workspaceDir, "main");
    expect(session.files["main/session.jsonl"]?.contentHash).toBe("session-hash");
    expect(session.seenMessages["main/session.jsonl"]).toEqual(["seen-a", "seen-b"]);
    const recall = await shortTermTesting.readRecallStore(
      workspaceDir,
      "2026-04-05T12:00:00.000Z",
      "main",
    );
    expect(recall.entries["memory:memory/2026-04-05.md:1:1"]?.conceptTags).toContain("glacier");
    const phase = await shortTermTesting.readPhaseSignalStore(
      workspaceDir,
      "2026-04-05T13:00:00.000Z",
      "main",
    );
    expect(phase.entries["memory:memory/2026-04-05.md:1:1"]?.remHits).toBe(2);
  });

  it("leaves invalid legacy JSON in place", async () => {
    const recallPath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.writeFile(recallPath, "{", "utf8");

    const result = await migrationById("memory-core-dreams-json-to-sqlite").migrateLegacyState(
      migrationParams(),
    );

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Skipped Memory Core short-term recall import"),
    ]);
    await expect(fs.access(recallPath)).resolves.toBeUndefined();
    await expect(fs.access(`${recallPath}.migrated`)).rejects.toThrow();
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    const recall = await shortTermTesting.readRecallStore(
      workspaceDir,
      new Date().toISOString(),
      "main",
    );
    expect(recall.entries).toEqual({});
  });

  it("uses migration env when resolving default workspaces", async () => {
    env = { ...env, OPENCLAW_WORKSPACE_DIR: workspaceDir };
    const recallPath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.writeFile(
      recallPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-05T12:00:00.000Z",
        entries: {
          "memory:memory/2026-04-05.md:1:1": {
            key: "memory:memory/2026-04-05.md:1:1",
            path: "memory/2026-04-05.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: "Move backups to S3 Glacier.",
            recallCount: 1,
            totalScore: 0.9,
            maxScore: 0.9,
            firstRecalledAt: "2026-04-05T12:00:00.000Z",
            lastRecalledAt: "2026-04-05T12:00:00.000Z",
            queryHashes: ["hash-a"],
          },
        },
      }),
      "utf8",
    );
    const config = { agents: { list: [{ id: "main", default: true }] } };

    const preview = await migrationById("memory-core-dreams-json-to-sqlite").detectLegacyState(
      migrationParams(config),
    );
    expect(preview?.preview).toEqual([expect.stringContaining("Memory Core short-term recall")]);

    const result = await migrationById("memory-core-dreams-json-to-sqlite").migrateLegacyState(
      migrationParams(config),
    );

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core short-term recall -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core short-term recall legacy source"),
    ]);
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    const recall = await shortTermTesting.readRecallStore(
      workspaceDir,
      "2026-04-05T12:00:00.000Z",
      "main",
    );
    expect(recall.entries["memory:memory/2026-04-05.md:1:1"]?.conceptTags).toContain("glacier");
  });

  it("moves unscoped SQLite state and the legacy diary to the default agent", async () => {
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
      entries: [
        {
          key: "memory/2026-04-05.md",
          value: {
            size: 42,
            mtimeMs: 1,
            contentHash: "daily-hash",
            ingestedAt: "2026-04-05T10:00:00.000Z",
          },
        },
      ],
    });
    const legacyDiaryPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(legacyDiaryPath, "# Dream Diary\n\nA remembered dream.\n", "utf8");

    const migration = migrationById("memory-core-workspace-state-to-agent-scope");
    const preview = await migration.detectLegacyState(migrationParams());
    expect(preview?.preview).toEqual([
      expect.stringContaining("Memory Core daily ingestion"),
      expect.stringContaining("Memory Core dream diary"),
    ]);

    const result = await migration.migrateLegacyState(migrationParams());
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated Memory Core daily ingestion -> agent-scoped SQLite state (1 row(s), 0 existing agent row(s) retained)",
    );
    expect(result.changes).toContain(
      "Migrated Memory Core dream diary -> agent-scoped path (main)",
    );

    expect(
      await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
      }),
    ).toEqual([]);
    expect(
      await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
        agentId: "main",
      }),
    ).toHaveLength(1);
    await expect(fs.access(`${legacyDiaryPath}.migrated`)).resolves.toBeUndefined();
    await expect(
      fs.readFile(
        path.join(workspaceDir, "memory", ".dreams", "agents", "main", "DREAMS.md"),
        "utf8",
      ),
    ).resolves.toContain("A remembered dream.");
  });

  it("preserves a legacy diary when its destination contains only a substring", async () => {
    const legacyDiaryPath = path.join(workspaceDir, "DREAMS.md");
    const agentDiaryPath = path.join(
      workspaceDir,
      "memory",
      ".dreams",
      "agents",
      "main",
      "DREAMS.md",
    );
    await fs.writeFile(legacyDiaryPath, "A remembered dream\n", "utf8");
    await fs.mkdir(path.dirname(agentDiaryPath), { recursive: true });
    await fs.writeFile(agentDiaryPath, "A remembered dream, continued.\n", "utf8");

    const result = await migrationById(
      "memory-core-workspace-state-to-agent-scope",
    ).migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated Memory Core dream diary -> agent-scoped path (main)",
    );
    await expect(fs.access(`${legacyDiaryPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.readFile(agentDiaryPath, "utf8")).resolves.toBe(
      "A remembered dream\n\n<!-- openclaw:dreaming:legacy-diary-migrated -->\n\nA remembered dream, continued.\n",
    );
  });

  it("canonicalizes agent ids at the SQLite state boundary", async () => {
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    expect(memoryCoreWorkspaceStateKey(workspaceDir, "Team Ops")).toBe(
      memoryCoreWorkspaceStateKey(workspaceDir, "team-ops"),
    );

    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
      agentId: "Team Ops",
      entries: [
        {
          key: "memory/2026-04-06.md",
          value: {
            size: 18,
            mtimeMs: 2,
            contentHash: "team-daily-hash",
            ingestedAt: "2026-04-06T10:00:00.000Z",
          },
        },
      ],
    });

    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
        agentId: "team-ops",
      }),
    ).resolves.toHaveLength(1);
  });

  it("migrates a legacy workspace to that workspace's configured agent", async () => {
    const researchWorkspaceDir = path.join(rootDir, "research");
    const researchDreamsDir = path.join(researchWorkspaceDir, "memory", ".dreams");
    await fs.mkdir(researchDreamsDir, { recursive: true });
    const dailyPath = path.join(researchDreamsDir, "daily-ingestion.json");
    await fs.writeFile(
      dailyPath,
      JSON.stringify({
        version: 1,
        files: {
          "memory/2026-04-06.md": {
            size: 18,
            mtimeMs: 2,
            contentHash: "research-daily-hash",
            ingestedAt: "2026-04-06T10:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    const config: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", default: true, workspace: workspaceDir },
          { id: "research", workspace: researchWorkspaceDir },
        ],
      },
    };

    const migration = migrationById("memory-core-dreams-json-to-sqlite");
    const result = await migration.migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated Memory Core daily ingestion -> SQLite plugin state (1 row(s))",
    );
    expect({
      main: await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir: researchWorkspaceDir,
        agentId: "main",
      }),
      research: await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir: researchWorkspaceDir,
        agentId: "research",
      }),
      unscoped: await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir: researchWorkspaceDir,
      }),
    }).toEqual({
      main: [],
      research: [
        expect.objectContaining({
          key: "memory/2026-04-06.md",
          value: expect.objectContaining({
            size: 18,
            mtimeMs: 2,
          }),
        }),
      ],
      unscoped: [],
    });
  });

  it("imports shared legacy JSON into the configured default agent", async () => {
    const dailyPath = path.join(workspaceDir, "memory", ".dreams", "daily-ingestion.json");
    await fs.writeFile(
      dailyPath,
      JSON.stringify({
        version: 1,
        files: {
          "memory/2026-04-07.md": {
            size: 22,
            mtimeMs: 3,
            contentHash: "shared-daily-hash",
            ingestedAt: "2026-04-07T10:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    const config: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", default: true, workspace: workspaceDir },
          { id: "research", workspace: workspaceDir },
        ],
      },
    };

    const result = await migrationById("memory-core-dreams-json-to-sqlite").migrateLegacyState(
      migrationParams(config),
    );

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated Memory Core daily ingestion -> SQLite plugin state (1 row(s))",
    );
    await expect(fs.access(`${dailyPath}.migrated`)).resolves.toBeUndefined();
    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
        agentId: "main",
      }),
    ).resolves.toHaveLength(1);
    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
        agentId: "research",
      }),
    ).resolves.toEqual([]);
  });

  it("moves shared legacy state and diaries to the configured default agent", async () => {
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
      entries: [
        {
          key: "memory/2026-04-07.md",
          value: {
            size: 22,
            mtimeMs: 3,
            contentHash: "shared-daily-hash",
            ingestedAt: "2026-04-07T10:00:00.000Z",
          },
        },
      ],
    });
    const legacyDiaryPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(legacyDiaryPath, "# Shared dream diary\n", "utf8");
    const config: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", default: true, workspace: workspaceDir },
          { id: "research", workspace: workspaceDir },
        ],
      },
    };
    const migration = migrationById("memory-core-workspace-state-to-agent-scope");

    const preview = await migration.detectLegacyState(migrationParams(config));
    expect(preview?.preview.join("\n")).toContain("-> agent main");

    const result = await migration.migrateLegacyState(migrationParams(config));
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated Memory Core daily ingestion -> agent-scoped SQLite state (1 row(s), 0 existing agent row(s) retained)",
    );
    expect(result.changes).toContain(
      "Migrated Memory Core dream diary -> agent-scoped path (main)",
    );
    expect(
      await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
      }),
    ).toEqual([]);
    expect(
      await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
        agentId: "main",
      }),
    ).toHaveLength(1);
    expect(
      await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
        agentId: "research",
      }),
    ).toEqual([]);
    await expect(fs.access(`${legacyDiaryPath}.migrated`)).resolves.toBeUndefined();
    await expect(
      fs.readFile(
        path.join(workspaceDir, "memory", ".dreams", "agents", "main", "DREAMS.md"),
        "utf8",
      ),
    ).resolves.toContain("Shared dream diary");
  });

  it("leaves shared legacy state in place when the default agent has another workspace", async () => {
    const defaultWorkspaceDir = path.join(rootDir, "default-workspace");
    await fs.mkdir(defaultWorkspaceDir);
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
      entries: [
        {
          key: "memory/2026-04-07.md",
          value: {
            size: 22,
            mtimeMs: 3,
            contentHash: "shared-daily-hash",
            ingestedAt: "2026-04-07T10:00:00.000Z",
          },
        },
      ],
    });
    const config: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", default: true, workspace: defaultWorkspaceDir },
          { id: "research", workspace: workspaceDir },
          { id: "writer", workspace: workspaceDir },
        ],
      },
    };

    const migration = migrationById("memory-core-workspace-state-to-agent-scope");
    const preview = await migration.detectLegacyState(migrationParams(config));
    expect(preview?.preview.join("\n")).toContain("resolved default agent does not share");

    const result = await migration.migrateLegacyState(migrationParams(config));

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("resolved default agent does not share"),
    ]);
    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
      }),
    ).resolves.toHaveLength(1);
  });

  it("moves symlinked shared workspace aliases to the configured default agent", async () => {
    const workspaceAliasDir = path.join(rootDir, "workspace-alias");
    await fs.symlink(workspaceDir, workspaceAliasDir);
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir: workspaceAliasDir,
      entries: [
        {
          key: "memory/2026-04-07.md",
          value: {
            size: 22,
            mtimeMs: 3,
            contentHash: "shared-daily-hash",
            ingestedAt: "2026-04-07T10:00:00.000Z",
          },
        },
      ],
    });
    const config: OpenClawConfig = {
      agents: {
        list: [
          { id: "research", workspace: workspaceAliasDir },
          { id: "main", default: true, workspace: workspaceDir },
        ],
      },
    };
    const migration = migrationById("memory-core-workspace-state-to-agent-scope");

    const preview = await migration.detectLegacyState(migrationParams(config));
    expect(preview?.preview.join("\n")).toContain("-> agent main");

    const result = await migration.migrateLegacyState(migrationParams(config));
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core daily ingestion -> agent-scoped SQLite state (1 row(s), 0 existing agent row(s) retained)",
    ]);
    expect(
      await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
      }),
    ).toEqual([]);
    expect(
      await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir: workspaceAliasDir,
      }),
    ).toEqual([]);
    expect(
      await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir,
        agentId: "main",
      }),
    ).toHaveLength(1);
  });

  it("moves legacy alias state into the configured workspace scope", async () => {
    const workspaceAliasDir = path.join(rootDir, "workspace-alias");
    const workspaceCanonicalDir = await fs.realpath(workspaceDir);
    await fs.symlink(workspaceDir, workspaceAliasDir);
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir: workspaceCanonicalDir,
      entries: [
        {
          key: "memory/2026-04-08.md",
          value: {
            size: 23,
            mtimeMs: 4,
            contentHash: "alias-daily-hash",
            ingestedAt: "2026-04-08T10:00:00.000Z",
          },
        },
      ],
    });
    const config: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceAliasDir }],
      },
    };
    const migration = migrationById("memory-core-workspace-state-to-agent-scope");

    const result = await migration.migrateLegacyState(migrationParams(config));
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core daily ingestion -> agent-scoped SQLite state (1 row(s), 0 existing agent row(s) retained)",
    ]);
    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir: workspaceCanonicalDir,
      }),
    ).resolves.toEqual([]);
    await expect(
      readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
        workspaceDir: workspaceAliasDir,
        agentId: "main",
      }),
    ).resolves.toHaveLength(1);
  });

  it("does not migrate legacy sources through symlinked dream directories", async () => {
    const dreamsDir = path.join(workspaceDir, "memory", ".dreams");
    const outsideDreamsDir = path.join(rootDir, "outside-dreams");
    const outsideLegacyPath = path.join(outsideDreamsDir, "short-term-recall.json");
    await fs.rm(dreamsDir, { recursive: true, force: true });
    await fs.mkdir(outsideDreamsDir, { recursive: true });
    await fs.writeFile(
      outsideLegacyPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-07T10:00:00.000Z",
        entries: {},
      }),
      "utf8",
    );
    await fs.symlink(outsideDreamsDir, dreamsDir);

    const migration = migrationById("memory-core-dreams-json-to-sqlite");
    expect(await migration.detectLegacyState(migrationParams())).toBeNull();

    const result = await migration.migrateLegacyState(migrationParams());
    expect(result).toEqual({ changes: [], warnings: [] });
    await expect(fs.access(outsideLegacyPath)).resolves.toBeUndefined();
    await expect(fs.access(`${outsideLegacyPath}.migrated`)).rejects.toThrow();
  });
});
