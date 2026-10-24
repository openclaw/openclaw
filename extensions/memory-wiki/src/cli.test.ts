import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGptImportResult, ChatGptRollbackResult } from "./chatgpt-import.js";
import { registerWikiCli } from "./cli.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import type { RootMoveHooks } from "./guarded-root.test-support.js";
import { parseWikiMarkdown } from "./markdown.js";
import {
  renderMemoryWikiStatus,
  type MemoryWikiDoctorReport,
  type MemoryWikiStatus,
} from "./status.js";
import { createChatGptConversation, createMemoryWikiTestHarness } from "./test-helpers.js";

const callGatewayFromCliMock = vi.hoisted(() => vi.fn());
const afterCompileHook = vi.hoisted<{ run?: () => Promise<void> }>(() => ({}));

const afterMoveHook = vi.hoisted(() => ({ run: undefined as RootMoveHooks["afterMove"] }));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  callGatewayFromCli: callGatewayFromCliMock,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  const { observeRootMoves } = await import("./guarded-root.test-support.js");
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) =>
      observeRootMoves(await actual.root(...args), {
        afterMove: (from, to) => afterMoveHook.run?.(from, to),
      }),
  };
});

vi.mock("./compile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compile.js")>();
  return {
    ...actual,
    compileMemoryWikiVault: async (
      ...args: Parameters<typeof actual.compileMemoryWikiVault>
    ): ReturnType<typeof actual.compileMemoryWikiVault> => {
      const result = await actual.compileMemoryWikiVault(...args);
      await afterCompileHook.run?.();
      return result;
    },
  };
});

const { createVault: createCliVault } = createMemoryWikiTestHarness();
let stdoutWriteMock: ReturnType<typeof vi.fn>;
const synthesisArgs = ["apply", "synthesis", "CLI Alpha", "--body", "Alpha from CLI."];
const assistantReply = "Noted. I will keep travel options close to the airport.";
const warnings = (message: string): MemoryWikiStatus["warnings"] => [
  { code: "bridge-artifacts-missing", message },
];

const emptyBridgeImport = {
  importedCount: 0,
  updatedCount: 0,
  skippedCount: 0,
  removedCount: 0,
  artifactCount: 0,
  workspaces: 0,
  pagePaths: [],
  indexesRefreshed: false,
  indexUpdatedFiles: [],
  indexRefreshReason: "no-import-changes",
};

describe("memory-wiki cli", () => {
  beforeEach(() => {
    callGatewayFromCliMock.mockReset();
    stdoutWriteMock = vi.fn(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(
      stdoutWriteMock as unknown as typeof process.stdout.write,
    );
    process.exitCode = undefined;
  });

  afterEach(() => {
    afterCompileHook.run = undefined;
    afterMoveHook.run = undefined;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function createProgram(
    config: ResolvedMemoryWikiConfig,
    appConfig?: OpenClawConfig,
    positional = false,
    writeErr: (text: string) => void = () => {},
  ) {
    const program = new Command().name("test").exitOverride();
    program.configureOutput({ writeErr, writeOut: () => {} });
    if (positional) {
      program.enablePositionalOptions();
    }
    registerWikiCli(program, { config, getAppConfig: () => appConfig });
    return program;
  }

  async function runChatGptImport(
    config: ResolvedMemoryWikiConfig,
    exportDir: string,
    ...flags: string[]
  ): Promise<ChatGptImportResult> {
    return JSON.parse(
      await runWiki(config, ["chatgpt", "import", "--export", exportDir, ...flags, "--json"]),
    );
  }

  async function runRollback(
    config: ResolvedMemoryWikiConfig,
    runId: string,
  ): Promise<ChatGptRollbackResult> {
    return JSON.parse(await runWiki(config, ["chatgpt", "rollback", runId, "--json"]));
  }

  const createBridgeCliVault = () =>
    createCliVault({
      config: { vaultMode: "bridge", bridge: { enabled: true, readMemoryArtifacts: true } },
      initialize: true,
    });

  async function runWiki(
    config: ResolvedMemoryWikiConfig,
    args: string[],
    appConfig?: OpenClawConfig,
    positional = false,
  ): Promise<string> {
    stdoutWriteMock.mockClear();
    const program = createProgram(config, appConfig, positional);
    await program.parseAsync(["wiki", ...args], { from: "user" });
    return stdoutWriteMock.mock.calls.map(([chunk]) => String(chunk)).join("");
  }

  async function updateExportReply(exportDir: string, reply: string) {
    const filePath = path.join(exportDir, "conversations.json");
    const json = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, json.replace(assistantReply, reply), "utf8");
  }

  async function createChatGptVault(
    conversationOverrides: Partial<ReturnType<typeof createChatGptConversation>> = {},
  ) {
    const vault = await createCliVault({ initialize: true });
    const exportDir = path.join(vault.rootDir, "chatgpt-export");
    const conversation = {
      ...createChatGptConversation("I prefer aisle seats", assistantReply),
      ...conversationOverrides,
    };
    await vault.write("chatgpt-export/conversations.json", JSON.stringify([conversation]));
    return {
      ...vault,
      exportDir,
      import: (...flags: string[]) => runChatGptImport(vault.config, exportDir, ...flags),
      rollback: (id: string) => runRollback(vault.config, id),
      sourcePath: async () =>
        path.join(vault.rootDir, "sources", await findImportedSourceFile(vault.rootDir)),
    };
  }

  async function findImportedSourceFile(rootDir: string): Promise<string> {
    return expectDefined(
      (await fs.readdir(path.join(rootDir, "sources"))).find((entry) => entry !== "index.md"),
      "imported ChatGPT source file",
    );
  }

  function createGatewayStatus(config: {
    agentId?: string;
    vault: { path: string; scope?: MemoryWikiStatus["vaultScope"] };
    bridge: MemoryWikiStatus["bridge"];
  }): MemoryWikiStatus {
    return {
      vaultScope: config.vault.scope ?? "global",
      agentId: config.agentId ?? null,
      vaultMode: "bridge",
      renderMode: "native",
      vaultPath: config.vault.path,
      vaultExists: true,
      bridge: config.bridge,
      bridgePublicArtifactCount: 2,
      obsidianCli: { enabled: false, requested: false, available: false, command: null },
      unsafeLocal: { allowPrivateMemoryCoreAccess: false, pathCount: 0 },
      pageCounts: { source: 0, entity: 0, concept: 0, synthesis: 0, report: 0 },
      sourceCounts: { native: 0, bridge: 0, bridgeEvents: 0, unsafeLocal: 0, other: 0 },
      warnings: [],
    };
  }

  it("registers apply synthesis and writes a synthesis page", async () => {
    const { config, read } = await createCliVault();

    await runWiki(config, [
      ...synthesisArgs,
      "--source-id",
      "source.alpha",
      "--source-id",
      "source.beta",
    ]);

    const page = await read("syntheses/cli-alpha.md");
    expect(page).toContain("Alpha from CLI.");
    expect(page).toContain("source.alpha");
    await expect(read("index.md")).resolves.toContain("[CLI Alpha](syntheses/cli-alpha.md)");
  });

  it("rejects blank and invalid UTF-8 --body-file before wiping synthesis", async () => {
    const { config, read, write } = await createCliVault();
    const args = ["apply", "synthesis", "Good", "--source-id", "src.manual"];
    await runWiki(config, [...args, "--body", "Real summary v1"]);
    const pagePath = "syntheses/good.md";
    const before = await read(pagePath);
    expect(before).toContain("Real summary v1");

    for (const [bytes, error] of [
      [Buffer.from("  \n\n"), /body-file is empty/],
      [Buffer.from([0x43, 0x61, 0x66, 0xe9]), /must be valid UTF-8/],
    ] as const) {
      const bodyPath = await write("body.txt", bytes);
      await expect(runWiki(config, [...args, "--body-file", bodyPath])).rejects.toThrow(error);
      expect(await read(pagePath)).toBe(before);
    }
  });

  it("forwards --agent through every bridge Gateway call", async () => {
    const { config } = await createCliVault({
      config: {
        vaultMode: "bridge",
        vault: { scope: "agent" },
        bridge: { enabled: true, readMemoryArtifacts: true },
      },
    });
    const appConfig = { agents: { entries: { support: {}, marketing: {} } } };
    const status = createGatewayStatus(config);
    const report: MemoryWikiDoctorReport = { healthy: true, warningCount: 0, status, fixes: [] };
    callGatewayFromCliMock
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(report)
      .mockResolvedValueOnce(emptyBridgeImport);
    for (const command of [["status"], ["doctor"], ["bridge", "import"]]) {
      await runWiki(config, ["--agent", "marketing", ...command, "--json"], appConfig);
    }

    expect(callGatewayFromCliMock.mock.calls.map(([method, , params]) => [method, params])).toEqual(
      [
        ["wiki.status", { agentId: "marketing" }],
        ["wiki.doctor", { agentId: "marketing" }],
        ["wiki.bridge.import", { agentId: "marketing" }],
      ],
    );
  });

  it("registers OKF import and searches imported concepts", async () => {
    const { rootDir, config, write } = await createCliVault();
    const bundlePath = path.join(rootDir, "okf-bundle");
    await write("okf-bundle/index.md", "# Sales OKF\n");
    await write(
      "okf-bundle/tables/orders.md",
      "---\ntype: BigQuery Table\ntitle: Orders\n---\nOne row per completed order.\n",
    );

    const importResult = JSON.parse(
      await runWiki(config, ["okf", "import", bundlePath, "--json"]),
    ) as {
      importedCount: number;
      pagePaths: string[];
    };
    expect(importResult.importedCount).toBe(1);
    expect(importResult.pagePaths).toEqual([
      expect.stringMatching(/^concepts\/okf-okf-bundle-[0-9a-f]{8}-tables-orders-/),
    ]);

    const searchResults = JSON.parse(
      await runWiki(config, ["search", "completed order", "--json"]),
    ) as Array<{ title: string }>;
    expect(searchResults.map(({ title }) => title)).toContain("Orders");
  });

  it.each([
    [[...synthesisArgs, "--source-id", "source.alpha"], "--confidence", "Infinity"],
    [["apply", "metadata", "entity.alpha"], "--confidence", "1.5"],
    [["apply", "metadata", "entity.alpha"], "--confidence", "1e-1"],
    [["search", "alpha"], "--max-results", "0x10"],
    [["get", "entity.alpha"], "--from", "1e2"],
    [["get", "entity.alpha"], "--lines", "1.5"],
  ] as const)("rejects %j %s=%s before dispatch", async (command, flag, value) => {
    const { config } = await createCliVault();
    const program = createProgram(config);
    const range = flag === "--confidence" ? "a number between 0 and 1" : "a positive integer";
    await expect(
      program.parseAsync(["wiki", ...command, flag, value], { from: "user" }),
    ).rejects.toThrow(`${flag} must be ${range}.`);
  });

  it("reports invalid search backends through Commander before dispatch", async () => {
    const { config } = await createCliVault({ initialize: false });
    const writeErr = vi.fn();
    const program = createProgram(config, undefined, false, writeErr);

    await expect(
      program.parseAsync(["wiki", "search", "alpha", "--backend", "bogus"], { from: "user" }),
    ).rejects.toMatchObject({
      name: "CommanderError",
      code: "commander.invalidArgument",
      exitCode: 1,
    });
    expect(writeErr.mock.calls.flat().join("")).toContain("Invalid backend: bogus");
    expect(callGatewayFromCliMock).not.toHaveBeenCalled();
  });

  it("accepts signed and zero-padded wiki get line options", async () => {
    const { config, write } = await createCliVault();
    await write("syntheses/cli-lines.md", "# CLI Lines\n\nfirst\nsecond\n");

    await runWiki(config, ["get", "syntheses/cli-lines.md", "--from", "+01", "--lines", "02"]);
  });

  it("registers apply metadata and preserves the page body", async () => {
    const { config, page, read } = await createCliVault();
    await page(
      "entities/alpha.md",
      {
        pageType: "entity",
        id: "entity.alpha",
        title: "Alpha",
        sourceIds: ["source.old"],
        confidence: 0.2,
      },
      "# Alpha\n\n## Notes\n<!-- openclaw:human:start -->\ncli note\n<!-- openclaw:human:end -->\n",
    );

    await runWiki(config, [
      "apply",
      "metadata",
      "entity.alpha",
      "--source-id",
      "source.new",
      "--contradiction",
      "Conflicts with source.beta",
      "--question",
      "Still active?",
      "--status",
      "review",
      "--clear-confidence",
    ]);

    const parsed = parseWikiMarkdown(await read("entities/alpha.md"));
    expect(parsed.frontmatter).toMatchObject({
      sourceIds: ["source.new"],
      contradictions: ["Conflicts with source.beta"],
      questions: ["Still active?"],
      status: "review",
    });
    expect(parsed.frontmatter).not.toHaveProperty("confidence");
    expect(parsed.body).toContain("cli note");
  });

  it("runs wiki doctor and sets a non-zero exit code when warnings exist", async () => {
    const { rootDir, config } = await createCliVault({
      config: { vaultMode: "bridge", bridge: { enabled: false } },
    });
    await fs.rm(rootDir, { recursive: true, force: true });

    await runWiki(config, ["doctor", "--json"]);

    expect(process.exitCode).toBe(1);
    expect(callGatewayFromCliMock).not.toHaveBeenCalled();
  });

  it("sanitizes gateway status text output without changing JSON output", async () => {
    const { config } = await createBridgeCliVault();
    const unsafeStatus = createGatewayStatus({
      ...config,
      vault: { path: "\u001B[2J/tmp/wiki\nforged prompt\u202E" },
    });
    unsafeStatus.warnings = warnings("missing artifacts\r\nfake success\u001B[31m\u202E");
    callGatewayFromCliMock.mockResolvedValueOnce(unsafeStatus);

    const renderedText = await runWiki(config, ["status"]);
    expect(renderedText).not.toContain("\u001B");
    expect(renderedText).not.toContain("\u202E");
    expect(renderedText).toContain("(/tmp/wiki forged prompt)");
    expect(renderedText).toContain("- missing artifacts fake success");

    callGatewayFromCliMock.mockResolvedValueOnce(unsafeStatus);

    const renderedJson = await runWiki(config, ["status", "--json"]);
    expect(renderedJson).not.toContain("\u001B");
    expect(renderedJson).not.toContain("\u202E");
    expect(renderedJson).not.toContain("\r");
    expect(renderedJson).toContain("\\u001b[2J/tmp/wiki\\nforged prompt\\u202e");
    expect(renderedJson).toContain("missing artifacts\\r\\nfake success\\u001b[31m\\u202e");

    const parsed = JSON.parse(renderedJson) as MemoryWikiStatus;
    expect(parsed.vaultPath).toBe("\u001B[2J/tmp/wiki\nforged prompt\u202E");
    expect(parsed.warnings[0]?.message).toBe("missing artifacts\r\nfake success\u001B[31m\u202E");
  });

  it("rejects oversized gateway strings before rendering", async () => {
    const { config } = await createBridgeCliVault();
    const status = createGatewayStatus(config);
    status.warnings = warnings("x".repeat(10_001));
    callGatewayFromCliMock.mockResolvedValueOnce(status);

    await expect(runWiki(config, ["status"])).rejects.toThrow(
      "Invalid Gateway response for wiki.status.",
    );
  });

  it("truncates gateway status text output without splitting surrogate pairs", async () => {
    const { config } = await createBridgeCliVault();
    const status = createGatewayStatus(config);
    const warningWithoutMessage = renderMemoryWikiStatus({
      ...status,
      warnings: warnings(""),
    });
    const warningPrefix = "x".repeat(1_999 - warningWithoutMessage.length);
    status.warnings = warnings(`${warningPrefix}\u{1F600}tail`);
    const renderedStatus = renderMemoryWikiStatus(status);
    expect(renderedStatus.charCodeAt(1_999)).toBe(0xd83d);
    expect(renderedStatus.charCodeAt(2_000)).toBe(0xde00);
    callGatewayFromCliMock.mockResolvedValueOnce(status);

    const renderedText = await runWiki(config, ["status"]);
    const truncationMarker = "... [truncated]\n";
    expect(renderedText.length).toBeLessThanOrEqual(2_000 + truncationMarker.length);
    expect(renderedText.length).toBeGreaterThan(1_990 + truncationMarker.length);
    expect(renderedText.endsWith(truncationMarker)).toBe(true);
    expect(renderedText).not.toContain("\ud83d");
    expect(Buffer.from(renderedText).includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    expect(renderedText).not.toContain("tail");
  });

  it("routes active bridge imports through the gateway and keeps disabled bridge imports local", async () => {
    const active = await createBridgeCliVault();
    callGatewayFromCliMock.mockResolvedValueOnce({
      ...emptyBridgeImport,
      importedCount: 1,
      artifactCount: 1,
      workspaces: 1,
      pagePaths: ["sources/bridge-alpha.md"],
      indexesRefreshed: true,
      indexUpdatedFiles: ["index.md"],
      indexRefreshReason: "import-changed",
    });

    const activeResult = JSON.parse(
      await runWiki(active.config, ["bridge", "import", "--json"]),
    ) as { importedCount: number };

    expect(activeResult.importedCount).toBe(1);
    expect(callGatewayFromCliMock).toHaveBeenCalledWith(
      "wiki.bridge.import",
      { timeout: "30000" },
      undefined,
      { progress: false },
    );

    callGatewayFromCliMock.mockClear();
    const disabled = await createCliVault({
      config: {
        vaultMode: "bridge",
        bridge: { enabled: false },
      },
    });

    const disabledResult = JSON.parse(
      await runWiki(disabled.config, ["bridge", "import", "--json"]),
    ) as { artifactCount: number };

    expect(disabledResult.artifactCount).toBe(0);
    expect(callGatewayFromCliMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects malformed UTF-8 ChatGPT exports (envelope: %s)",
    async (envelope) => {
      const { rootDir, config, exportDir } = await createChatGptVault();
      const exportPath = path.join(exportDir, "conversations.json");
      const conversations = JSON.parse(await fs.readFile(exportPath, "utf8")) as Array<{
        title: string;
      }>;
      expectDefined(conversations[0], "export conversation").title = "Café 🤖 �";
      await fs.writeFile(exportPath, JSON.stringify(envelope ? { conversations } : conversations));
      const args = ["chatgpt", "import", "--export", exportDir, "--json"];
      const seed = JSON.parse(await runWiki(config, args)) as {
        createdCount: number;
      };
      expect(seed.createdCount).toBe(1);
      const sourcePath = path.join(rootDir, "sources", await findImportedSourceFile(rootDir));
      const before = await fs.readFile(sourcePath, "utf8");
      expect(before).toContain("Café 🤖 �");
      const raw = Buffer.from(JSON.stringify(envelope ? { conversations } : conversations));
      raw[raw.indexOf(Buffer.from("Café"))] = 0xff;
      await fs.writeFile(exportPath, raw);
      const inboxPath = path.join(rootDir, "inbox.md");
      await fs.unlink(inboxPath);
      await expect(runWiki(config, args)).rejects.toThrow(
        `ChatGPT conversations export must be valid UTF-8: ${exportPath}. Download a fresh ChatGPT export and retry the import.`,
      );
      expect(await fs.readFile(sourcePath, "utf8")).toBe(before);
      expect(await fs.readFile(exportPath)).toEqual(raw);
      await expect(fs.access(inboxPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("imports out-of-range ChatGPT timestamps with dry-run, apply, and rollback", async () => {
    const vault = await createChatGptVault({ update_time: 9_000_000_000_000 });
    const { rootDir } = vault;

    const dryRun = await vault.import("--dry-run");
    expect(dryRun).toMatchObject({ dryRun: true, createdCount: 1 });
    await expect(fs.readdir(path.join(rootDir, "sources"))).resolves.toStrictEqual([]);

    const applied = await vault.import();
    expect(applied.runId).toMatch(/^chatgpt-[a-f0-9]{12}$/u);
    expect(applied.createdCount).toBe(1);
    await expect(
      fs.stat(path.join(rootDir, ".openclaw-wiki", "import-runs", `${applied.runId ?? ""}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const pageContent = await fs.readFile(await vault.sourcePath(), "utf8");
    expect(pageContent).toContain("ChatGPT Export: Travel preference check");
    expect(pageContent).toContain("I prefer aisle seats");
    expect(pageContent).toContain("Preference signals:");
    expect(pageContent).toContain("- Created: 2024-04-06T00:26:40.000Z");
    expect(pageContent).toContain("- Updated: 2024-04-06T00:26:40.000Z");

    const secondDryRun = await vault.import("--dry-run");
    expect(secondDryRun).toMatchObject({ createdCount: 0, updatedCount: 0, skippedCount: 1 });
    const rollback = await vault.rollback(expectDefined(applied.runId, "import runId"));
    expect(rollback.alreadyRolledBack).toBe(false);
    expect(rollback.preservedPaths).toStrictEqual([]);
    await expect(
      fs
        .readdir(path.join(rootDir, "sources"))
        .then((entries) => entries.filter((entry) => entry !== "index.md")),
    ).resolves.toStrictEqual([]);
  });

  it.each(["compile", "lint"])(
    "runs one compile cycle when `wiki %s` finds indexes missing after its source import",
    async (command) => {
      const { rootDir, config } = await createCliVault({ initialize: true });
      await fs.rm(path.join(rootDir, "index.md"), { force: true });

      const output = await runWiki(config, [command, "--json"]);

      const log = await fs.readFile(path.join(rootDir, ".openclaw-wiki", "log.jsonl"), "utf8");
      const cycles = log.split("\n").filter((line) => line.includes('"pageCounts"')).length;
      expect(cycles).toBe(1);
      if (command === "compile") {
        expect(JSON.parse(output).updatedFiles).toContain(path.join(rootDir, "index.md"));
      }
    },
  );

  it("preserves a user save after compile before the import run record is written", async () => {
    const vault = await createChatGptVault();
    let pagePath = "";
    let edited = "";
    afterCompileHook.run = async () => {
      if (pagePath) {
        return;
      }
      pagePath = await vault.sourcePath();
      edited = `${await fs.readFile(pagePath, "utf8")}\nUser save after compile.\n`;
      await fs.writeFile(pagePath, edited, "utf8");
    };

    const applied = await vault.import();
    afterCompileHook.run = undefined;
    const runId = expectDefined(applied.runId, "ChatGPT import runId");

    const rollback = await vault.rollback(runId);

    expect(pagePath).not.toBe("");
    await expect(fs.stat(pagePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(rollback.preservedPaths).toHaveLength(1);
    const preserved = expectDefined(rollback.preservedPaths[0], "preserved post-compile save");
    expect(preserved.path).toBe(`sources/${path.basename(pagePath)}`);
    await expect(vault.read(preserved.recoveryPath)).resolves.toBe(edited);
  });

  it("reports the rollback command when compilation fails after a ChatGPT import", async () => {
    const vault = await createChatGptVault();
    const { rootDir, exportDir } = vault;
    const firstApplied = await vault.import();
    const firstRunId = expectDefined(firstApplied.runId, "first ChatGPT import runId");
    const pagePath = await vault.sourcePath();
    const firstContent = await fs.readFile(pagePath, "utf8");

    const reportPath = path.join(rootDir, "reports", "stale-pages.md");
    const validReport = await fs.readFile(reportPath, "utf8");
    await fs.writeFile(reportPath, "---\nmalformed\n---\n# Stale Pages\n", "utf8");

    await updateExportReply(exportDir, "Updated: window seats now.");

    let importError: unknown;
    try {
      await vault.import();
    } catch (error) {
      importError = error;
    }
    const message = importError instanceof Error ? importError.message : "";
    const failedRunId = message.match(/chatgpt-[a-f0-9]{12}/u)?.[0];
    expect(failedRunId).toBeDefined();
    expect(failedRunId).not.toBe(firstRunId);
    expect(message).toContain("changed source pages, but vault compilation failed");
    expect(message).toContain(`openclaw wiki chatgpt rollback ${failedRunId}`);
    await expect(fs.readFile(pagePath, "utf8")).resolves.not.toBe(firstContent);

    await fs.writeFile(reportPath, validReport, "utf8");
    const rollback = await vault.rollback(failedRunId!);
    expect(rollback.restoredCount).toBe(1);
    await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(firstContent);
  });

  it("preserves a page recreated between the rollback move-aside and the snapshot restore", async () => {
    const vault = await createChatGptVault();
    const { rootDir, exportDir } = vault;
    await vault.import();
    const pagePath = await vault.sourcePath();
    const firstImportContent = await fs.readFile(pagePath, "utf8");

    await updateExportReply(exportDir, "Updated reply.");
    const secondApplied = await vault.import();
    const secondRunId = expectDefined(secondApplied.runId, "second ChatGPT import runId");

    const concurrentSave = "Concurrent editor save during rollback.\n";
    let recreated = false;
    const recoveryDestinations: string[] = [];
    const canonicalPagePath = await fs.realpath(pagePath);
    const recoveryRoot = path.join(
      await fs.realpath(rootDir),
      ".openclaw-wiki",
      "import-runs",
      secondRunId,
      "recovered",
    );
    afterMoveHook.run = async (from, to) => {
      if (
        from !== canonicalPagePath ||
        path.dirname(path.dirname(to)) !== recoveryRoot ||
        path.basename(to) !== "content"
      ) {
        return;
      }
      if (!recreated) {
        recreated = true;
        await fs.writeFile(from, concurrentSave, "utf8");
      }
      recoveryDestinations.push(to);
    };
    const rollback = await vault.rollback(secondRunId);
    afterMoveHook.run = undefined;

    expect(recreated).toBe(true);
    expect(recoveryDestinations).toHaveLength(2);
    expect(new Set(recoveryDestinations).size).toBe(2);
    expect(rollback.restoredCount).toBe(1);
    await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(firstImportContent);
    expect(rollback.preservedPaths).toHaveLength(1);
    const preserved = expectDefined(rollback.preservedPaths[0], "preserved recreated page");
    expect(preserved.path).toBe(`sources/${path.basename(pagePath)}`);
    await expect(vault.read(preserved.recoveryPath)).resolves.toBe(concurrentSave);
  });

  describe("memory-wiki agent-scoped cli", () => {
    const appConfig = { agents: { entries: { support: {}, marketing: {} } } };

    it("gives actionable agent-selection guidance for a multi-agent roster", async () => {
      const { config } = await createCliVault({ config: { vault: { scope: "agent" } } });
      await expect(
        runWiki(config, ["apply", "metadata", "entity.alpha"], appConfig, true),
      ).rejects.toThrow(
        "No default memory-wiki agent is configured. Pass --agent <id>, or add an agent with `openclaw agents add`.",
      );
    });

    it("runs wiki doctor against explicitly selected agent-scoped vaults", async () => {
      const { rootDir, config } = await createCliVault({ config: { vault: { scope: "agent" } } });
      for (const agent of ["marketing", "support"]) {
        await runWiki(config, ["init", "--agent", agent], appConfig, true);
        const output = await runWiki(config, ["doctor", "--agent", agent], appConfig, true);
        expect(output).toContain("Wiki doctor: healthy");
        expect(output).toContain(`Vault scope: agent (${agent})`);
        expect(output).toContain(path.join(rootDir, agent));
      }
    });

    it("does not require an agent to probe Obsidian CLI availability", async () => {
      const { config } = await createCliVault({ config: { vault: { scope: "agent" } } });
      const program = createProgram(config, { agents: { entries: {} } }, true);
      const obsidian = program.commands[0]!.commands.find(
        (command) => command.name() === "obsidian",
      )!;
      const action = vi.fn();
      obsidian.commands.find((command) => command.name() === "status")!.action(action);
      await expect(
        program.parseAsync(["wiki", "obsidian", "status"], { from: "user" }),
      ).resolves.toBeDefined();
      expect(action).toHaveBeenCalledOnce();
    });
  });
});
