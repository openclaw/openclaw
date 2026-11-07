import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  firstWrittenJsonArg as jsonValue,
  spyRuntimeErrors,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroundedRemPreviewResult } from "./rem-evidence.js";
import { readShortTermRecallEntries as readRecalls } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const getMemorySearchManager = vi.hoisted(() => vi.fn());
const forgetMemoryEntries = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn(() => ({})));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveAgentOperationAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveCommandSecretRefsViaGateway = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  })),
);

// mock-isolation: Isolated forget/manager/core mocks for memory CLI tests.
vi.mock("./memory-forget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory-forget.js")>()),
  forgetMemoryEntries,
}));

vi.mock("./memory/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory/index.js")>()),
  getMemorySearchManager,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli")>()),
  resolveCommandSecretRefsViaGateway,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-core")>()),
  resolveAgentOperationAgentId,
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
  fixtureRoot = await createTempWorkspace("memory-cli-subcommand-fixtures-");
  workspaceFixtureRoot = path.join(fixtureRoot, "workspace");
  await fs.mkdir(workspaceFixtureRoot, { recursive: true });
});

beforeEach(() => {
  process.exitCode = 0;
  getMemorySearchManager.mockReset();
  forgetMemoryEntries.mockReset();
  getRuntimeConfig.mockReset().mockReturnValue({});
  resolveAgentOperationAgentId.mockReset().mockReturnValue("main");
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

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
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

function captureOutput() {
  return {
    json: spyRuntimeJson(defaultRuntime),
    log: spyRuntimeLogs(defaultRuntime),
  };
}

async function run(args: string[] | string, hostOptions?: Parameters<typeof registerMemoryCli>[1]) {
  const program = new Command().name("test");
  registerMemoryCli(program, hostOptions);
  const argv = typeof args === "string" ? args.split(" ") : args;
  await program.parseAsync(["memory", ...argv], { from: "user" });
}

async function createWorkspace() {
  const dir = path.join(workspaceFixtureRoot, `case-${workspaceCaseId++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeHistory(workspaceDir: string, name: string, lines: readonly string[]) {
  const historyPath = path.join(workspaceDir, name);
  await fs.writeFile(historyPath, lines.join("\n") + "\n", "utf-8");
  return historyPath;
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
      closeOpenClawAgentDatabasesForTest();
      if (scratchDir) {
        await actualRm(scratchDir, { recursive: true, force: true });
      }
    },
  };
}

describe("memory rem subcommands", () => {
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
});
