// Memory CLI tests for promote diagnostics: why ranking excluded entries.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  firstWrittenJsonArg,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

const getMemorySearchManager = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn((): object => ({})));

vi.mock("./memory/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory/index.js")>()),
  getMemorySearchManager,
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli")>()),
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-core")>();
  return {
    ...original,
    getRuntimeConfig,
    resolveDefaultAgentId: () => "main",
    listMemoryArtifactProvenance: vi.fn(original.listMemoryArtifactProvenance),
  };
});

let registerMemoryCli: typeof import("./cli.js").registerMemoryCli;
let defaultRuntime: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").defaultRuntime;
let fixtureRoot = "";
let workspaceCaseId = 0;

beforeAll(async () => {
  await configureMemoryCoreDreamingStateForTests();
  ({ registerMemoryCli } = await import("./cli.js"));
  ({ defaultRuntime } = await import("openclaw/plugin-sdk/memory-core-host-runtime-cli"));
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-promote-"));
});

beforeEach(() => {
  process.exitCode = 0;
  getMemorySearchManager.mockReset();
  getRuntimeConfig.mockReset().mockReturnValue({});
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

afterAll(async () => {
  // Agent close releases leases through shared state, so it must run first (Windows EBUSY).
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  resetMemoryCoreDreamingStateForTests();
});

describe("memory promote diagnostics", () => {
  type RecallResult = Parameters<typeof recordShortTermRecalls>[0]["results"][number];

  async function createWorkspace() {
    const workspaceDir = path.join(fixtureRoot, `case-${workspaceCaseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    return workspaceDir;
  }

  function recallResult(
    memoryPath: string,
    snippet: string,
    overrides: Partial<RecallResult> = {},
  ): RecallResult {
    return {
      path: memoryPath,
      snippet,
      source: "memory",
      startLine: 1,
      endLine: 1,
      score: 0.91,
      ...overrides,
    };
  }

  async function recordRecall(workspaceDir: string, query: string, result: RecallResult) {
    await recordShortTermRecalls({ workspaceDir, query, results: [result] });
  }

  function mockWorkspaceManager(workspaceDir: string) {
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        status: () => ({ backend: "builtin", workspaceDir }),
        close: vi.fn(async () => {}),
      },
    });
  }

  function expectLogged(spy: ReturnType<typeof spyRuntimeLogs>, expected: string) {
    const output = spy.mock.calls.map((call) => stripVTControlCharacters(String(call[0])));
    expect(output.join("\n")).toContain(expected);
  }

  async function runMemoryCli(args: string[]) {
    const program = new Command().name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", ...args], { from: "user" });
  }

  it("says the recall store is empty", async () => {
    const workspaceDir = await createWorkspace();
    mockWorkspaceManager(workspaceDir);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["promote"]);

    expectLogged(log, "No short-term recall candidates.");
    expectLogged(log, "Recall store is empty.");
  });

  async function recordIngestionOnlyAndUntrustedRecalls(workspaceDir: string) {
    const observedAt = Date.parse("2026-10-01T12:00:00.000Z");
    // Ingestion signal never records user queries, so this entry can't pass query diversity.
    await recordShortTermRecalls({
      workspaceDir,
      query: "__dreaming_daily__:2026-10-01",
      signalType: "daily",
      results: [
        recallResult("memory/2026-10-01.md", "Deploys go out on Tuesdays", {
          provenance: { originClass: "agent", sessionKind: "unknown", observedAt },
        }),
      ],
    });
    await recordRecall(
      workspaceDir,
      "browser notes",
      recallResult("memory/2026-10-02.md", "Vendor portal moved to a new host", {
        provenance: { originClass: "untrusted", sessionKind: "interactive", observedAt },
      }),
    );
  }

  it("reports which gate excluded every entry when promote finds no candidates", async () => {
    const workspaceDir = await createWorkspace();
    await recordIngestionOnlyAndUntrustedRecalls(workspaceDir);
    mockWorkspaceManager(workspaceDir);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["promote", "--min-score", "0", "--min-recall-count", "0"]);

    expectLogged(log, "No short-term recall candidates.");
    expectLogged(log, `Workspace: ${workspaceDir}`);
    expectLogged(log, "Excluded 2 of 2: origin 1, query threshold 1");
    expectLogged(log, "fewer than 3 distinct queries");
    expectLogged(log, "see: openclaw memory promote-explain");
  });

  it("keeps the selected agent in the suggested explain command", async () => {
    const workspaceDir = await createWorkspace();
    await recordIngestionOnlyAndUntrustedRecalls(workspaceDir);
    getRuntimeConfig.mockReturnValue({
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
    });
    mockWorkspaceManager(workspaceDir);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli([
      "promote",
      "--agent",
      "ops",
      "--min-score",
      "0",
      "--min-recall-count",
      "0",
    ]);

    expectLogged(log, "Agent: ops");
    expectLogged(log, "--agent ops");
  });

  it("reports exclusions and overridden thresholds in promote json", async () => {
    const workspaceDir = await createWorkspace();
    await recordIngestionOnlyAndUntrustedRecalls(workspaceDir);
    mockWorkspaceManager(workspaceDir);

    const writeJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["promote", "--json", "--min-score", "0", "--min-recall-count", "0"]);

    expect(firstWrittenJsonArg(writeJson)).toMatchObject({
      agentId: "main",
      thresholds: { minScore: 0, overridden: ["--min-score", "--min-recall-count"] },
      exclusions: {
        considered: 2,
        excluded: 2,
        byReason: [
          { reason: "origin", count: 1 },
          { reason: "query threshold", count: 1 },
        ],
        quarantinedAtApply: { count: 0, sampleKeys: [] },
      },
      candidates: [],
    });
  });

  it("explains an entry that ranking excluded", async () => {
    const workspaceDir = await createWorkspace();
    await recordIngestionOnlyAndUntrustedRecalls(workspaceDir);
    mockWorkspaceManager(workspaceDir);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["promote-explain", "Vendor portal"]);

    expectLogged(log, "Excluded by origin (untrusted)");
  });

  it("explains the exact key promote suggests even when it prefixes a candidate key", async () => {
    const workspaceDir = await createWorkspace();
    const observedAt = Date.parse("2026-10-01T12:00:00.000Z");
    const untrusted = {
      originClass: "untrusted" as const,
      sessionKind: "interactive" as const,
      observedAt,
    };
    await recordRecall(
      workspaceDir,
      "port notes",
      recallResult("memory/2026-10-01.md", "Old admin port", {
        startLine: 1,
        endLine: 3,
        provenance: untrusted,
      }),
    );
    await recordRecall(
      workspaceDir,
      "port notes",
      recallResult("memory/2026-10-01.md", "New admin port", { startLine: 1, endLine: 30 }),
    );
    mockWorkspaceManager(workspaceDir);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["promote-explain", "memory:memory/2026-10-01.md:1:3"]);

    expectLogged(log, "Excluded by origin (untrusted)");
    expectLogged(log, "these never promote");
  });

  it("explains an entry the age gate excluded instead of failing", async () => {
    const workspaceDir = await createWorkspace();
    await recordShortTermRecalls({
      workspaceDir,
      query: "old router notes",
      nowMs: Date.now() - 60 * 24 * 60 * 60 * 1000,
      results: [recallResult("memory/2026-08-01.md", "Router admin moved to port 8443")],
    });
    mockWorkspaceManager(workspaceDir);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["promote-explain", "Router admin"]);

    expectLogged(log, "Excluded by age threshold");
    expect(process.exitCode).toBe(0);
  });

  it("tags preview candidates whose daily file apply will quarantine", async () => {
    const workspaceDir = await createWorkspace();
    const observedAt = Date.parse("2026-10-01T12:00:00.000Z");
    await recordRecall(
      workspaceDir,
      "deploy schedule",
      recallResult("memory/2026-10-01.md", "Deploys go out on Tuesdays", {
        provenance: { originClass: "agent", sessionKind: "interactive", observedAt },
      }),
    );
    vi.mocked(listMemoryArtifactProvenance).mockResolvedValueOnce([
      {
        relativePath: "memory/2026-10-01.md",
        provenance: { fileHash: "0".repeat(64), originClass: "untrusted", observedAt },
      },
    ]);
    mockWorkspaceManager(workspaceDir);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli([
      "promote",
      "--min-score",
      "0",
      "--min-recall-count",
      "0",
      "--min-unique-queries",
      "0",
    ]);

    expectLogged(log, "quarantined at apply");
    expectLogged(log, "1 candidate(s) come from untrusted daily files");
  });
});
