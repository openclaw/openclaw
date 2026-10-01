import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveSessionTranscriptsDirForAgent as resolveTestSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  firstWrittenJsonArg,
  spyRuntimeErrors,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryCoreStateStore } from "./dreaming-state.js";
import type { MemoryForgetReport } from "./memory-forget-report.js";
import type { GroundedRemPreviewResult } from "./rem-evidence.js";
import { readShortTermRecallEntries, recordShortTermRecalls } from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
  seedMemoryIndexWithOrphanedProvenance,
  shortTermTestState as shortTermTesting,
} from "./test-helpers.js";

const getMemorySearchManager = vi.hoisted(() => vi.fn());
const forgetMemoryEntries = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn(() => ({})));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveCommandSecretRefsViaGateway = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  })),
);

async function expectPathMissing(targetPath: string): Promise<void> {
  const error: unknown = await fs.stat(targetPath).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: "ENOENT" });
}

async function seedCliBackfillTranscript(
  sessionId: string,
  days: string[],
  metadata: Partial<Parameters<typeof upsertSessionEntry>[0]["entry"]> = {},
): Promise<void> {
  const agentId = "main";
  const sessionsDir = resolveTestSessionTranscriptsDirForAgent(agentId);
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = `agent:${agentId}:cli-session-backfill:${sessionId}`;
  const entry = { ...metadata, sessionId, updatedAt: Date.now() };
  await fs.mkdir(sessionsDir, { recursive: true });
  await upsertSessionEntry({ agentId, sessionKey, storePath, entry });
  for (const day of days) {
    await appendSessionTranscriptMessageByIdentity({
      agentId,
      sessionId,
      sessionKey,
      storePath,
      message: {
        role: "user",
        content: `CLI lifecycle note for ${day}`,
        timestamp: `${day}T12:00:00.000Z`,
        __openclaw: { senderIsOwner: true },
      },
    });
  }
  await upsertSessionEntry({ agentId, sessionKey, storePath, entry });
}

vi.mock("./memory-forget.js", () => ({ forgetMemoryEntries }));

vi.mock("./memory/index.js", () => ({ getMemorySearchManager }));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli")>()),
  resolveCommandSecretRefsViaGateway,
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-core")>()),
  getRuntimeConfig,
  resolveDefaultAgentId,
}));

let registerMemoryCli: typeof import("./cli.js").registerMemoryCli;
let defaultRuntime: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").defaultRuntime;
let setVerbose: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").setVerbose;
let fixtureRoot = "";
let workspaceFixtureRoot = "";
let workspaceCaseId = 0;

beforeAll(async () => {
  await configureMemoryCoreDreamingStateForTests();
  ({ registerMemoryCli } = await import("./cli.js"));
  ({ defaultRuntime, setVerbose } =
    await import("openclaw/plugin-sdk/memory-core-host-runtime-cli"));
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-fixtures-"));
  workspaceFixtureRoot = path.join(fixtureRoot, "workspace");
  await fs.mkdir(workspaceFixtureRoot, { recursive: true });
});

beforeEach(() => {
  process.exitCode = 0;
  getMemorySearchManager.mockReset();
  forgetMemoryEntries.mockReset();
  getRuntimeConfig.mockReset().mockReturnValue({});
  resolveDefaultAgentId.mockReset().mockReturnValue("main");
  resolveCommandSecretRefsViaGateway.mockReset().mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  }));
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  setVerbose(false);
});

afterAll(async () => {
  if (!fixtureRoot) {
    return;
  }
  // The agent close releases its leases through shared state and reopens it, so the
  // shared handle is released second; otherwise Windows fails the removal with EBUSY.
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  resetMemoryCoreDreamingStateForTests();
});

describe("memory cli", () => {
  const inactiveMemorySecretDiagnostic = "memory.search.remote.apiKey inactive"; // pragma: allowlist secret

  function expectCliSync(sync: ReturnType<typeof vi.fn>) {
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
  }

  function setDreaming(dreaming: Record<string, unknown>) {
    getRuntimeConfig.mockReturnValue({
      plugins: { entries: { "memory-core": { config: { dreaming } } } },
    });
  }

  function makeMemoryStatus(overrides: Record<string, unknown> = {}) {
    return {
      backend: "builtin" as const,
      files: 0,
      chunks: 0,
      dirty: false,
      workspaceDir: "/tmp/openclaw",
      dbPath: "/tmp/memory.sqlite",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
      vector: { enabled: true, storeAvailable: true, semanticAvailable: true, available: true },
      ...overrides,
    };
  }

  function mockManager(manager: Record<string, unknown>) {
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        ...(manager.search && !manager.status ? { status: () => makeMemoryStatus() } : {}),
        ...manager,
      },
    });
  }

  function mockStatusManager(
    overrides: Record<string, unknown>,
    methods: Record<string, unknown> = {},
  ) {
    mockManager({
      status: () => makeMemoryStatus(overrides),
      close: vi.fn(async () => {}),
      ...methods,
    });
  }

  function mockWorkspaceManager(workspaceDir: string) {
    const close = vi.fn(async () => {});
    mockManager({ status: () => makeMemoryStatus({ workspaceDir }), close });
    return close;
  }

  function loggedOutput(spy: ReturnType<typeof vi.spyOn>): string {
    return stripVTControlCharacters(
      spy.mock.calls
        .map((call: unknown[]) => (typeof call[0] === "string" ? call[0] : ""))
        .join("\n"),
    );
  }

  function expectLogged(spy: ReturnType<typeof vi.spyOn>, expected: string) {
    expect(loggedOutput(spy)).toContain(expected);
  }

  function expectNotLogged(spy: ReturnType<typeof vi.spyOn>, expected: string) {
    expect(loggedOutput(spy)).not.toContain(expected);
  }

  async function runMemoryCli(
    args: string[],
    hostOptions?: Parameters<typeof registerMemoryCli>[1],
  ) {
    const program = new Command().name("test");
    registerMemoryCli(program, hostOptions);
    await program.parseAsync(["memory", ...args], { from: "user" });
  }

  const unrestrictedPromotion = [
    "--min-score",
    "--min-recall-count",
    "--min-unique-queries",
  ].flatMap((flag) => [flag, "0"]);

  const configuredAgents = {
    agents: { ownership: "explicit" as const, entries: { main: {}, ops: {} } },
  };

  it("resets and rebuilds the real index without changing canonical session bytes or other owners", async () => {
    const stateDir = path.join(fixtureRoot, `reset-state-${workspaceCaseId++}`);
    const workspaceDir = path.join(fixtureRoot, `reset-workspace-${workspaceCaseId++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Memory\nThe observatory uses a copper telescope.\n",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main", default: true }] },
      memory: {
        search: {
          provider: "none",
          sources: ["memory"],
          store: { vector: { enabled: false } },
        },
      },
      plugins: { enabled: false },
    };
    getRuntimeConfig.mockReturnValue(cfg);
    await seedCliBackfillTranscript("reset-survivor", ["2026-01-01"]);
    const actualMemory =
      await vi.importActual<typeof import("./memory/index.js")>("./memory/index.js");
    getMemorySearchManager.mockImplementation(actualMemory.getMemorySearchManager);
    await runMemoryCli(["index", "--agent", "main"]);
    const db = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
    try {
      // A valid older same-version store must not undergo unrelated repairs during reset.
      db.exec("ALTER TABLE session_pending_inputs DROP COLUMN consumed_event_id");
      const pendingInputSchema = () =>
        db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'session_pending_inputs'").get();
      const beforePendingInputSchema = pendingInputSchema();
      const nonMemoryTables = (
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
          .all() as Array<{ name: string }>
      ).filter(
        ({ name }) => !name.startsWith("memory_index_") && name !== "memory_embedding_cache",
      );
      const snapshot = () =>
        nonMemoryTables.map(({ name }) => ({
          name,
          rows: db
            .prepare(`SELECT * FROM "${name}"`)
            .all()
            .map((row) => JSON.stringify(row))
            .toSorted(),
        }));
      const before = snapshot();
      expect(db.prepare("SELECT COUNT(*) AS count FROM transcript_events").get()).toEqual({
        count: 2,
      });
      const indexedContent = () =>
        db
          .prepare(
            "SELECT path, text, embedding FROM memory_index_chunks ORDER BY path, start_line",
          )
          .all();
      const beforeIndex = indexedContent();
      expect(beforeIndex.some((row) => String(row.text).includes("copper telescope"))).toBe(true);
      await runMemoryCli(["reset", "--agent", "main", "--yes"]);
      expect(pendingInputSchema()).toEqual(beforePendingInputSchema);
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get()).toEqual({
        count: 0,
      });
      expect(snapshot()).toEqual(before);
      await runMemoryCli(["index", "--agent", "main"]);
      expect(indexedContent()).toEqual(beforeIndex);
      expect(snapshot()).toEqual(before);
    } finally {
      db.close();
      await actualMemory.closeAllMemorySearchManagers();
    }
  });

  it("requires reset confirmation and does not create missing agent databases", async () => {
    const stateDir = path.join(fixtureRoot, `missing-reset-${workspaceCaseId++}`);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    getRuntimeConfig.mockReturnValue(configuredAgents);
    await expect(runMemoryCli(["reset"])).rejects.toThrow("--yes");
    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["reset", "--yes"]);
    for (const agentId of ["main", "ops"]) {
      expect(log).toHaveBeenCalledWith(`No memory index to reset (${agentId}).`);
      await expectPathMissing(resolveOpenClawAgentSqlitePath({ agentId }));
    }
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("forwards repeated forget selectors and reports quoted lines and curated writes in both output formats", async () => {
    getRuntimeConfig.mockReturnValue(configuredAgents);
    const report: MemoryForgetReport = {
      participantMatches: [
        {
          actorId: "person-one",
          identities: [
            { type: "profile", id: "person-one" },
            { type: "agent", id: "person-one" },
          ],
        },
      ],
      agentId: "ops",
      dryRun: true,
      sessionIds: ["session-one", "session-two"],
      sessionResolutions: [
        { sessionId: "session-one", sessionKey: "agent:ops:one", source: "live" },
        { sessionId: "session-two", source: "unresolved" },
      ],
      entryKeys: ["mixed-entry"],
      mixedLineageEntryKeys: ["mixed-entry"],
      untargetableEntryKeys: ["curated-entry"],
      curatedWrites: [
        { relativePath: "MEMORY.md", observedAt: Date.parse("2026-08-25T12:00:00Z") },
      ],
      artifacts: {
        memoryFiles: 1,
        memoryEntries: 1,
        memoryLines: 2,
        sessionCorpusFiles: 1,
        sessionCorpusLines: 2,
        indexChunks: 1,
        indexSources: 0,
        ftsRows: 1,
        vectorRows: 1,
        embeddingCacheRows: 1,
        shortTermEntries: 1,
        seenHashScopes: 2,
        backups: 1,
        originRows: 2,
      },
      refusals: [],
    };
    forgetMemoryEntries.mockResolvedValueOnce(report);
    const json = spyRuntimeJson(defaultRuntime);

    await runMemoryCli([
      "forget",
      "--session",
      "session-one",
      "--session",
      "session-two",
      "--hook-source",
      "gmail",
      "--hook-source",
      "email",
      "--participant",
      "person-one",
      "--participant",
      "person-two",
      "--since",
      "2026-01-01",
      "--agent",
      "ops",
      "--dry-run",
      "--json",
    ]);

    expect(forgetMemoryEntries).toHaveBeenCalledWith({
      cfg: configuredAgents,
      agentId: "ops",
      sessionIds: ["session-one", "session-two"],
      hookSources: ["gmail", "email"],
      participants: ["person-one", "person-two"],
      since: "2026-01-01",
      dryRun: true,
    });
    expect(firstWrittenJsonArg(json)).toEqual(report);

    forgetMemoryEntries.mockResolvedValueOnce(report);
    const logs = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["forget", "--session", "session-one", "--agent", "ops", "--dry-run"]);
    const output = loggedOutput(logs);
    expect(output).toContain("Source transcripts retained: 2");
    expect(output).toContain(
      'Raw participant selector: person-one: {"type":"profile","id":"person-one"}, {"type":"agent","id":"person-one"}',
    );
    expect(output).toContain("Matches select whole sessions across identity namespaces.");
    expect(output).toContain("Session resolution: session-one (live)");
    expect(output).toContain("Session resolution: session-two (unresolved)");
    expect(output).toContain("Memory artifacts: 1 files, 1 entries, 2 quoted lines");
    expect(output).toContain("Curated write retained: MEMORY.md (2026-08-25T12:00:00.000Z)");
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it.each([
    ["status", ["status", "--agent", "nope-zzz"]],
    ["search", ["search", "foo", "--agent", "nope-zzz"]],
  ])("rejects an unknown explicit agent before %s acquires a manager", async (_name, args) => {
    getRuntimeConfig.mockReturnValue(configuredAgents);

    await expect(runMemoryCli(args)).rejects.toThrow(
      'Unknown agent id "nope-zzz". Run openclaw agents list to see configured agents.',
    );
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it.each([
    ["status", ["status", "--agent", ""]],
    ["search", ["search", "foo", "--agent", ""]],
  ])("rejects an explicitly blank agent before %s acquires a manager", async (_name, args) => {
    getRuntimeConfig.mockReturnValue(configuredAgents);

    await expect(runMemoryCli(args)).rejects.toThrow("--agent must not be blank");
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("drains admitted session backfill in one apply command before preview", async () => {
    const workspaceDir = path.join(workspaceFixtureRoot, `session-backfill-${workspaceCaseId++}`);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(workspaceDir, "openclaw.json"));
    await fs.mkdir(workspaceDir, { recursive: true });
    await seedCliBackfillTranscript("drain", ["2026-01-01", "2026-01-02", "2026-01-03"]);
    await seedCliBackfillTranscript("excluded", ["2026-01-04"], {
      delivery: normalizeSessionDeliveryState({
        context: { channel: "discord", to: "channel:admission-fixture" },
        origin: { provider: "discord", to: "channel:admission-fixture" },
      }),
    });
    getRuntimeConfig.mockReturnValue({
      plugins: {
        entries: {
          "memory-core": {
            config: { memoryPolicy: { excludeSessions: { channels: ["discord"] } } },
          },
        },
      },
    });

    mockManager({ status: () => makeMemoryStatus({ workspaceDir }), close: vi.fn() });
    const applyJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli([
      "session-backfill",
      "--agent",
      "main",
      "--limit-days",
      "1",
      "--apply",
      "--json",
    ]);
    const applied = firstWrittenJsonArg<{
      batchCount: number;
      batches: Array<{ candidates: number }>;
      candidateCount: number;
    }>(applyJson);
    expect(applied).toMatchObject({ batchCount: 3, candidateCount: 3 });
    expect(applied?.batches.map((batch) => batch.candidates)).toEqual([1, 1, 1]);

    mockManager({ status: () => makeMemoryStatus({ workspaceDir }), close: vi.fn() });
    applyJson.mockClear();
    await runMemoryCli(["session-backfill", "--agent", "main", "--limit-days", "1", "--json"]);
    expect(firstWrittenJsonArg<{ candidateCount: number }>(applyJson)).toMatchObject({
      candidateCount: 0,
    });
  });

  it.each([
    [["search", "hello", "--max-results", "2.5"], "--max-results must be a positive integer."],
    [["search", "hello", "--min-score", "0x1"], "--min-score must be a finite number."],
    [
      ["promote", "--min-recall-count", "0x1"],
      "--min-recall-count must be a non-negative integer.",
    ],
  ])("rejects invalid memory numeric option %j before acquisition", async (args, message) => {
    const program = new Command().exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerMemoryCli(program);
    await expect(program.parseAsync(["memory", ...args], { from: "user" })).rejects.toThrow(
      message,
    );
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  async function createWorkspace() {
    const workspaceDir = path.join(workspaceFixtureRoot, `case-${workspaceCaseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    return workspaceDir;
  }

  type RecallResult = Parameters<typeof recordShortTermRecalls>[0]["results"][number];

  function recallResult(
    memoryPath: string,
    snippet: string,
    details: Partial<Omit<RecallResult, "path" | "snippet" | "source">> & { line?: number } = {},
  ): RecallResult {
    const { line = 1, ...overrides } = details;
    return {
      path: memoryPath,
      snippet,
      source: "memory",
      startLine: line,
      endLine: line,
      score: 0.91,
      ...overrides,
    };
  }

  async function recordRecall(workspaceDir: string, query: string, result: RecallResult) {
    await recordShortTermRecalls({ workspaceDir, query, results: [result] });
  }

  async function writeDailyMemoryNote(
    workspaceDir: string,
    date: string,
    lines: string[],
  ): Promise<void> {
    const notePath = path.join(workspaceDir, "memory", `${date}.md`);
    await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
  }

  async function writeHistory(workspaceDir: string, name: string, lines: string[]) {
    const historyDir = path.join(workspaceDir, "history");
    await fs.mkdir(historyDir, { recursive: true });
    const historyPath = path.join(historyDir, name);
    await fs.writeFile(historyPath, lines.join("\n") + "\n", "utf-8");
    return historyPath;
  }

  async function previewGroundedHistory(workspaceDir: string, historyPath: string) {
    mockWorkspaceManager(workspaceDir);
    const output = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["rem-harness", "--json", "--grounded", "--path", historyPath]);
    return firstWrittenJsonArg<{ grounded?: GroundedRemPreviewResult | null }>(output)?.grounded
      ?.files[0];
  }

  async function withHistoricalCliFixture(
    command: "rem-harness" | "rem-backfill",
    run: (fixture: {
      workspaceDir: string;
      historyPath: string;
      scratchDirectory: () => string | undefined;
      close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    }) => Promise<void>,
  ) {
    const workspaceDir = await createWorkspace();
    const historyPath = path.join(workspaceDir, "2025-01-01.md");
    await fs.writeFile(historyPath, "## Preferences Learned\n- Always carry a blue notebook.\n");
    const actualMkdtemp = fs.mkdtemp;
    const actualRm = fs.rm;
    let scratchDir: string | undefined;
    const captureScratch = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
      const created = await actualMkdtemp(prefix, options);
      if (path.basename(prefix) === `openclaw-${command}-` && typeof created === "string") {
        scratchDir = created;
      }
      return created;
    });
    const close = vi.fn(async () => {});
    mockManager({ status: () => makeMemoryStatus({ workspaceDir }), close });
    try {
      await run({ workspaceDir, historyPath, scratchDirectory: () => scratchDir, close });
    } finally {
      captureScratch.mockRestore();
      // Callers settle their command first; release stores before removing failed scratch input.
      closeOpenClawAgentDatabasesForTest();
      if (scratchDir) {
        await actualRm(scratchDir, { recursive: true, force: true });
      }
    }
  }

  it("prints vector status when available", async () => {
    const probeVectorAvailability = vi.fn(async () => true);
    mockStatusManager(
      {
        files: 2,
        chunks: 5,
        extraPaths: [{ path: "notes", pattern: "runbooks/**/*.md" }],
        sourceCounts: [{ source: "memory", files: 2, chunks: 5, chunkBytes: 2048 }],
        storage: {
          databaseBytes: 1048576,
          walBytes: 2048,
          reusableBytes: 524288,
          embeddingCacheBytes: 4096,
          embeddingCacheEntries: 123,
        },
        cache: { enabled: true, entries: 123, maxEntries: 50000 },
        fts: { enabled: true, available: true },
        vector: {
          enabled: true,
          storeAvailable: true,
          semanticAvailable: true,
          available: true,
          extensionPath: "/opt/sqlite-vec.dylib",
          dims: 1024,
        },
      },
      { probeVectorAvailability },
    );

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status"]);

    expect(getRuntimeConfig).toHaveBeenCalledWith({ skipPluginValidation: true });

    expect(probeVectorAvailability).not.toHaveBeenCalled();
    expectLogged(log, "Vector store: ready");
    expectLogged(log, "Semantic vectors: ready");
    expectLogged(log, "Extra paths: /tmp/openclaw/notes (pattern: runbooks/**/*.md)");
    expectLogged(log, "FTS: ready");
    expectLogged(log, "Agent database: 1.0 MiB · WAL 2.0 KiB · reusable 512.0 KiB");
  });

  it("still aborts status when its own memory SecretRef cannot be resolved", async () => {
    getRuntimeConfig.mockReturnValue({
      memory: {
        search: {
          remote: {
            apiKey: { source: "env", provider: "default", id: "MISSING_MEMORY_API_KEY" },
          },
        },
      },
    });
    resolveCommandSecretRefsViaGateway.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Secret owner capability:memory-provider:main is configured but unavailable: code=SECRET_SURFACE_UNAVAILABLE",
        ),
        {
          code: "SECRET_SURFACE_UNAVAILABLE",
          ownerKind: "capability",
          ownerId: "memory-provider:main",
          paths: ["memory.search.remote.apiKey"],
        },
      ),
    );

    await expect(runMemoryCli(["status", "--deep"])).rejects.toThrow("SECRET_SURFACE_UNAVAILABLE");
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "light only",
      light: true,
      rem: false,
      deep: false,
      expected: "Dreaming: light=15 2 * * * (UTC) · limit=5 · lookbackDays=1",
    },
    {
      name: "REM only",
      light: false,
      rem: true,
      deep: false,
      expected:
        "Dreaming: rem=15 2 * * * (UTC) · limit=2 · lookbackDays=14 · minPatternStrength=0.67",
    },
    {
      name: "deep only",
      light: false,
      rem: false,
      deep: true,
      expected: "Dreaming: 15 2 * * * (UTC) · limit=7 · minScore=0.72",
    },
    {
      name: "all phases",
      light: true,
      rem: true,
      deep: true,
      expected:
        "Dreaming: light=15 2 * * * (UTC) · limit=5 · lookbackDays=1 · rem=15 2 * * * (UTC) · limit=2 · lookbackDays=14 · minPatternStrength=0.67 · deep=15 2 * * * (UTC) · limit=7 · minScore=0.72",
    },
    { name: "off", light: false, rem: false, deep: false, expected: "Dreaming: off" },
  ])(
    "reports configured dreaming phases during status ($name)",
    async ({ light, rem, deep, expected }) => {
      setDreaming({
        enabled: true,
        frequency: "15 2 * * *",
        timezone: "UTC",
        phases: {
          light: { enabled: light, limit: 5, lookbackDays: 1 },
          rem: { enabled: rem, limit: 2, lookbackDays: 14, minPatternStrength: 0.67 },
          deep: {
            enabled: deep,
            limit: 7,
            minScore: 0.72,
            minRecallCount: 4,
            minUniqueQueries: 2,
            recencyHalfLifeDays: 10,
            maxAgeDays: 45,
            maxPromotedSnippetTokens: 512,
          },
        },
      });
      const close = vi.fn(async () => {});
      mockStatusManager({ workspaceDir: undefined }, { close });
      const log = spyRuntimeLogs(defaultRuntime);

      await runMemoryCli(["status"]);

      expectLogged(log, expected);
      if (deep) {
        expectLogged(
          log,
          "minRecallCount=4 · minUniqueQueries=2 · recencyHalfLifeDays=10 · maxAgeDays=45 · maxPromotedSnippetTokens=512",
        );
      }
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("keeps newer-index upgrade advice in registered deep status without reindexing", async () => {
    const sync = vi.fn();
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      sync,
      probeVectorAvailability: vi.fn(async () => false),
      probeEmbeddingAvailability,
      status: () =>
        makeMemoryStatus({
          workspaceDir: undefined,
          custom: {
            indexIdentity: {
              status: "mismatched",
              reason:
                "the index was written by a newer OpenClaw version; upgrade OpenClaw or reindex explicitly",
              code: "provenance_version",
              owner: "openclaw",
              versionOrder: "newer",
            },
          },
        }),
      close: vi.fn(async () => {}),
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--deep"]);

    expectLogged(log, "upgrade OpenClaw or reindex explicitly");
    expectLogged(log, "Vector search: paused");
    expectNotLogged(log, "paused until memory is rebuilt");
    expectLogged(log, "openclaw memory status --index --agent main");
    expectLogged(log, "provider cost");
    expect(probeEmbeddingAvailability).toHaveBeenCalledOnce();
    expect(sync).not.toHaveBeenCalled();
  });

  it("reports a complete persisted vector index without probing the store", async () => {
    const probeVectorStoreAvailability = vi.fn(async () => {
      throw new Error("unexpected vector store probe");
    });
    const probeVectorAvailability = vi.fn(async () => {
      throw new Error("unexpected vector probe");
    });
    const probeEmbeddingAvailability = vi.fn(async () => {
      throw new Error("unexpected embedding probe");
    });
    mockStatusManager(
      {
        chunks: 5,
        provider: "auto",
        requestedProvider: "auto",
        custom: {
          llamaCppRuntime: {
            engine: "llama.cpp",
            state: "ready",
            backend: "metal",
            buildInfo: "b10357 (689e227db)",
          },
        },
        vector: { enabled: true, index: { state: "complete" } },
      },
      { probeVectorStoreAvailability, probeVectorAvailability, probeEmbeddingAvailability },
    );

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status"]);

    expect(probeVectorStoreAvailability).not.toHaveBeenCalled();
    expect(probeVectorAvailability).not.toHaveBeenCalled();
    expect(probeEmbeddingAvailability).not.toHaveBeenCalled();
    expectLogged(log, "Vector store: indexed (unprobed)");
    expectNotLogged(log, "Vector store: unknown");
    expectNotLogged(log, "llama.cpp server:");
    expectLogged(log, "Provider: auto");
  });

  it("fans JSON status out to every keyed agent entry", async () => {
    const agentIds = ["main", ...Array.from({ length: 21 }, (_, index) => `agent-${index + 1}`)];
    getRuntimeConfig.mockReturnValue({
      agents: {
        entries: Object.fromEntries(
          agentIds.map((agentId, index) => [agentId, { default: index === 0 }]),
        ),
      },
    });
    getMemorySearchManager.mockImplementation(async ({ agentId }: { agentId: string }) => ({
      manager: {
        status: () =>
          makeMemoryStatus({
            workspaceDir: undefined,
            dbPath: `/state/agents/${agentId}/agent/openclaw-agent.sqlite`,
          }),
        close: vi.fn(async () => {}),
      },
    }));
    const json = spyRuntimeJson(defaultRuntime);
    const keyedStore = {};
    const openKeyedStore = vi.fn(() => keyedStore);
    resetMemoryCoreDreamingStateForTests();

    try {
      await runMemoryCli(["status", "--json"], { openKeyedStore: openKeyedStore as never });

      expect(
        getMemorySearchManager.mock.calls.map(
          ([params]) => (params as { agentId: string }).agentId,
        ),
      ).toEqual(agentIds);
      const payload =
        firstWrittenJsonArg<Array<{ agentId: string; status: { dbPath: string } }>>(json);
      expect(payload?.map(({ agentId }) => agentId)).toEqual(agentIds);
      expect(payload?.map(({ status }) => status.dbPath)).toEqual(
        agentIds.map((agentId) => `/state/agents/${agentId}/agent/openclaw-agent.sqlite`),
      );
      const storeOptions = { namespace: "cli-status-regression", maxEntries: 1 };
      expect(openMemoryCoreStateStore(storeOptions)).toBe(keyedStore);
      expect(openKeyedStore).toHaveBeenCalledWith(storeOptions);
    } finally {
      await configureMemoryCoreDreamingStateForTests();
    }
  });

  it("keeps status available when a memory SecretRef owner is degraded", async () => {
    getRuntimeConfig.mockReturnValue({
      memory: {
        search: {
          remote: {
            apiKey: { source: "env", provider: "default", id: "HEALTHY_MEMORY_API_KEY" },
          },
        },
      },
    });
    resolveCommandSecretRefsViaGateway.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Secret owner agent:main:openai:manual is configured but unavailable: code=SECRET_SURFACE_UNAVAILABLE",
        ),
        { code: "SECRET_SURFACE_UNAVAILABLE" },
      ),
    );
    mockStatusManager(
      {
        workspaceDir: undefined,
        vector: {
          enabled: true,
          index: { state: "complete" },
          storeAvailable: false,
          semanticAvailable: false,
          available: false,
          loadError: "load failed",
        },
      },
      {
        probeVectorAvailability: vi.fn(async () => true),
        probeEmbeddingAvailability: vi.fn(async () => ({
          ok: false,
          error: "embedding provider unavailable",
        })),
      },
    );

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--deep"]);

    expect(loggedOutput(log)).toContain("agent:main:openai:manual");
    expect(loggedOutput(log)).toContain("healthy memory surfaces remain visible");
    expect(loggedOutput(log)).toContain("Embeddings: unavailable");
    expectLogged(log, "Vector store: unavailable");
    expectLogged(log, "Semantic vectors: unavailable");
    expectLogged(log, "Vector error: load failed");
  });

  it("reindexes and probes local runtime details with status --index", async () => {
    const sync = vi.fn(async () => {});
    const probeVectorStoreAvailability = vi.fn(async () => true);
    const probeVectorAvailability = vi.fn(async () => true);
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockStatusManager(
      {
        files: 1,
        chunks: 1,
        custom: {
          llamaCppRuntime: {
            engine: "llama.cpp",
            state: "ready",
            backend: "metal",
            buildInfo: "b10357 (689e227db)",
            model: {
              id: "embeddinggemma-300m-qat-q8_0",
              path: "/models/embedding.gguf",
            },
            capabilities: { vision: false, draft: false },
            endpoints: {
              health: "ready",
              models: "ready",
              props: "ready",
              metrics: "ready",
            },
          },
        },
      },
      { sync, probeVectorStoreAvailability, probeVectorAvailability, probeEmbeddingAvailability },
    );

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--index"]);

    expectCliSync(sync);

    expect(probeVectorStoreAvailability).toHaveBeenCalled();
    expect(probeVectorAvailability).toHaveBeenCalled();
    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expectLogged(log, "Embeddings: ready");
    expectLogged(log, "llama.cpp server: metal (b10357 (689e227db))");
  });

  it("repairs invalid recall metadata and stale locks with status --fix", async () => {
    const workspaceDir = await createWorkspace();
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-03.md"),
      "Vector router cache note\n",
      "utf-8",
    );
    await shortTermTesting.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: "2026-04-04T00:00:00.000Z",
      entries: {
        good: {
          key: "good",
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "Vector router cache note",
          recallCount: 1,
          totalScore: 0.8,
          maxScore: 0.8,
          firstRecalledAt: "2026-04-04T00:00:00.000Z",
          lastRecalledAt: "2026-04-04T00:00:00.000Z",
          queryHashes: ["a"],
        },
        bad: {
          path: "",
        },
      },
    });
    await shortTermTesting.writeShortTermLock(workspaceDir, {
      owner: "999999:0",
      acquiredAt: Date.now() - 120_000,
    });

    mockWorkspaceManager(workspaceDir);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status"]);
    expectLogged(log, "Fix: openclaw memory status --fix --agent main");
    log.mockClear();
    mockWorkspaceManager(workspaceDir);
    await runMemoryCli(["status", "--fix"]);
    expectNotLogged(log, "Fix: openclaw memory status --fix --agent main");

    expectLogged(log, "Repair: rewrote store");
    expect(getMemorySearchManager).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "cli" }),
    );
    const audit = await shortTermTesting.readRecallStore(workspaceDir, new Date().toISOString());
    const repaired = audit as {
      entries: Record<string, { conceptTags?: string[] }>;
    };
    expect(repaired.entries.good?.conceptTags).toContain("router");
  });

  it("repairs contaminated dreaming artifacts during status --fix", async () => {
    const workspaceDir = await createWorkspace();
    const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(sessionCorpusDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionCorpusDir, "2026-04-11.txt"),
      [
        "[main/dreaming-main.jsonl#L3] ordinary session line",
        "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"),
      JSON.stringify({ version: 3, files: {}, seenMessages: {} }, null, 2),
      "utf-8",
    );
    await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "# Dream Diary\n", "utf-8");

    mockWorkspaceManager(workspaceDir);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--fix"]);

    expectLogged(log, "Dream repair: archived session corpus");
    expectLogged(log, "Dream archive:");
    await expectPathMissing(sessionCorpusDir);
    await expectPathMissing(path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"));
    await expect(fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8")).resolves.toContain(
      "# Dream Diary",
    );
  });

  it("reports a truthful no-op when the memory directory is missing", async () => {
    const workspaceDir = path.join(workspaceFixtureRoot, `case-${workspaceCaseId++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    const sync = vi.fn(async () => {});
    mockStatusManager(
      {
        workspaceDir,
        sources: ["memory"],
        sourceCounts: [
          {
            source: "memory",
            files: 0,
            chunks: 0,
            eligible: 0,
            issues: ["no eligible memory files found"],
          },
        ],
      },
      { sync },
    );

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["index"]);

    expectCliSync(sync);
    expectLogged(log, `No memory files found in ${workspaceDir}; nothing indexed (main).`);
    expectNotLogged(log, "Memory index updated");
    await expectPathMissing(path.join(workspaceDir, "memory"));
    expect(process.exitCode).toBe(0);
  });

  it("describes session index sources without implying active JSONL storage", async () => {
    const workspaceDir = await createWorkspace();
    const sync = vi.fn(async () => {});
    mockStatusManager({ workspaceDir, sources: ["sessions"], files: 1 }, { sync });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["index", "--verbose"]);

    expectLogged(log, "sessions (current transcripts + retained transcript artifacts)");
    expectNotLogged(log, "*.jsonl");
    expectLogged(log, "Memory index updated (main): 1 file indexed.");
  });

  it("warns on stderr when index has vector store but no semantic vectors", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    let semanticAvailable: boolean | undefined;
    const probeVectorAvailability = vi.fn(async () => {
      semanticAvailable = false;
      return false;
    });
    mockManager({
      probeVectorAvailability,
      sync,
      status: () =>
        makeMemoryStatus({
          vector: {
            enabled: true,
            storeAvailable: true,
            semanticAvailable,
            available: semanticAvailable,
          },
        }),
      close,
    });

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["index"]);

    expectCliSync(sync);
    expect(probeVectorAvailability).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "Memory index WARNING (main): chunks_vec not updated — semantic vector embeddings unavailable — no vector dimensions resolved. Vector recall degraded.",
    );
    expect(process.exitCode).toBe(0);
  });

  it.each([false, true])(
    "keeps successful search output when close fails (json=%s)",
    async (json) => {
      const results = [
        { path: "memory/2026-01-12.md", startLine: 1, endLine: 2, score: 0.5, snippet: "Hello" },
      ];
      const search = vi.fn(async () => results);
      const close = vi.fn(async () => {
        throw new Error("close boom");
      });
      mockManager({ search, close });
      const writeJson = spyRuntimeJson(defaultRuntime);
      const error = spyRuntimeErrors(defaultRuntime);
      await runMemoryCli(["search", "hello", ...(json ? ["--json"] : [])]);
      expect(search).toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith("Memory manager close failed: close boom");
      expect(process.exitCode).toBe(0);
      if (json) {
        expect(writeJson).toHaveBeenCalledTimes(1);
        expect(firstWrittenJsonArg(writeJson)).toEqual({
          results: [
            {
              path: "memory/2026-01-12.md",
              startLine: 1,
              endLine: 2,
              score: 0.5,
              snippet: "Hello",
            },
          ],
        });
      } else {
        expect(writeJson).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { rebuild: true, closeFails: false },
    { rebuild: false, closeFails: true },
  ])(
    "propagates search failure after close (rebuild=$rebuild, closeFails=$closeFails)",
    async ({ rebuild, closeFails }) => {
      const warning = "Memory index rebuilt; embedding provider cost may apply.";
      const notice: { sequence: number; warning?: string } = { sequence: 0 };
      const close = vi.fn(async () => {
        if (closeFails) {
          throw new Error("close boom");
        }
      });
      const search = vi.fn(async () => {
        if (rebuild) {
          notice.sequence += 1;
          notice.warning = warning;
        }
        throw new Error("boom");
      });
      mockManager({
        search,
        close,
        status: () => makeMemoryStatus({ custom: { automaticRebuildNotice: notice } }),
      });

      const error = spyRuntimeErrors(defaultRuntime);
      const writeJson = spyRuntimeJson(defaultRuntime);
      await expect(runMemoryCli(["search", "oops", "--json"])).rejects.toThrow(
        `Memory search failed: boom${rebuild ? ` ${warning}` : ""}`,
      );

      expect(search).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(writeJson).not.toHaveBeenCalled();
      expect(error.mock.calls).toEqual(
        closeFails ? [["Memory manager close failed: close boom"]] : [],
      );
    },
  );

  it("routes gateway secret diagnostics to stderr for json status output", async () => {
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: {},
      diagnostics: [inactiveMemorySecretDiagnostic],
    });
    mockStatusManager({ workspaceDir: undefined });
    const writeJson = spyRuntimeJson(defaultRuntime);
    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["status", "--json"]);
    expect(Array.isArray(firstWrittenJsonArg(writeJson))).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(inactiveMemorySecretDiagnostic));
  });

  it.each([
    { availability: "disabled", managerError: undefined, expectedExitCode: 0 },
    {
      availability: "failed",
      managerError: "fixture memory acquisition failed",
      expectedExitCode: 1,
    },
  ])(
    "reports unavailable search once ($availability)",
    async ({ managerError, expectedExitCode }) => {
      getMemorySearchManager.mockResolvedValueOnce({
        manager: null,
        ...(managerError ? { error: managerError } : {}),
      });
      const writeJson = spyRuntimeJson(defaultRuntime);
      const errors = spyRuntimeErrors(defaultRuntime);
      spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["search", "--query", "fixture query", "--json"]);
      expect(writeJson).toHaveBeenCalledTimes(1);
      expect(firstWrittenJsonArg(writeJson)).toEqual(
        managerError
          ? {
              agentId: "main",
              ok: false,
              error: {
                type: "cli_error",
                message: "memory search failed (main): fixture memory acquisition failed",
              },
            }
          : { agentId: "main", status: "disabled" },
      );
      expect(process.exitCode).toBe(expectedExitCode);
      expect(errors.mock.calls).toEqual(
        managerError ? [["memory search failed (main): fixture memory acquisition failed"]] : [],
      );
    },
  );

  it.each([
    { name: "all disabled", healthyOps: false, managerError: undefined, exitCode: 0 },
    {
      name: "one failed",
      healthyOps: true,
      managerError: "fixture memory acquisition failed",
      exitCode: 1,
    },
  ])(
    "keeps one aggregate JSON status document with $name",
    async ({ healthyOps, managerError, exitCode }) => {
      getRuntimeConfig.mockReturnValue(configuredAgents);
      const healthyStatus = makeMemoryStatus({ workspaceDir: undefined });
      const close = vi.fn(async () => {});
      getMemorySearchManager.mockImplementation(async ({ agentId }: { agentId: string }) =>
        healthyOps && agentId === "ops"
          ? { manager: { status: () => healthyStatus, close } }
          : { manager: null, ...(managerError ? { error: managerError } : {}) },
      );
      const writeJson = spyRuntimeJson(defaultRuntime);
      spyRuntimeErrors(defaultRuntime);
      spyRuntimeLogs(defaultRuntime);

      await runMemoryCli(["status", "--json"]);

      expect(writeJson).toHaveBeenCalledTimes(1);
      const output = firstWrittenJsonArg<Array<{ agentId: string; status: unknown }>>(writeJson);
      if (healthyOps) {
        expect(output).toHaveLength(1);
        expect(output).toMatchObject([{ agentId: "ops", status: healthyStatus }]);
        expect(close).toHaveBeenCalledTimes(1);
      } else {
        expect(output).toEqual([]);
      }
      expect(process.exitCode).toBe(exitCode);
    },
  );

  it("preserves disabled human output without adding JSON", async () => {
    const args = ["index"];
    getMemorySearchManager.mockResolvedValueOnce({ manager: null });

    const log = spyRuntimeLogs(defaultRuntime);
    const writeJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(args);

    expect(log).toHaveBeenCalledWith("Memory search disabled.");
    expect(writeJson).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("fails index --force when the memory index has orphaned provenance", async () => {
    const args = ["index", "--force"];
    const stateDir = path.join(fixtureRoot, `corrupt-state-${workspaceCaseId++}`);
    const workspaceDir = path.join(fixtureRoot, `corrupt-workspace-${workspaceCaseId++}`);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const databasePath = await seedMemoryIndexWithOrphanedProvenance(env);

    const cfg = {
      memory: {
        backend: "builtin",
        search: {
          provider: "none",
          model: "",
          rememberAcrossConversations: false,
          sources: ["memory"],
          store: { vector: { enabled: false } },
          cache: { enabled: false },
          query: { hybrid: { enabled: true } },
        },
      },
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: "main", default: true }],
      },
      plugins: { enabled: false },
    } as OpenClawConfig;
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    getRuntimeConfig.mockReturnValue(cfg);
    const actualMemory =
      await vi.importActual<typeof import("./memory/index.js")>("./memory/index.js");
    getMemorySearchManager.mockImplementation(actualMemory.getMemorySearchManager);

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(args);

    expect(resolveOpenClawAgentSqlitePath({ agentId: "main", env })).toBe(databasePath);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("SQLite foreign_key_check failed"));
  });

  it("logs backend unsupported message when index has no sync", async () => {
    mockStatusManager({});

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["index"]);

    expect(log).toHaveBeenCalledWith("Memory backend does not support manual reindex.");
  });

  it("rejects an empty --query override before acquisition", async () => {
    const writeJson = spyRuntimeJson(defaultRuntime);
    await expect(runMemoryCli(["search", "positional", "--query", "", "--json"])).rejects.toThrow(
      "Missing search query. Provide a positional query or use --query <text>.",
    );
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(writeJson).not.toHaveBeenCalled();
  });

  it.each([
    { args: ["forget", "--dry-run"], acquires: false, message: "Memory forget requires --session" },
    {
      args: ["promote-explain", "   "],
      acquires: false,
      message: "Memory promote-explain requires a non-empty selector.",
    },
    {
      args: ["promote-explain", "  unmatched fixture  "],
      acquires: true,
      message: 'No promotion candidate matched "unmatched fixture".',
    },
    {
      args: ["session-backfill", "--rollback", "--from", "2026-01-01"],
      acquires: true,
      message: "Memory session-backfill --rollback cannot be combined",
    },
    { args: ["rem-backfill"], acquires: true, message: "Memory rem-backfill requires --path" },
  ])(
    "propagates invalid memory input without a success report: $args",
    async ({ args, acquires, message }) => {
      const workspaceDir = await createWorkspace();
      const close = vi.fn(async () => {});
      if (acquires) {
        mockManager({ status: () => makeMemoryStatus({ workspaceDir }), close });
      }
      const writeJson = spyRuntimeJson(defaultRuntime);
      await expect(runMemoryCli([...args, "--json"])).rejects.toThrow(message);
      expect(writeJson).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(acquires ? 1 : 0);
      expect(getMemorySearchManager).toHaveBeenCalledTimes(acquires ? 1 : 0);
      expect(forgetMemoryEntries).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      operation: "forget",
      args: ["forget", "--session", "fixture-session", "--dry-run"],
      prefix: "Memory forget failed: ",
    },
    { operation: "rank", args: ["promote"], prefix: "Memory promote ranking failed: " },
    { operation: "apply", args: ["promote", "--apply"], prefix: "Memory promote apply failed: " },
    {
      operation: "rank",
      args: ["promote-explain", "fixture"],
      prefix: "Memory promote-explain failed: ",
    },
  ])(
    "propagates operation failure without a success report: $args",
    async ({ operation, args, prefix }) => {
      const workspaceDir = await createWorkspace();
      const failure = new Error("fixture operation rejected");
      if (operation === "forget") {
        forgetMemoryEntries.mockRejectedValueOnce(failure);
      } else {
        const promotion = await import("./short-term-promotion.js");
        if (operation === "rank") {
          vi.spyOn(promotion, "rankShortTermPromotionCandidates").mockRejectedValueOnce(failure);
        } else {
          vi.spyOn(promotion, "applyShortTermPromotions").mockRejectedValueOnce(failure);
        }
      }
      const close = vi.fn(async () => {});
      if (operation !== "forget") {
        mockManager({ status: () => makeMemoryStatus({ workspaceDir }), close });
      }
      const writeJson = spyRuntimeJson(defaultRuntime);
      await expect(runMemoryCli([...args, "--json"])).rejects.toThrow(
        `${prefix}${failure.message}`,
      );
      expect(writeJson).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(operation === "forget" ? 0 : 1);
    },
  );

  it("qualifies json search results when the index remains stale", async () => {
    const reason = "index was built for model old-embed, expected new-embed";
    mockStatusManager(
      {
        dirty: true,
        custom: {
          indexIdentity: { status: "mismatched", reason, code: "model", owner: "configuration" },
        },
      },
      { search: vi.fn(async () => []) },
    );

    const writeJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["search", "hidden codeword", "--agent", "main", "--json"]);

    expect(getRuntimeConfig).toHaveBeenCalledWith({ skipPluginValidation: true });

    expect(firstWrittenJsonArg(writeJson)).toEqual({
      results: [],
      stale: true,
      warning: `Memory index is stale: ${reason} (owner: configuration, code: model). Search results may be incomplete.`,
      action:
        "Run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.",
    });
  });

  it("prints no candidates when promote has no short-term recall data", async () => {
    const workspaceDir = await createWorkspace();
    mockWorkspaceManager(workspaceDir);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["promote"]);

    expect(log).toHaveBeenCalledWith("No short-term recall candidates.");
    expect(process.exitCode).toBe(0);
  });

  it("explains a specific promote candidate as json", async () => {
    const workspaceDir = await createWorkspace();
    await recordRecall(
      workspaceDir,
      "router notes",
      recallResult("memory/2026-04-03.md", "Configured VLAN 10 for IoT on router", {
        startLine: 4,
        endLine: 8,
        score: 0.86,
      }),
    );

    mockWorkspaceManager(workspaceDir);

    const writeJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["promote-explain", "  router  ", "--json", "--include-promoted"]);

    const payload = firstWrittenJsonArg<{ candidate?: { snippet?: string } }>(writeJson);
    expect(payload?.candidate?.snippet).toContain("Configured VLAN 10");
  });

  it.each([false, true])(
    "previews live recall candidates with rem-harness (json=%s)",
    async (json) => {
      const workspaceDir = await createWorkspace();
      const nowMs = Date.now();
      const isoDay = new Date(nowMs).toISOString().slice(0, 10);
      const snippet = "Always check weather before suggesting outdoor plans.";
      await writeDailyMemoryNote(workspaceDir, isoDay, [snippet]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "weather plans",
        nowMs,
        results: [
          recallResult(`memory/${isoDay}.md`, snippet, { score: 0.92, startLine: 2, endLine: 3 }),
        ],
      });
      const close = mockWorkspaceManager(workspaceDir);
      const writeJson = spyRuntimeJson(defaultRuntime);
      const log = spyRuntimeLogs(defaultRuntime);

      await runMemoryCli(["rem-harness", ...(json ? ["--json"] : [])]);

      if (json) {
        const payload = firstWrittenJsonArg<{
          rem: { candidateTruths: Array<{ snippet: string }> };
          deep: { candidates: Array<{ snippet: string }> };
        }>(writeJson);
        expect(payload?.rem.candidateTruths[0]?.snippet).toContain("Always check weather");
        expect(payload?.deep.candidates[0]?.snippet).toContain("Always check weather");
        expect(log).not.toHaveBeenCalled();
      } else {
        expectLogged(log, "REM Harness");
        expectLogged(log, "recentRecallEntries=1 deepCandidates=1");
        expectLogged(log, snippet);
        expectLogged(log, `[memory/${isoDay}.md:2-3]`);
        expect(writeJson).not.toHaveBeenCalled();
      }
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("previews rem harness output from a slugged historical daily file path (#69536)", async () => {
    const workspaceDir = await createWorkspace();
    const historyPath = await writeHistory(workspaceDir, "2025-01-01-vendor-pitch.md", [
      "## Preferences Learned",
      '- Always use "Happy Together" calendar for flights and reservations.',
      "- Calendar ID: udolnrooml2f2ha8jaio24v1r8@group.calendar.google.com",
    ]);

    mockWorkspaceManager(workspaceDir);

    const writeJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["rem-harness", "--json", "--path", historyPath]);

    const payload = firstWrittenJsonArg<{
      sourceFiles?: string[];
      historicalImport?: { importedFileCount?: number; importedSignalCount?: number } | null;
      deep?: { candidates?: Array<{ snippet?: string; path?: string }> };
    }>(writeJson);
    expect(payload?.sourceFiles).toEqual([historyPath]);
    expect(payload?.historicalImport?.importedFileCount).toBe(1);
    expect(payload?.historicalImport?.importedSignalCount).toBeGreaterThan(0);
    const calendarCandidate = payload?.deep?.candidates?.find((candidate) =>
      candidate.snippet?.includes("Happy Together"),
    );
    expect(calendarCandidate?.path).toBe("memory/2025-01-01-vendor-pitch.md");
  });

  it("picks up slugged daily memory files for rem-backfill (#69536)", async () => {
    const workspaceDir = await createWorkspace();
    const historyDir = path.join(workspaceDir, "history");
    await fs.mkdir(historyDir, { recursive: true });
    const sluggedPath = path.join(historyDir, "2025-01-01-vendor-pitch.md");
    const secondSluggedPath = path.join(historyDir, "2025-01-01-travel-rule.md");
    await fs.writeFile(
      sluggedPath,
      [
        "## Preferences Learned",
        '- Always use "Happy Together" calendar for flights and reservations.',
      ].join("\n") + "\n",
      "utf-8",
    );
    await fs.writeFile(
      secondSluggedPath,
      ["## Preferences Learned", "- Always book aisle seats for red-eye flights."].join("\n") +
        "\n",
      "utf-8",
    );

    mockWorkspaceManager(workspaceDir);

    const errors = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["rem-backfill", "--path", historyDir]);

    expect(
      errors.mock.calls.some((call) => String(call[0]).includes("found no YYYY-MM-DD.md files")),
    ).toBe(false);
    const dreams = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(dreams).toContain(`source=${sluggedPath}`);
    expect(dreams).toContain(`source=${secondSluggedPath}`);
    expect(dreams).toContain("Happy Together");
    expect(dreams).toContain("aisle seats");
  });

  it("rejects missing historical input without allocating scratch", async () => {
    const workspaceDir = await createWorkspace();
    const close = mockWorkspaceManager(workspaceDir);
    const allocate = vi.spyOn(fs, "mkdtemp");
    const writeJson = spyRuntimeJson(defaultRuntime);
    await expect(
      runMemoryCli(["rem-harness", "--path", path.join(workspaceDir, "missing-history"), "--json"]),
    ).rejects.toThrow("Memory rem-harness found no YYYY-MM-DD.md files");
    expect(allocate).not.toHaveBeenCalled();
    expect(writeJson).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { command: "rem-harness", json: false },
    { command: "rem-backfill", json: true },
  ] as const)(
    "publishes $command success only after scratch cleanup",
    async ({ command, json }) => {
      await withHistoricalCliFixture(command, async ({ historyPath, scratchDirectory, close }) => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const actualRm = fs.rm;
        const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
          if (target === scratchDirectory()) {
            entered.resolve();
            await release.promise;
          }
          await actualRm(target, options);
        });
        const writeJson = spyRuntimeJson(defaultRuntime);
        const log = spyRuntimeLogs(defaultRuntime);
        const outcome = runMemoryCli([
          command,
          "--path",
          historyPath,
          ...(json ? ["--json"] : []),
        ]).then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        try {
          await Promise.race([
            entered.promise,
            outcome.then((result) => {
              throw new Error("Command settled before scratch cleanup", { cause: result });
            }),
          ]);
          expect(writeJson).not.toHaveBeenCalled();
          expect(log).not.toHaveBeenCalled();
          expect(close).not.toHaveBeenCalled();
          release.resolve();
          expect(await outcome).toEqual({ status: "fulfilled" });
          if (json) {
            expect(writeJson).toHaveBeenCalledTimes(1);
            expect(firstWrittenJsonArg(writeJson)).toMatchObject({ sourceFiles: [historyPath] });
            expect(log).not.toHaveBeenCalled();
          } else {
            expect(writeJson).not.toHaveBeenCalled();
            expectLogged(log, "REM Harness");
          }
          expect(scratchDirectory()).toBeDefined();
          await expectPathMissing(scratchDirectory()!);
          expect(close).toHaveBeenCalledTimes(1);
        } finally {
          release.resolve();
          await outcome;
          remove.mockRestore();
        }
      });
    },
  );

  it("rejects scratch cleanup without publishing success even when manager close fails", async () => {
    await withHistoricalCliFixture(
      "rem-backfill",
      async ({ historyPath, scratchDirectory, close }) => {
        const failure = new Error("fixture scratch cleanup rejected");
        close.mockRejectedValueOnce(new Error("close boom"));
        const actualRm = fs.rm;
        const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
          if (target === scratchDirectory()) {
            throw failure;
          }
          await actualRm(target, options);
        });
        const writeJson = spyRuntimeJson(defaultRuntime);
        const log = spyRuntimeLogs(defaultRuntime);
        const errors = spyRuntimeErrors(defaultRuntime);
        try {
          await expect(
            runMemoryCli(["rem-backfill", "--path", historyPath, "--json"]),
          ).rejects.toBe(failure);
          expect(writeJson).not.toHaveBeenCalled();
          expect(log).not.toHaveBeenCalled();
          expect(close).toHaveBeenCalledTimes(1);
          expect(errors.mock.calls).toEqual([["Memory manager close failed: close boom"]]);
        } finally {
          remove.mockRestore();
        }
      },
    );
  });

  it("cleans allocated scratch when preparing historical input fails", async () => {
    await withHistoricalCliFixture(
      "rem-harness",
      async ({ historyPath, scratchDirectory, close }) => {
        const failure = Object.assign(new Error("fixture mkdir rejected"), { code: "EIO" });
        const actualMkdir = fs.mkdir;
        let faultObserved = false;
        vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
          const scratchDir = scratchDirectory();
          if (scratchDir && target === path.join(scratchDir, "memory")) {
            faultObserved = true;
            throw failure;
          }
          return actualMkdir(target, options);
        });
        const writeJson = spyRuntimeJson(defaultRuntime);
        await expect(runMemoryCli(["rem-harness", "--path", historyPath, "--json"])).rejects.toBe(
          failure,
        );
        expect(faultObserved).toBe(true);
        expect(writeJson).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
        expect(scratchDirectory()).toBeDefined();
        await expectPathMissing(scratchDirectory()!);
      },
    );
  });

  it("rolls back grounded staged short-term entries without touching diary rollback", async () => {
    const workspaceDir = await createWorkspace();
    const historyPath = await writeHistory(workspaceDir, "2025-01-01.md", [
      "## Preferences Learned",
      '- Always use "Happy Together" calendar for flights and reservations.',
    ]);

    const close = mockWorkspaceManager(workspaceDir);

    await runMemoryCli(["rem-backfill", "--path", historyPath, "--stage-short-term"]);
    const staged = await readShortTermRecallEntries({ workspaceDir });
    expect(staged).toHaveLength(1);
    expect(staged[0]?.snippet).toContain("Happy Together");
    expect(staged[0]?.groundedCount).toBe(3);
    expect(staged[0]?.queryHashes).toHaveLength(2);
    expect(staged[0]?.recallCount).toBe(0);
    mockManager({
      status: () => makeMemoryStatus({ workspaceDir }),
      close,
    });
    await runMemoryCli(["rem-backfill", "--rollback-short-term"]);

    const entries = await readShortTermRecallEntries({ workspaceDir });
    expect(entries).toHaveLength(0);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("prefers persistence-relevant evidence over narrated operational logs in grounded what happened", async () => {
    const workspaceDir = await createWorkspace();
    const historyPath = await writeHistory(workspaceDir, "2025-03-30.md", [
      "## OpenClaw / runtime / workflow preferences and corrections",
      "- Mariano explicitly said that when he tells Razor there has been an error, the default interpretation should be that he wants it fixed, not merely diagnosed or acknowledged.",
      "- Mariano clarified that the problem with cron output is overlapping, independently unreasonable crons converging into dumb sludge.",
      "",
      "## Versions / machine state and update work",
      "- MB Server repo updated but the active installed runtime is still old.",
      "- jpclawhq updated and running.",
      "",
      "## Other context and user preferences reinforced in this session",
      "- Mariano prefers short, punk, high-signal copy for social posts.",
      "- He explicitly wants the assistant to treat ADHD as a reason to reduce clutter and noise, not to produce more summaries.",
    ]);

    const file = await previewGroundedHistory(workspaceDir, historyPath);
    const rendered = file?.renderedMarkdown ?? "";
    expect(rendered).toContain("prefers short, punk, high-signal copy");
    expect(rendered).not.toContain(
      "MB Server repo updated but the active installed runtime is still old",
    );
    expect(rendered).not.toContain("jpclawhq updated and running");
  });

  it("suppresses monitoring-heavy operational days instead of promoting alert sludge", async () => {
    const workspaceDir = await createWorkspace();
    const historyPath = await writeHistory(workspaceDir, "2025-02-17.md", [
      "## Heartbeat checks",
      "- 04:17 (Europe/Madrid) heartbeat run.",
      "- Ariston check returned warning/error:",
      "  - Pressure LOW: 1.1 bar",
      "- Action: alert Mariano on this heartbeat.",
      "",
      "## 07:15 life-context sync (travel + now)",
      "- mariano@tpmcap.com calendar access failed (invalid_grant: token expired/revoked).",
      "- memory/email-tracker.json checkpoint at 2025-02-17T07:03:53+01:00.",
      "- memory/travel.md updated.",
      "",
      "## Heartbeat checks (07:18)",
      "- Ariston check again reports low pressure: 1.1 bar.",
      "- collect-temps.sh completed OK (exit 0).",
    ]);

    const file = await previewGroundedHistory(workspaceDir, historyPath);
    const rendered = file?.renderedMarkdown ?? "";
    expect(rendered).toContain("No grounded facts were extracted.");
    expect(rendered).toContain("mostly as monitoring and operational state");
    expect(rendered).not.toContain("Pressure LOW");
    expect(rendered).not.toContain("invalid_grant");
  });

  it("splits multi-fact person lines into atomic grounded candidates", async () => {
    const workspaceDir = await createWorkspace();
    const historyPath = await writeHistory(workspaceDir, "2025-02-19.md", [
      "## People mentioned with context",
      "- Bunji — partner, Surrealist Ball Sat 28 Feb w/ Maga",
      "- Bex — girlfriend, date weekend Fri-Sun London, Chateau Denmark",
      "",
      "## Process improvements",
      "- Routed several inbound requests into different workflows.",
      "- Important context was written into notes and memory surfaces.",
    ]);

    const file = await previewGroundedHistory(workspaceDir, historyPath);
    const rendered = file?.renderedMarkdown ?? "";
    expect(rendered).toContain(
      "People mentioned with context: Bunji — partner, Surrealist Ball Sat 28 Feb w/ Maga",
    );
    expect(rendered).toContain("Bex — girlfriend, date weekend Fri-Sun London, Chateau Denmark");
    expect(rendered).toContain("Bunji — partner");
    expect(rendered).toContain("Bex — girlfriend");
    expect(rendered).not.toContain("Bunji — Surrealist Ball Sat 28 Feb w/ Maga [");
    expect(rendered).not.toContain("Bex — date weekend Fri-Sun London, Chateau Denmark");
    expect(
      file?.reflections?.some((item) =>
        item.text.includes("More than one active relationship thread"),
      ),
    ).toBe(true);
    expect(
      file?.reflections?.some((item) =>
        item.text.includes("converting messy inbound information into routed workflows"),
      ),
    ).toBe(false);
  });

  it("rolls back grounded rem backfill entries from DREAMS.md", async () => {
    const workspaceDir = await createWorkspace();
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "---",
        "",
        "*April 5, 2026, 3:00 AM*",
        "",
        "Keep this normal dream.",
        "",
        "---",
        "",
        "*January 1, 2025*",
        "",
        "<!-- openclaw:dreaming:backfill-entry day=2025-01-01 source=memory/2025-01-01.md -->",
        "",
        "What Happened",
        "1. Remove this entry.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    mockWorkspaceManager(workspaceDir);

    await runMemoryCli(["rem-backfill", "--rollback"]);

    const dreams = await fs.readFile(dreamsPath, "utf-8");
    expect(dreams).toContain("Keep this normal dream.");
    expect(dreams).not.toContain("Remove this entry.");
  });

  it("honors the configured prior-entry loss limit during CLI promotion", async () => {
    const workspaceDir = await createWorkspace();
    const promotionSection = (date: string, index: number) =>
      [
        `## Promoted From Short-Term Memory (${date})`,
        `<!-- openclaw-memory-promotion:legacy-${index} -->`,
        `- ${"x".repeat(350)}`,
        "",
      ].join("\n");
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      [0, 1, 2, 3]
        .map((index) => promotionSection(`2026-04-${String(index + 1).padStart(2, "0")}`, index))
        .join("\n"),
      "utf-8",
    );
    await writeDailyMemoryNote(workspaceDir, "2026-04-10", ["Retain the release checklist."]);
    await recordRecall(
      workspaceDir,
      "release checklist",
      recallResult("memory/2026-04-10.md", "Retain the release checklist."),
    );
    getRuntimeConfig.mockReturnValue({
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir, bootstrapMaxChars: 1_400 }],
      },
      plugins: {
        entries: {
          "memory-core": {
            config: { dreaming: { phases: { deep: { maxPriorEntryLossFraction: 1 } } } },
          },
        },
      },
    });
    const close = vi.fn(async () => {});
    mockManager({ status: () => makeMemoryStatus({ workspaceDir }), close });

    await runMemoryCli(["promote", "--apply", ...unrestrictedPromotion]);

    const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memory).toContain("Retain the release checklist.");
    expect(memory.length).toBeLessThanOrEqual(1_400);
  });

  it.runIf(process.platform !== "win32")(
    "uses the smallest bootstrap cap across CLI workspace symlink aliases",
    async () => {
      const workspaceDir = await createWorkspace();
      const workspaceAliasDir = `${workspaceDir}-alias`;
      await fs.symlink(workspaceDir, workspaceAliasDir, "dir");
      const existingMemory = `# Long-Term Memory\n\n${"x".repeat(9_100)}\n`;
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), existingMemory, "utf-8");
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Shared workspace fact."]);
      await recordShortTermRecalls({
        workspaceDir: workspaceAliasDir,
        query: "shared workspace",
        results: [recallResult("memory/2026-04-01.md", "Shared workspace fact.")],
      });
      getRuntimeConfig.mockReturnValue({
        agents: {
          list: [
            {
              id: "alpha",
              default: true,
              workspace: workspaceDir,
              bootstrapMaxChars: 9_000,
            },
            { id: "beta", workspace: workspaceAliasDir, bootstrapMaxChars: 12_000 },
          ],
        },
      });
      mockStatusManager({ workspaceDir: workspaceAliasDir });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli([
        "promote",
        "--agent",
        "beta",
        "--apply",
        "--json",
        ...unrestrictedPromotion,
      ]);

      const payload = firstWrittenJsonArg<{
        candidates: unknown[];
        apply: { appliedCandidates: unknown[]; rejectedCandidates: Array<{ reason: string }> };
      }>(writeJson);
      expect(payload?.candidates).toHaveLength(1);
      expect(payload?.apply.appliedCandidates).toEqual([]);
      expect(payload?.apply.rejectedCandidates).toEqual([
        expect.objectContaining({ reason: expect.stringContaining("budget") }),
      ]);
      expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8")).toBe(existingMemory);
    },
  );

  it("names apply-time rejections without ranking blocked origins", async () => {
    const workspaceDir = await createWorkspace();
    const relativePath = "memory/2026-04-02.md";
    await writeDailyMemoryNote(workspaceDir, "2026-04-02", [
      "Untrusted router note must not become durable memory.",
      "Rare trusted note remains below the apply signal threshold.",
      "Durable action note.",
    ]);
    await recordShortTermRecalls({
      workspaceDir,
      query: "router note",
      results: [
        recallResult(relativePath, "Untrusted router note must not become durable memory.", {
          score: 0.99,
          provenance: {
            originClass: "untrusted",
            sessionKind: "interactive",
            observedAt: Date.now(),
          },
        }),
        recallResult(relativePath, "Rare trusted note remains below the apply signal threshold.", {
          line: 2,
          score: 0.99,
        }),
        recallResult(relativePath, "Durable action note.", {
          line: 3,
          score: 0.99,
        }),
      ],
    });
    await recordRecall(
      workspaceDir,
      "durable action",
      recallResult(relativePath, "Durable action note.", {
        line: 3,
        score: 0.99,
      }),
    );
    await writeDailyMemoryNote(workspaceDir, "2026-04-02", [
      "Untrusted router note must not become durable memory.",
      "Rare trusted note remains below the apply signal threshold.",
      "Candidate: Durable action note. confidence: 0.90 evidence: memory/.dreams/session-corpus/day.txt:1-1 recalls: 3 status: staged",
    ]);
    const manager = {
      status: () => makeMemoryStatus({ workspaceDir }),
      close: vi.fn(async () => {}),
    };
    mockManager(manager);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli([
      "promote",
      "--apply",
      "--min-score",
      "0",
      "--min-recall-count",
      "2",
      "--min-unique-queries",
      "0",
    ]);

    expectNotLogged(log, `${relativePath}:1-1`);
    expectLogged(log, `Skipped ${relativePath}:2-2: signal threshold (1 < 2).`);
    expectLogged(log, `Skipped ${relativePath}:3-3: contamination filter after rehydration.`);
    expectNotLogged(log, "No candidates met apply criteria.");
  });

  it("keeps preview limits available and preserves mixed apply output order", async () => {
    const workspaceDir = await createWorkspace();
    const relativePath = "memory/2026-04-03.md";
    await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
      "High-score untrusted candidate.",
      "Lower-score trusted candidate.",
      "High-score rare trusted candidate.",
    ]);
    await recordShortTermRecalls({
      workspaceDir,
      query: "candidate order",
      results: [
        recallResult(relativePath, "High-score untrusted candidate.", {
          score: 0.99,
          provenance: {
            originClass: "untrusted",
            sessionKind: "interactive",
            observedAt: Date.now(),
          },
        }),
        recallResult(relativePath, "Lower-score trusted candidate.", {
          line: 2,
          score: 0.01,
        }),
      ],
    });
    await recordRecall(
      workspaceDir,
      "trusted candidate",
      recallResult(relativePath, "Lower-score trusted candidate.", {
        line: 2,
        score: 0.01,
      }),
    );
    const manager = {
      status: () => makeMemoryStatus({ workspaceDir }),
      close: vi.fn(async () => {}),
    };
    const args = ["promote", "--min-score", "0", "--min-unique-queries", "0"];

    mockManager(manager);
    const writeJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli([...args, "--limit", "1", "--min-recall-count", "0", "--json"]);
    const preview = firstWrittenJsonArg<{ candidates: Array<{ startLine: number }> }>(writeJson);
    expect(preview?.candidates.map((candidate) => candidate.startLine)).toEqual([2]);

    await recordRecall(
      workspaceDir,
      "rare candidate",
      recallResult(relativePath, "High-score rare trusted candidate.", {
        line: 3,
        score: 0.99,
        provenance: { originClass: "owner", sessionKind: "interactive", observedAt: Date.now() },
      }),
    );
    const applyArgs = [...args, "--apply", "--limit", "2", "--min-recall-count", "2"];
    writeJson.mockClear();
    mockManager(manager);
    await runMemoryCli([...applyArgs, "--json"]);
    const payload = firstWrittenJsonArg<{
      candidates: Array<{ startLine: number }>;
      apply: {
        appliedCandidates: Array<{ startLine: number }>;
        rejectedCandidates: Array<{ candidate: { startLine: number } }>;
      };
    }>(writeJson);
    expect(payload?.candidates.map((candidate) => candidate.startLine)).toEqual([3, 2]);
    expect(payload?.apply.appliedCandidates.map((candidate) => candidate.startLine)).toEqual([2]);
    expect(
      payload?.apply.rejectedCandidates.map((rejection) => rejection.candidate.startLine),
    ).toEqual([3]);

    const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(memory).toContain("Lower-score trusted candidate.");
    expect(memory).not.toContain("High-score untrusted candidate.");
    expect(memory).not.toContain("High-score rare trusted candidate.");

    const store = await shortTermTesting.readRecallStore(workspaceDir, new Date().toISOString());
    for (const entry of Object.values(store.entries)) {
      delete entry.promotedAt;
    }
    await shortTermTesting.writeRawRecallStore(workspaceDir, store);
    await fs.rm(path.join(workspaceDir, "MEMORY.md"), { force: true });

    mockManager(manager);
    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(applyArgs);
    const output = loggedOutput(log);
    expect(output).not.toContain(`${relativePath}:1-1`);
    const rejectedIndex = output.indexOf(`${relativePath}:3-3`);
    const appliedIndex = output.indexOf(`${relativePath}:2-2`);
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);
    expect(rejectedIndex).toBeLessThan(appliedIndex);
  });

  it("prints conceptual promotion signals across recall days", async () => {
    const workspaceDir = await createWorkspace();
    const dayMs = 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    const snippet = "Configured router VLAN 10 and Glacier backup notes for vectors.";
    for (const [query, daysAgo, score] of [
      ["router vlan", 2, 0.9],
      ["glacier backup", 1, 0.88],
    ] as const) {
      await recordShortTermRecalls({
        workspaceDir,
        query,
        nowMs: nowMs - daysAgo * dayMs,
        results: [
          recallResult("memory/2026-04-01.md", snippet, { startLine: 4, endLine: 8, score }),
        ],
      });
    }
    const close = mockWorkspaceManager(workspaceDir);
    const log = spyRuntimeLogs(defaultRuntime);

    await runMemoryCli(["promote", ...unrestrictedPromotion]);

    expectLogged(log, "recalls=2 avg=0.890 queries=2 age=1.0d consolidate=0.30 conceptual=1.00");
    expectLogged(log, "concepts=backup, glacier, router, vlan, configured, vectors");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    { enabled: true, json: true },
    { enabled: false, json: true },
    { enabled: false, json: false },
  ])(
    "records search recalls only when dreaming is enabled (enabled=$enabled, json=$json)",
    async ({ enabled, json }) => {
      const workspaceDir = await createWorkspace();
      const result = recallResult("memory/2026-04-03.md", "Move backups to S3 Glacier.", {
        endLine: 2,
      });
      const search = vi.fn(async () => [result]);
      setDreaming({ enabled });
      mockStatusManager({ workspaceDir }, { search });
      const writeJson = spyRuntimeJson(defaultRuntime);
      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["search", "glacier", ...(json ? ["--json"] : [])]);
      if (json) {
        expect(firstWrittenJsonArg(writeJson)).toEqual({
          results: [expect.objectContaining({ path: "memory/2026-04-03.md" })],
        });
      } else {
        expectLogged(log, "0.910 memory/2026-04-03.md:1-2");
        expectLogged(log, "Move backups to S3 Glacier.");
        expect(writeJson).not.toHaveBeenCalled();
      }
      const entries = await readShortTermRecallEntries({ workspaceDir });
      if (enabled) {
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
          snippet: "Move backups to S3 Glacier.",
          recallCount: 1,
          totalScore: 0.91,
          provenance: { originClass: "agent", sessionKind: "unknown" },
        });
      } else {
        expect(entries).toHaveLength(0);
      }
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
