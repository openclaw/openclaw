import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveSessionTranscriptsDirForAgent as resolveTestSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  firstWrittenJsonArg as jsonValue,
  spyRuntimeErrors,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { openMemoryCoreStateStore } from "./dreaming-state.js";
import type { MemoryForgetReport } from "./memory-forget-report.js";
import type { GroundedRemPreviewResult } from "./rem-evidence.js";
import {
  readShortTermRecallEntries as readRecalls,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  createMemoryCoreTestHarness,
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
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function seedCliBackfillTranscript(
  sessionId: string,
  days: string[],
  metadata: Partial<Parameters<typeof upsertSessionEntry>[0]["entry"]> = {},
): Promise<void> {
  setRuntimeConfigSnapshot(getRuntimeConfig());
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
  resolveDefaultAgentId,
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => {
    const cfg = getRuntimeConfig();
    setRuntimeConfigSnapshot(cfg);
    return cfg;
  },
}));

let registerMemoryCli: typeof import("./cli.js").registerMemoryCli;
let defaultRuntime: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").defaultRuntime;
let setVerbose: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").setVerbose;
let fixtureRoot = "";
let workspaceFixtureRoot = "";
let workspaceCaseId = 0;

const { createTempWorkspace } = createMemoryCoreTestHarness();

beforeAll(async () => {
  ({ registerMemoryCli } = await import("./cli.js"));
  ({ defaultRuntime, setVerbose } =
    await import("openclaw/plugin-sdk/memory-core-host-runtime-cli"));
  fixtureRoot = await createTempWorkspace("memory-cli-fixtures-");
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
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  setVerbose(false);
});

const inactiveMemorySecretDiagnostic = "memory.search.remote.apiKey inactive"; // pragma: allowlist secret

function setDreaming(dreaming: Record<string, unknown>) {
  getRuntimeConfig.mockReturnValue(memoryCoreConfig({ dreaming }));
}

function memoryStatus(overrides: Record<string, unknown> = {}) {
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
  getMemorySearchManager.mockResolvedValueOnce({ manager });
}

function mockStatus(
  overrides: Record<string, unknown> | (() => Record<string, unknown>),
  methods: Record<string, unknown> = {},
) {
  mockManager({
    status: () => memoryStatus(typeof overrides === "function" ? overrides() : overrides),
    close: vi.fn(async () => {}),
    ...methods,
  });
}

function workspaceManager(workspaceDir: string) {
  return { status: () => memoryStatus({ workspaceDir }), close: vi.fn(async () => {}) };
}

function mockWorkspace(workspaceDir: string) {
  const manager = workspaceManager(workspaceDir);
  mockManager(manager);
  return manager.close;
}

function loggedOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return stripVTControlCharacters(
    spy.mock.calls
      .map((call: unknown[]) => (typeof call[0] === "string" ? call[0] : ""))
      .join("\n"),
  );
}

function expectLogged(spy: ReturnType<typeof vi.spyOn>, ...expected: string[]) {
  const output = loggedOutput(spy);
  for (const text of expected) {
    expect(output).toContain(text);
  }
}

function expectNotLogged(spy: ReturnType<typeof vi.spyOn>, expected: string) {
  expect(loggedOutput(spy)).not.toContain(expected);
}

function captureOutput() {
  return {
    json: spyRuntimeJson(defaultRuntime),
    log: spyRuntimeLogs(defaultRuntime),
  };
}

async function run(args: string[] | string, hostOptions?: Parameters<typeof registerMemoryCli>[1]) {
  const program = new Command().name("test");
  registerMemoryCli(program, hostOptions);
  // Arrays preserve whitespace-bearing values; strings are unquoted fixture argv.
  const argv = typeof args === "string" ? args.split(" ") : args;
  await program.parseAsync(["memory", ...argv], { from: "user" });
}

const unrestrictedPromotion = ["--min-score", "--min-recall-count", "--min-unique-queries"].flatMap(
  (flag) => [flag, "0"],
);

const configuredAgents = {
  agents: { ownership: "explicit" as const, entries: { main: {}, ops: {} } },
};

function indexConfig(workspace: string, search: Record<string, unknown> = {}): OpenClawConfig {
  return {
    agents: { defaults: { workspace }, entries: { main: {} } },
    memory: {
      search: {
        provider: "none",
        sources: ["memory"],
        store: { vector: { enabled: false } },
        ...search,
      },
    },
    plugins: { enabled: false },
  };
}

async function useRealManager() {
  const memory = await vi.importActual<typeof import("./memory/index.js")>("./memory/index.js");
  getMemorySearchManager.mockImplementation(memory.getMemorySearchManager);
  return memory;
}

function setMemorySecret(id: string) {
  getRuntimeConfig.mockReturnValue({
    memory: { search: { remote: { apiKey: { source: "env", provider: "default", id } } } },
  });
}

it("resets and rebuilds the real index without changing canonical session bytes or other owners", async () => {
  const stateDir = path.join(fixtureRoot, `reset-state-${workspaceCaseId++}`);
  const workspaceDir = path.join(fixtureRoot, `reset-workspace-${workspaceCaseId++}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "MEMORY.md"),
    "# Memory\nThe observatory uses a copper telescope.\n",
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const cfg = indexConfig(workspaceDir);
  getRuntimeConfig.mockReturnValue(cfg);
  await seedCliBackfillTranscript("reset-survivor", ["2026-01-01"]);
  const actualMemory = await useRealManager();
  await run("index --agent main");
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
    ).filter(({ name }) => !name.startsWith("memory_index_") && name !== "memory_embedding_cache");
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
        .prepare("SELECT path, text, embedding FROM memory_index_chunks ORDER BY path, start_line")
        .all();
    const beforeIndex = indexedContent();
    expect(beforeIndex.some((row) => String(row.text).includes("copper telescope"))).toBe(true);
    await run("reset --agent main --yes");
    expect(pendingInputSchema()).toEqual(beforePendingInputSchema);
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get()).toEqual({
      count: 0,
    });
    expect(snapshot()).toEqual(before);
    await run("index --agent main");
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
  await expect(run("reset")).rejects.toThrow("--yes");
  const log = spyRuntimeLogs(defaultRuntime);
  await run("reset --yes");
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
    curatedWrites: [{ relativePath: "MEMORY.md", observedAt: Date.parse("2026-08-25T12:00:00Z") }],
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
  await run(
    "forget --session session-one --session session-two --hook-source gmail --hook-source email --participant person-one --participant person-two --since 2026-01-01 --agent ops --dry-run --json",
  );
  expect(forgetMemoryEntries).toHaveBeenCalledWith({
    cfg: configuredAgents,
    agentId: "ops",
    sessionIds: ["session-one", "session-two"],
    hookSources: ["gmail", "email"],
    participants: ["person-one", "person-two"],
    since: "2026-01-01",
    dryRun: true,
  });
  expect(jsonValue(json)).toEqual(report);
  forgetMemoryEntries.mockResolvedValueOnce(report);
  const logs = spyRuntimeLogs(defaultRuntime);
  await run("forget --session session-one --agent ops --dry-run");
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
  ["nope-zzz", 'Unknown agent id "nope-zzz". Run openclaw agents list to see configured agents.'],
  ["", "--agent must not be blank"],
])("rejects invalid explicit agent %j before acquisition", async (agentId, message) => {
  getRuntimeConfig.mockReturnValue(configuredAgents);
  await expect(run(["status", "--agent", agentId])).rejects.toThrow(message);
  expect(getMemorySearchManager).not.toHaveBeenCalled();
});

it("drains admitted session backfill in one apply command before preview", async () => {
  const workspaceDir = path.join(workspaceFixtureRoot, `session-backfill-${workspaceCaseId++}`);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(workspaceDir, "openclaw.json"));
  await fs.mkdir(workspaceDir, { recursive: true });
  getRuntimeConfig.mockReturnValue(
    memoryCoreConfig({
      memoryPolicy: { excludeSessions: { channels: ["discord"] } },
    }),
  );
  await seedCliBackfillTranscript("drain", ["2026-01-01", "2026-01-02", "2026-01-03"]);
  await seedCliBackfillTranscript("excluded", ["2026-01-04"], {
    delivery: normalizeSessionDeliveryState({
      context: { channel: "discord", to: "channel:admission-fixture" },
      origin: { provider: "discord", to: "channel:admission-fixture" },
    }),
  });
  mockWorkspace(workspaceDir);
  const applyJson = spyRuntimeJson(defaultRuntime);
  await run("session-backfill --agent main --limit-days 1 --apply --json");
  expect(jsonValue(applyJson)).toMatchObject({
    batchCount: 3,
    candidateCount: 3,
    batches: [{ candidates: 1 }, { candidates: 1 }, { candidates: 1 }],
  });
  mockWorkspace(workspaceDir);
  applyJson.mockClear();
  await run("session-backfill --agent main --limit-days 1 --json");
  expect(jsonValue(applyJson)).toMatchObject({
    candidateCount: 0,
  });
});

it("rejects invalid memory numeric options before acquisition", async () => {
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerMemoryCli(program);
  await expect(
    program.parseAsync(["memory", "search", "hello", "--min-score", "0x1"], { from: "user" }),
  ).rejects.toThrow("--min-score must be a finite number.");
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

async function recordRecall(
  workspaceDir: string,
  query: string,
  result: RecallResult | RecallResult[],
  nowMs?: number,
) {
  await recordShortTermRecalls({
    workspaceDir,
    query,
    results: Array.isArray(result) ? result : [result],
    nowMs,
  });
}

async function dailyRecallFixture(
  workspaceDir: string,
  day: string,
  rows: ReadonlyArray<
    readonly [string, number, NonNullable<RecallResult["provenance"]>["originClass"]?]
  >,
) {
  const memoryPath = `memory/${day}.md`;
  await writeDailyMemoryNote(
    workspaceDir,
    day,
    rows.map(([snippet]) => snippet),
  );
  return {
    memoryPath,
    recall: (query: string, ...lines: number[]) =>
      recordRecall(
        workspaceDir,
        query,
        lines.map((line) => {
          const [snippet, score, originClass] = rows[line - 1]!;
          return recallResult(memoryPath, snippet, {
            line,
            score,
            ...(originClass
              ? { provenance: { originClass, sessionKind: "interactive", observedAt: Date.now() } }
              : {}),
          });
        }),
      ),
  };
}

async function writeDailyMemoryNote(
  workspaceDir: string,
  date: string,
  lines: string[],
): Promise<void> {
  const notePath = path.join(workspaceDir, "memory", `${date}.md`);
  await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
}

async function writeHistory(workspaceDir: string, name: string, lines: readonly string[]) {
  const historyDir = path.join(workspaceDir, "history");
  await fs.mkdir(historyDir, { recursive: true });
  const historyPath = path.join(historyDir, name);
  await fs.writeFile(historyPath, lines.join("\n") + "\n", "utf-8");
  return historyPath;
}

function memoryCoreConfig(config: Record<string, unknown>) {
  return { plugins: { entries: { "memory-core": { config } } } };
}

async function previewGroundedHistory(workspaceDir: string, historyPath: string) {
  mockWorkspace(workspaceDir);
  const output = spyRuntimeJson(defaultRuntime);
  await run(["rem-harness", "--json", "--grounded", "--path", historyPath]);
  return jsonValue<{ grounded?: GroundedRemPreviewResult | null }>(output)?.grounded?.files[0];
}

async function historicalFixture(command: "rem-harness" | "rem-backfill") {
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
  return {
    workspaceDir,
    historyPath,
    ...captureOutput(),
    run: (json = true) => run([command, "--path", historyPath, ...(json ? ["--json"] : [])]),
    scratchDirectory: () => scratchDir,
    close: mockWorkspace(workspaceDir),
    async [Symbol.asyncDispose]() {
      captureScratch.mockRestore();
      // Release stores before removing failed scratch input.
      closeOpenClawAgentDatabasesForTest();
      if (scratchDir) {
        await actualRm(scratchDir, { recursive: true, force: true });
      }
    },
  };
}

it("prints vector status when available", async () => {
  const probeVectorAvailability = vi.fn(async () => true);
  mockStatus(
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
  await run("status");
  expect(probeVectorAvailability).not.toHaveBeenCalled();
  expectLogged(log, "Memory Search (main)", "Indexed: 2/? files · 5 chunks");
  expectNotLogged(log, "consolidation sidecar");
  expectLogged(
    log,
    "Vector store: ready",
    "Semantic vectors: ready",
    "Extra paths: /tmp/openclaw/notes (pattern: runbooks/**/*.md)",
    "FTS: ready",
    "Agent database: 1.0 MiB · WAL 2.0 KiB · reusable 512.0 KiB",
  );
});

it.each([true, false])(
  "handles degraded secrets according to memory ownership (own=%s)",
  async (own) => {
    setMemorySecret(own ? "MISSING_MEMORY_API_KEY" : "HEALTHY_MEMORY_API_KEY");
    const owner = own ? "capability:memory-provider:main" : "agent:main:openai:manual";
    resolveCommandSecretRefsViaGateway.mockRejectedValueOnce(
      Object.assign(
        new Error(
          `Secret owner ${owner} is configured but unavailable: code=SECRET_SURFACE_UNAVAILABLE`,
        ),
        {
          code: "SECRET_SURFACE_UNAVAILABLE",
          ...(own
            ? {
                ownerKind: "capability",
                ownerId: "memory-provider:main",
                paths: ["memory.search.remote.apiKey"],
              }
            : {}),
        },
      ),
    );
    if (own) {
      await expect(run("status --deep")).rejects.toThrow("SECRET_SURFACE_UNAVAILABLE");
      expect(getMemorySearchManager).not.toHaveBeenCalled();
      return;
    }
    mockStatus(
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
    await run("status --deep");
    expectLogged(
      log,
      "agent:main:openai:manual",
      "healthy memory surfaces remain visible",
      "Embeddings: unavailable",
      "Vector store: unavailable",
      "Semantic vectors: unavailable",
      "Vector error: load failed",
    );
  },
);

it("reports disabled dreaming phases during status", async () => {
  setDreaming({
    enabled: true,
    phases: {
      light: { enabled: false },
      rem: { enabled: false },
      deep: { enabled: false },
    },
  });
  const close = vi.fn(async () => {});
  mockStatus({ workspaceDir: undefined }, { close });
  const log = spyRuntimeLogs(defaultRuntime);
  await run("status");
  expectLogged(log, "Dreaming: off");
  expect(close).toHaveBeenCalledOnce();
});

it("keeps newer-index upgrade advice in registered deep status without reindexing", async () => {
  const sync = vi.fn();
  const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
  mockStatus(
    {
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
    },
    { sync, probeVectorAvailability: vi.fn(async () => false), probeEmbeddingAvailability },
  );
  const log = spyRuntimeLogs(defaultRuntime);
  await run("status --deep");
  expectLogged(log, "upgrade OpenClaw or reindex explicitly", "Vector search: paused");
  expectNotLogged(log, "paused until memory is rebuilt");
  expectLogged(log, "openclaw memory status --index --agent main", "provider cost");
  expect(probeEmbeddingAvailability).toHaveBeenCalledOnce();
  expect(sync).not.toHaveBeenCalled();
});

it.each([false, true])(
  "probes persisted vector state only with --index (index=%s)",
  async (index) => {
    const probe = <T>(value: T) =>
      vi.fn(async () => {
        if (!index) {
          throw new Error("unexpected status probe");
        }
        return value;
      });
    const sync = vi.fn(async () => {});
    const probeVectorStoreAvailability = probe(true);
    const probeVectorAvailability = probe(true);
    const probeEmbeddingAvailability = probe({ ok: true });
    mockStatus(
      {
        files: index ? 1 : 0,
        chunks: index ? 1 : 5,
        provider: index ? "openai" : "auto",
        requestedProvider: index ? "openai" : "auto",
        custom: {
          llamaCppRuntime: {
            engine: "llama.cpp",
            state: "ready",
            backend: "metal",
            buildInfo: "b10357 (689e227db)",
            ...(index
              ? {
                  model: { id: "embeddinggemma-300m-qat-q8_0", path: "/models/embedding.gguf" },
                  capabilities: { vision: false, draft: false },
                  endpoints: { health: "ready", models: "ready", props: "ready", metrics: "ready" },
                }
              : {}),
          },
        },
        vector: index ? memoryStatus().vector : { enabled: true, index: { state: "complete" } },
      },
      {
        probeVectorStoreAvailability,
        probeVectorAvailability,
        probeEmbeddingAvailability,
        ...(index ? { sync } : {}),
      },
    );
    const log = spyRuntimeLogs(defaultRuntime);
    await run(["status", ...(index ? ["--index"] : [])]);
    for (const method of [
      probeVectorStoreAvailability,
      probeVectorAvailability,
      probeEmbeddingAvailability,
    ]) {
      if (index) {
        expect(method).toHaveBeenCalled();
      } else {
        expect(method).not.toHaveBeenCalled();
      }
    }
    if (index) {
      expect(sync).toHaveBeenCalled();
      expectLogged(log, "Embeddings: ready", "llama.cpp server: metal (b10357 (689e227db))");
    } else {
      expectLogged(log, "Vector store: indexed (unprobed)", "Provider: auto");
      expectNotLogged(log, "Vector store: unknown");
      expectNotLogged(log, "llama.cpp server:");
    }
  },
);

it("fans JSON status out to every keyed agent entry", async () => {
  const agentIds = ["main", ...Array.from({ length: 21 }, (_, index) => `agent-${index + 1}`)];
  getRuntimeConfig.mockReturnValue({
    agents: {
      entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
    },
  });
  getMemorySearchManager.mockImplementation(async ({ agentId }: { agentId: string }) => ({
    manager: {
      status: () =>
        memoryStatus({
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
    await run(["status", "--json"], { openKeyedStore: openKeyedStore as never });

    const payload = jsonValue<Array<{ agentId: string; status: { dbPath: string } }>>(json);
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

it("repairs invalid recall metadata and stale locks with status --fix", async () => {
  const workspaceDir = await createWorkspace();
  await writeDailyMemoryNote(workspaceDir, "2026-04-03", ["Vector router cache note"]);
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
  mockWorkspace(workspaceDir);
  const log = spyRuntimeLogs(defaultRuntime);
  await run("status");
  expectLogged(log, "Fix: openclaw memory status --fix --agent main");
  log.mockClear();
  mockWorkspace(workspaceDir);
  await run("status --fix");
  expectNotLogged(log, "Fix: openclaw memory status --fix --agent main");
  expectLogged(log, "Repair: rewrote store");
  expect(getMemorySearchManager).toHaveBeenCalledWith(expect.objectContaining({ purpose: "cli" }));
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
  mockWorkspace(workspaceDir);
  const log = spyRuntimeLogs(defaultRuntime);
  await run("status --fix");
  expectLogged(log, "Dream repair: archived session corpus", "Dream archive:");
  await expectPathMissing(sessionCorpusDir);
  await expectPathMissing(path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"));
  await expect(fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8")).resolves.toContain(
    "# Dream Diary",
  );
});

it.each(["missing-directory", "sessions", "unsupported"] as const)(
  "reports the index outcome for %s",
  async (source) => {
    const workspaceDir =
      source === "missing-directory"
        ? path.join(workspaceFixtureRoot, `case-${workspaceCaseId++}`)
        : await createWorkspace();
    if (source === "missing-directory") {
      await fs.mkdir(workspaceDir, { recursive: true });
    }
    const sync = vi.fn(async () => {});
    mockStatus(
      source === "missing-directory"
        ? {
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
          }
        : source === "sessions"
          ? { workspaceDir, sources: ["sessions"], files: 1 }
          : {},
      source === "unsupported" ? {} : { sync },
    );
    const log = spyRuntimeLogs(defaultRuntime);
    await run(["index", ...(source === "sessions" ? ["--verbose"] : [])]);
    if (source === "unsupported") {
      expect(log).toHaveBeenCalledWith("Memory backend does not support manual reindex.");
      expect(sync).not.toHaveBeenCalled();
    } else {
      expect(sync).toHaveBeenCalled();
      if (source === "missing-directory") {
        expectLogged(log, `No memory files found in ${workspaceDir}; nothing indexed (main).`);
        expectNotLogged(log, "Memory index updated");
        await expectPathMissing(path.join(workspaceDir, "memory"));
        expect(process.exitCode).toBe(0);
      } else {
        expectLogged(log, "sessions (current transcripts + retained transcript artifacts)");
        expectNotLogged(log, "*.jsonl");
        expectLogged(log, "Memory index updated (main): 1 file indexed.");
      }
    }
  },
);

it("warns on stderr when index has vector store but no semantic vectors", async () => {
  const close = vi.fn(async () => {});
  const sync = vi.fn(async () => {});
  let semanticAvailable: boolean | undefined;
  const probeVectorAvailability = vi.fn(async () => {
    semanticAvailable = false;
    return false;
  });
  mockStatus(
    () => ({
      vector: {
        enabled: true,
        storeAvailable: true,
        semanticAvailable,
        available: semanticAvailable,
      },
    }),
    { close, sync, probeVectorAvailability },
  );
  const error = spyRuntimeErrors(defaultRuntime);
  await run("index");
  expect(sync).toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    "Memory index WARNING (main): chunks_vec not updated — semantic vector embeddings unavailable — no vector dimensions resolved. Vector recall degraded.",
  );
  expect(process.exitCode).toBe(0);
});

it("propagates search failure and rebuild notice after closing the manager", async () => {
  const warning = "Memory index rebuilt; embedding provider cost may apply.";
  const notice: { sequence: number; warning?: string } = { sequence: 0 };
  const close = vi.fn(async () => {});
  const search = vi.fn(async () => {
    notice.sequence += 1;
    notice.warning = warning;
    throw new Error("boom");
  });
  mockStatus({ custom: { automaticRebuildNotice: notice } }, { search, close });
  const error = spyRuntimeErrors(defaultRuntime);
  const writeJson = spyRuntimeJson(defaultRuntime);
  await expect(run("search oops --json")).rejects.toThrow(`Memory search failed: boom ${warning}`);
  expect(search).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(writeJson).not.toHaveBeenCalled();
  expect(error.mock.calls).toEqual([]);
});

it("routes gateway secret diagnostics to stderr for json status output", async () => {
  resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
    resolvedConfig: {},
    diagnostics: [inactiveMemorySecretDiagnostic],
  });
  mockStatus({ workspaceDir: undefined });
  const writeJson = spyRuntimeJson(defaultRuntime);
  const error = spyRuntimeErrors(defaultRuntime);
  await run("status --json");
  expect(Array.isArray(jsonValue(writeJson))).toBe(true);
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
    await run(["search", "--query", "fixture query", "--json"]);
    expect(writeJson).toHaveBeenCalledTimes(1);
    expect(jsonValue(writeJson)).toEqual(
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

it("fails index --force when the memory index has orphaned provenance", async () => {
  const args = ["index", "--force"];
  const stateDir = path.join(fixtureRoot, `corrupt-state-${workspaceCaseId++}`);
  const workspaceDir = path.join(fixtureRoot, `corrupt-workspace-${workspaceCaseId++}`);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const databasePath = await seedMemoryIndexWithOrphanedProvenance(env);
  const cfg = indexConfig(workspaceDir, {
    model: "",
    rememberAcrossConversations: false,
    cache: { enabled: false },
    query: { hybrid: { enabled: true } },
  });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  getRuntimeConfig.mockReturnValue(cfg);
  await useRealManager();
  const error = spyRuntimeErrors(defaultRuntime);
  await run(args);
  expect(resolveOpenClawAgentSqlitePath({ agentId: "main", env })).toBe(databasePath);
  expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("SQLite foreign_key_check failed"));
});

it.each([
  [
    ["search", "positional", "--query", ""],
    false,
    "Missing search query. Provide a positional query or use --query <text>.",
  ],
  [["forget", "--dry-run"], false, "Memory forget requires --session"],
  [["promote-explain", "   "], false, "Memory promote-explain requires a non-empty selector."],
  [
    ["promote-explain", "  unmatched fixture  "],
    true,
    'No promotion candidate matched "unmatched fixture".',
  ],
  [
    ["session-backfill", "--rollback", "--from", "2026-01-01"],
    false,
    "Memory session-backfill --rollback cannot be combined",
  ],
  [["rem-backfill"], true, "Memory rem-backfill requires --path"],
] as const)(
  "propagates invalid memory input without a success report: %j",
  async (args, acquires, message) => {
    const workspaceDir = await createWorkspace();
    const close = acquires ? mockWorkspace(workspaceDir) : vi.fn();
    const writeJson = spyRuntimeJson(defaultRuntime);
    await expect(run([...args, "--json"])).rejects.toThrow(message);
    expect(writeJson).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(acquires ? 1 : 0);
    expect(getMemorySearchManager).toHaveBeenCalledTimes(acquires ? 1 : 0);
    expect(forgetMemoryEntries).not.toHaveBeenCalled();
  },
);

it.each([
  ["forget", ["forget", "--session", "fixture-session", "--dry-run"], "Memory forget failed: "],
  ["rank", ["promote"], "Memory promote ranking failed: "],
  ["apply", ["promote", "--apply"], "Memory promote apply failed: "],
  ["rank", ["promote-explain", "fixture"], "Memory promote-explain failed: "],
] as const)(
  "propagates %s operation failure without a success report",
  async (operation, args, prefix) => {
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
    const close = operation !== "forget" ? mockWorkspace(workspaceDir) : vi.fn();
    const writeJson = spyRuntimeJson(defaultRuntime);
    await expect(run([...args, "--json"])).rejects.toThrow(`${prefix}${failure.message}`);
    expect(writeJson).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(operation === "forget" ? 0 : 1);
  },
);

it("qualifies json search results when the index remains stale", async () => {
  const reason = "index was built for model old-embed, expected new-embed";
  mockStatus(
    {
      dirty: true,
      custom: {
        indexIdentity: { status: "mismatched", reason, code: "model", owner: "configuration" },
      },
    },
    { search: vi.fn(async () => []) },
  );
  const writeJson = spyRuntimeJson(defaultRuntime);
  await run(["search", "hidden codeword", "--agent", "main", "--json"]);
  expect(jsonValue(writeJson)).toEqual({
    results: [],
    stale: true,
    warning: `Memory index is stale: ${reason} (owner: configuration, code: model). Search results may be incomplete.`,
    action:
      "Run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.",
  });
});

it.each(["München", "Mu\u0308nchen"])("promote-explain finds %s", async (title) => {
  const workspaceDir = await createWorkspace();
  getMemorySearchManager.mockResolvedValue({ manager: workspaceManager(workspaceDir) });
  const log = spyRuntimeLogs(defaultRuntime);
  await run("promote");
  expect(log).toHaveBeenCalledWith("No short-term recall candidates.");
  expect(process.exitCode).toBe(0);
  await recordRecall(
    workspaceDir,
    "router notes",
    recallResult("memory/2026-04-03.md", `Configured VLAN 10 for IoT in ${title}`, {
      startLine: 4,
      endLine: 8,
      score: 0.86,
    }),
  );
  const writeJson = spyRuntimeJson(defaultRuntime);
  const query = title === "München" ? "Mu\u0308nchen" : "München";
  await run(["promote-explain", `  ${query}  `, "--json", "--include-promoted"]);
  expect(jsonValue(writeJson)).toMatchObject({
    candidate: { snippet: `Configured VLAN 10 for IoT in ${title}` },
  });
});

it.each([false, true])(
  "previews live recall candidates with rem-harness (json=%s)",
  async (json) => {
    const workspaceDir = await createWorkspace();
    const nowMs = Date.now();
    const isoDay = new Date(nowMs).toISOString().slice(0, 10);
    const snippet = "Always check weather before suggesting outdoor plans.";
    await writeDailyMemoryNote(workspaceDir, isoDay, [snippet]);
    await recordRecall(
      workspaceDir,
      "weather plans",
      recallResult(`memory/${isoDay}.md`, snippet, { score: 0.92, startLine: 2, endLine: 3 }),
      nowMs,
    );
    const close = mockWorkspace(workspaceDir);
    const { json: writeJson, log } = captureOutput();

    await run(["rem-harness", ...(json ? ["--json"] : [])]);

    if (json) {
      const payload = jsonValue<{
        rem: { candidateTruths: Array<{ snippet: string }> };
        deep: { candidates: Array<{ snippet: string }> };
      }>(writeJson);
      expect(payload?.rem.candidateTruths[0]?.snippet).toContain("Always check weather");
      expect(payload?.deep.candidates[0]?.snippet).toContain("Always check weather");
      expect(log).not.toHaveBeenCalled();
    } else {
      expectLogged(
        log,
        "REM Harness",
        "recentRecallEntries=1 deepCandidates=1",
        snippet,
        `[memory/${isoDay}.md:2-3]`,
      );
      expect(writeJson).not.toHaveBeenCalled();
    }
    expect(close).toHaveBeenCalledOnce();
  },
);

it("picks up slugged daily memory files for rem-backfill (#69536)", async () => {
  const workspaceDir = await createWorkspace();
  const sluggedPath = await writeHistory(workspaceDir, "2025-01-01-vendor-pitch.md", [
    "## Preferences Learned",
    '- Always use "Happy Together" calendar for flights and reservations.',
  ]);
  const secondSluggedPath = await writeHistory(workspaceDir, "2025-01-01-travel-rule.md", [
    "## Preferences Learned",
    "- Always book aisle seats for red-eye flights.",
  ]);
  mockWorkspace(workspaceDir);
  const errors = spyRuntimeErrors(defaultRuntime);
  await run(["rem-backfill", "--path", path.dirname(sluggedPath)]);
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
  const close = mockWorkspace(workspaceDir);
  const allocate = vi.spyOn(fs, "mkdtemp");
  const writeJson = spyRuntimeJson(defaultRuntime);
  await expect(
    run(["rem-harness", "--path", path.join(workspaceDir, "missing-history"), "--json"]),
  ).rejects.toThrow("Memory rem-harness found no YYYY-MM-DD.md files");
  expect(allocate).not.toHaveBeenCalled();
  expect(writeJson).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

it.each([
  { command: "rem-harness", json: false },
  { command: "rem-backfill", json: true },
] as const)("publishes $command success only after scratch cleanup", async ({ command, json }) => {
  await using fixture = await historicalFixture(command);
  const { historyPath, scratchDirectory, close, json: writeJson, log } = fixture;
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const actualRm = fs.rm;
  using _ = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (target === scratchDirectory()) {
      entered.resolve();
      await release.promise;
    }
    await actualRm(target, options);
  });
  const outcome = fixture.run(json).then(
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
      expect(jsonValue(writeJson)).toMatchObject({ sourceFiles: [historyPath] });
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
  }
});

it("rejects scratch cleanup without publishing success even when manager close fails", async () => {
  await using fixture = await historicalFixture("rem-backfill");
  const { scratchDirectory, close, json: writeJson, log } = fixture;
  const errors = spyRuntimeErrors(defaultRuntime);
  const failure = new Error("fixture scratch cleanup rejected");
  close.mockRejectedValueOnce(new Error("close boom"));
  const actualRm = fs.rm;
  using _ = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (target === scratchDirectory()) {
      throw failure;
    }
    await actualRm(target, options);
  });
  await expect(fixture.run()).rejects.toBe(failure);
  expect(writeJson).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls).toEqual([["Memory manager close failed: close boom"]]);
});

it("cleans allocated scratch when preparing historical input fails", async () => {
  await using fixture = await historicalFixture("rem-harness");
  const { scratchDirectory, close, json: writeJson } = fixture;
  const failure = Object.assign(new Error("fixture mkdir rejected"), { code: "EIO" });
  const actualMkdir = fs.mkdir;
  let faultObserved = false;
  using _ = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
    const scratchDir = scratchDirectory();
    if (scratchDir && target === path.join(scratchDir, "memory")) {
      faultObserved = true;
      throw failure;
    }
    return actualMkdir(target, options);
  });
  await expect(fixture.run()).rejects.toBe(failure);
  expect(faultObserved).toBe(true);
  expect(writeJson).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
  expect(scratchDirectory()).toBeDefined();
  await expectPathMissing(scratchDirectory()!);
});

it.each(["short-term", "diary"] as const)(
  "rolls back grounded %s entries without touching the other store",
  async (store) => {
    const workspaceDir = await createWorkspace();
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      "# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n\n---\n\n*April 5, 2026, 3:00 AM*\n\nKeep this normal dream.\n\n<!-- openclaw:dreaming:diary:end -->\n",
    );
    const historyPath = await writeHistory(workspaceDir, "2025-01-01.md", [
      "## Preferences Learned",
      '- Always use "Happy Together" calendar for flights and reservations.',
    ]);
    const close = mockWorkspace(workspaceDir);
    await run(["rem-backfill", "--path", historyPath, "--stage-short-term"]);
    const staged = await readRecalls({ workspaceDir });
    expect(staged).toMatchObject([
      {
        snippet: expect.stringContaining("Happy Together"),
        groundedCount: 3,
        recallCount: 0,
      },
    ]);
    expect(staged[0]?.queryHashes).toHaveLength(2);
    const diary = await fs.readFile(dreamsPath, "utf-8");
    expect(diary).toContain("Happy Together");
    mockStatus({ workspaceDir }, { close });
    await run(`rem-backfill --rollback${store === "short-term" ? "-short-term" : ""}`);
    const entries = await readRecalls({ workspaceDir });
    const afterDiary = await fs.readFile(dreamsPath, "utf-8");
    if (store === "short-term") {
      expect(entries).toHaveLength(0);
      expect(afterDiary).toBe(diary);
    } else {
      expect(entries).toEqual(staged);
      expect(afterDiary).toContain("Keep this normal dream.");
      expect(afterDiary).not.toContain("Happy Together");
    }
    expect(close).toHaveBeenCalledTimes(2);
  },
);

it.each([
  [
    "prefers persistence-relevant evidence over narrated operational logs in grounded what happened",
    "2025-03-30.md",
    [
      "## Versions / machine state and update work",
      "- MB Server repo updated but the active installed runtime is still old.",
      "- jpclawhq updated and running.",
      "## Other context and user preferences reinforced in this session",
      "- Mariano prefers short, punk, high-signal copy for social posts.",
    ],
    ["prefers short, punk, high-signal copy"],
    [
      "MB Server repo updated but the active installed runtime is still old",
      "jpclawhq updated and running",
    ],
    false,
  ],
  [
    "suppresses monitoring-heavy operational days instead of promoting alert sludge",
    "2025-02-17.md",
    [
      "## Heartbeat checks",
      "- Ariston check returned warning/error:",
      "  - Pressure LOW: 1.1 bar",
      "- Action: alert Mariano on this heartbeat.",
      "## 07:15 life-context sync (travel + now)",
      "- mariano@tpmcap.com calendar access failed (invalid_grant: token expired/revoked).",
    ],
    ["No grounded facts were extracted.", "mostly as monitoring and operational state"],
    ["Pressure LOW", "invalid_grant"],
    false,
  ],
  [
    "splits multi-fact person lines into atomic grounded candidates",
    "2025-02-19.md",
    [
      "## People mentioned with context",
      "- Bunji — partner, Surrealist Ball Sat 28 Feb w/ Maga",
      "- Bex — girlfriend, date weekend Fri-Sun London, Chateau Denmark",
      "## Process improvements",
      "- Routed several inbound requests into different workflows.",
      "- Important context was written into notes and memory surfaces.",
    ],
    [
      "People mentioned with context: Bunji — partner, Surrealist Ball Sat 28 Feb w/ Maga",
      "Bex — girlfriend, date weekend Fri-Sun London, Chateau Denmark",
      "Bunji — partner",
      "Bex — girlfriend",
    ],
    [
      "Bunji — Surrealist Ball Sat 28 Feb w/ Maga [",
      "Bex — date weekend Fri-Sun London, Chateau Denmark",
    ],
    true,
  ],
] as const)("%s", async (_name, date, lines, contains, excludes, checkReflections) => {
  const workspaceDir = await createWorkspace();
  const historyPath = await writeHistory(workspaceDir, date, lines);
  const file = await previewGroundedHistory(workspaceDir, historyPath);
  const rendered = file?.renderedMarkdown ?? "";
  for (const text of contains) {
    expect(rendered).toContain(text);
  }
  for (const text of excludes) {
    expect(rendered).not.toContain(text);
  }
  if (checkReflections) {
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
  }
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
  const { recall } = await dailyRecallFixture(workspaceDir, "2026-04-10", [
    ["Retain the release checklist.", 0.91],
  ]);
  await recall("release checklist", 1);
  getRuntimeConfig.mockReturnValue({
    agents: {
      entries: { main: { workspace: workspaceDir, bootstrapMaxChars: 1_400 } },
    },
    ...memoryCoreConfig({ dreaming: { phases: { deep: { maxPriorEntryLossFraction: 1 } } } }),
  });
  mockWorkspace(workspaceDir);
  await run(["promote", "--apply", ...unrestrictedPromotion]);
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
    await recordRecall(
      workspaceAliasDir,
      "shared workspace",
      recallResult("memory/2026-04-01.md", "Shared workspace fact."),
    );
    getRuntimeConfig.mockReturnValue({
      agents: {
        entries: {
          alpha: {
            workspace: workspaceDir,
            bootstrapMaxChars: 9_000,
          },
          beta: { workspace: workspaceAliasDir, bootstrapMaxChars: 12_000 },
        },
      },
    });
    mockStatus({ workspaceDir: workspaceAliasDir });

    const writeJson = spyRuntimeJson(defaultRuntime);
    await run(["promote", "--agent", "beta", "--apply", "--json", ...unrestrictedPromotion]);

    expect(jsonValue(writeJson)).toMatchObject({
      candidates: [expect.anything()],
      apply: {
        appliedCandidates: [],
        rejectedCandidates: [{ reason: expect.stringContaining("budget") }],
      },
    });
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8")).toBe(existingMemory);
  },
);

it("names apply-time rejections without ranking blocked origins", async () => {
  const workspaceDir = await createWorkspace();
  const { memoryPath: relativePath, recall } = await dailyRecallFixture(
    workspaceDir,
    "2026-04-02",
    [
      ["Untrusted router note must not become durable memory.", 0.99, "untrusted"],
      ["Rare trusted note remains below the apply signal threshold.", 0.99],
      ["Durable action note.", 0.99],
    ],
  );
  await recall("router note", 1, 2, 3);
  await recall("durable action", 3);
  await writeDailyMemoryNote(workspaceDir, "2026-04-02", [
    "Untrusted router note must not become durable memory.",
    "Rare trusted note remains below the apply signal threshold.",
    "Candidate: Durable action note. confidence: 0.90 evidence: memory/.dreams/session-corpus/day.txt:1-1 recalls: 3 status: staged",
  ]);
  const manager = workspaceManager(workspaceDir);
  mockManager(manager);
  const log = spyRuntimeLogs(defaultRuntime);
  await run("promote --apply --min-score 0 --min-recall-count 2 --min-unique-queries 0");
  expectNotLogged(log, `${relativePath}:1-1`);
  expectLogged(log, `Skipped ${relativePath}:2-2: signal threshold (1 < 2).`);
  expectLogged(log, `Skipped ${relativePath}:3-3: contamination filter after rehydration.`);
  expectNotLogged(log, "No candidates met apply criteria.");
});

it("keeps preview limits available and preserves mixed apply output order", async () => {
  const workspaceDir = await createWorkspace();
  const { memoryPath: relativePath, recall } = await dailyRecallFixture(
    workspaceDir,
    "2026-04-03",
    [
      ["High-score untrusted candidate.", 0.99, "untrusted"],
      ["Lower-score trusted candidate.", 0.01],
      ["High-score rare trusted candidate.", 0.99, "owner"],
    ],
  );
  await recall("candidate order", 1, 2);
  await recall("trusted candidate", 2);
  const manager = workspaceManager(workspaceDir);
  const args = ["promote", "--min-score", "0", "--min-unique-queries", "0"];
  mockManager(manager);
  const writeJson = spyRuntimeJson(defaultRuntime);
  await run([...args, "--limit", "1", "--min-recall-count", "0", "--json"]);
  expect(jsonValue(writeJson)).toMatchObject({ candidates: [{ startLine: 2 }] });
  await recall("rare candidate", 3);
  const applyArgs = [...args, "--apply", "--limit", "2", "--min-recall-count", "2"];
  writeJson.mockClear();
  mockManager(manager);
  await run([...applyArgs, "--json"]);
  expect(jsonValue(writeJson)).toMatchObject({
    candidates: [{ startLine: 3 }, { startLine: 2 }],
    apply: {
      appliedCandidates: [{ startLine: 2 }],
      rejectedCandidates: [{ candidate: { startLine: 3 } }],
    },
  });
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
  await run(applyArgs);
  const output = loggedOutput(log);
  expect(output).not.toContain(`${relativePath}:1-1`);
  const rejectedIndex = output.indexOf(`${relativePath}:3-3`);
  const appliedIndex = output.indexOf(`${relativePath}:2-2`);
  expect(rejectedIndex).toBeGreaterThanOrEqual(0);
  expect(rejectedIndex).toBeLessThan(appliedIndex);
});

it.each([
  { enabled: true, json: true },
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
    mockStatus({ workspaceDir }, { search });
    const { json: writeJson, log } = captureOutput();
    await run(["search", "glacier", ...(json ? ["--json"] : [])]);
    if (json) {
      expect(jsonValue(writeJson)).toEqual({
        results: [expect.objectContaining({ path: "memory/2026-04-03.md" })],
      });
    } else {
      expectLogged(log, "0.910 memory/2026-04-03.md:1-2", "Move backups to S3 Glacier.");
      expect(writeJson).not.toHaveBeenCalled();
    }
    const entries = await readRecalls({ workspaceDir });
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
