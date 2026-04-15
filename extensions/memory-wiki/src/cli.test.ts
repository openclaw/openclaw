import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerWikiCli,
  runWikiBridgeImport,
  runWikiChatGptImport,
  runWikiChatGptRollback,
} from "./cli.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { parseWikiMarkdown, renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();
let suiteRoot = "";
let caseIndex = 0;

describe("memory-wiki cli", () => {
  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-cli-suite-"));
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function createCliVault(options?: {
    config?: MemoryWikiPluginConfig;
    initialize?: boolean;
  }) {
    return createVault({
      prefix: "memory-wiki-cli-",
      rootDir: path.join(suiteRoot, `case-${caseIndex++}`),
      initialize: options?.initialize,
      config: options?.config,
    });
  }

  async function createChatGptExport(rootDir: string) {
    const exportDir = path.join(rootDir, "chatgpt-export");
    await fs.mkdir(exportDir, { recursive: true });
    const conversations = [
      {
        conversation_id: "12345678-1234-1234-1234-1234567890ab",
        title: "Travel preference check",
        create_time: 1_712_363_200,
        update_time: 1_712_366_800,
        current_node: "assistant-1",
        mapping: {
          root: {},
          "user-1": {
            parent: "root",
            message: {
              author: { role: "user" },
              content: {
                parts: ["I prefer aisle seats and I don't want a hotel far from the airport."],
              },
            },
          },
          "assistant-1": {
            parent: "user-1",
            message: {
              author: { role: "assistant" },
              content: {
                parts: ["Noted. I will keep travel options close to the airport."],
              },
            },
          },
        },
      },
    ];
    await fs.writeFile(
      path.join(exportDir, "conversations.json"),
      `${JSON.stringify(conversations, null, 2)}\n`,
      "utf8",
    );
    return exportDir;
  }

  it("registers apply synthesis and writes a synthesis page", async () => {
    const { rootDir, config } = await createCliVault();
    const program = new Command();
    program.name("test");
    registerWikiCli(program, config);

    await program.parseAsync(
      [
        "wiki",
        "apply",
        "synthesis",
        "CLI Alpha",
        "--body",
        "Alpha from CLI.",
        "--source-id",
        "source.alpha",
        "--source-id",
        "source.beta",
      ],
      { from: "user" },
    );

    const page = await fs.readFile(path.join(rootDir, "syntheses", "cli-alpha.md"), "utf8");
    expect(page).toContain("Alpha from CLI.");
    expect(page).toContain("source.alpha");
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[CLI Alpha](syntheses/cli-alpha.md)",
    );
  });

  it("registers apply metadata and preserves the page body", async () => {
    const { rootDir, config } = await createCliVault();
    const targetPath = path.join(rootDir, "entities", "alpha.md");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.old"],
          confidence: 0.2,
        },
        body: `# Alpha

## Notes
<!-- openclaw:human:start -->
cli note
<!-- openclaw:human:end -->
`,
      }),
      "utf8",
    );

    const program = new Command();
    program.name("test");
    registerWikiCli(program, config);

    await program.parseAsync(
      [
        "wiki",
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
      ],
      { from: "user" },
    );

    const page = await fs.readFile(path.join(rootDir, "entities", "alpha.md"), "utf8");
    const parsed = parseWikiMarkdown(page);
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
      config: {
        vaultMode: "bridge",
        bridge: { enabled: false },
      },
    });
    const program = new Command();
    program.name("test");
    registerWikiCli(program, config);
    await fs.rm(rootDir, { recursive: true, force: true });

    await program.parseAsync(["wiki", "doctor", "--json"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("imports ChatGPT exports with dry-run, apply, and rollback", async () => {
    const { rootDir, config } = await createCliVault({ initialize: true });
    const exportDir = await createChatGptExport(rootDir);

    const dryRun = await runWikiChatGptImport({
      config,
      exportPath: exportDir,
      dryRun: true,
      json: true,
    });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.createdCount).toBe(1);
    await expect(fs.readdir(path.join(rootDir, "sources"))).resolves.toEqual([]);

    const applied = await runWikiChatGptImport({
      config,
      exportPath: exportDir,
      json: true,
    });
    expect(applied.runId).toBeTruthy();
    expect(applied.createdCount).toBe(1);
    const sourceFiles = (await fs.readdir(path.join(rootDir, "sources"))).filter(
      (entry) => entry !== "index.md",
    );
    expect(sourceFiles).toHaveLength(1);
    const pageContent = await fs.readFile(path.join(rootDir, "sources", sourceFiles[0]), "utf8");
    expect(pageContent).toContain("ChatGPT Export: Travel preference check");
    expect(pageContent).toContain("I prefer aisle seats");
    expect(pageContent).toContain("Preference signals:");

    const secondDryRun = await runWikiChatGptImport({
      config,
      exportPath: exportDir,
      dryRun: true,
      json: true,
    });
    expect(secondDryRun.createdCount).toBe(0);
    expect(secondDryRun.updatedCount).toBe(0);
    expect(secondDryRun.skippedCount).toBe(1);

    const rollback = await runWikiChatGptRollback({
      config,
      runId: applied.runId!,
      json: true,
    });
    expect(rollback.alreadyRolledBack).toBe(false);
    await expect(
      fs
        .readdir(path.join(rootDir, "sources"))
        .then((entries) => entries.filter((entry) => entry !== "index.md")),
    ).resolves.toEqual([]);
  });

  // Regression test for https://github.com/openclaw/openclaw/issues/67190:
  // CLI must route through the gateway RPC because memory-core's capability is
  // only populated inside the gateway daemon process.
  describe("runWikiBridgeImport", () => {
    it("calls the wiki.bridge.import gateway RPC and renders the result", async () => {
      const { config } = await createCliVault({ initialize: true });
      const callGateway = vi.fn(async () => ({
        importedCount: 3,
        updatedCount: 1,
        skippedCount: 2,
        removedCount: 0,
        artifactCount: 6,
        workspaces: 2,
        pagePaths: [],
        indexesRefreshed: true,
        indexUpdatedFiles: ["a.md", "b.md"],
        indexRefreshReason: "synced" as const,
      }));
      const writes: string[] = [];
      const stdout = {
        write: (chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
          return true;
        },
      };

      const result = await runWikiBridgeImport({
        config,
        gatewayOpts: { url: "ws://127.0.0.1:18789", token: "tok" },
        stdout,
        callGateway: callGateway as never,
      });

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(callGateway).toHaveBeenCalledWith(
        "wiki.bridge.import",
        expect.objectContaining({ url: "ws://127.0.0.1:18789", token: "tok" }),
        {},
      );
      expect(result.artifactCount).toBe(6);
      expect(writes.join("")).toContain("Bridge import synced 6 artifacts");
    });

    it("throws a clear error when the gateway returns no result", async () => {
      const { config } = await createCliVault({ initialize: true });
      const callGateway = vi.fn(async () => undefined);
      await expect(
        runWikiBridgeImport({ config, callGateway: callGateway as never }),
      ).rejects.toThrow(/gateway running/);
    });
  });
});
