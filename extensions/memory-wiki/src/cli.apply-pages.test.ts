// Memory Wiki tests cover the concept and entity `wiki apply` CLI commands.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWikiCli } from "./cli.js";
import { parseWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();
let suiteRoot = "";
let caseIndex = 0;

describe("memory-wiki cli apply pages", () => {
  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-cli-apply-pages-"));
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function runWikiCommand(args: string[]) {
    const vault = await createVault({
      prefix: "memory-wiki-cli-apply-pages-",
      rootDir: path.join(suiteRoot, `case-${caseIndex++}`),
    });
    const program = new Command();
    program.name("test");
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerWikiCli(program, { config: vault.config });
    await program.parseAsync(["wiki", ...args], { from: "user" });
    return vault;
  }

  it("registers apply concept and writes a concept page", async () => {
    const { rootDir } = await runWikiCommand([
      "apply",
      "concept",
      "CLI Concept",
      "--body",
      "Concept from CLI.",
      "--source-id",
      "source.alpha",
      "--status",
      "seed",
    ]);

    const parsed = parseWikiMarkdown(
      await fs.readFile(path.join(rootDir, "concepts", "cli-concept.md"), "utf8"),
    );
    expect(parsed.frontmatter).toMatchObject({
      pageType: "concept",
      id: "concept.cli-concept",
      sourceIds: ["source.alpha"],
      status: "seed",
    });
    expect(parsed.body).toContain("Concept from CLI.");
    await expect(
      fs.readFile(path.join(rootDir, "concepts", "index.md"), "utf8"),
    ).resolves.toContain("[CLI Concept](cli-concept.md)");
  });

  it("registers apply entity and writes entity metadata", async () => {
    const { rootDir } = await runWikiCommand([
      "apply",
      "entity",
      "CLI Entity",
      "--body",
      "Entity from CLI.",
      "--source-id",
      "source.alpha",
      "--entity-type",
      "system",
      "--canonical-id",
      "system.cli-entity",
      "--alias",
      "cli-svc",
      "--alias",
      "CLI",
    ]);

    const parsed = parseWikiMarkdown(
      await fs.readFile(path.join(rootDir, "entities", "cli-entity.md"), "utf8"),
    );
    expect(parsed.frontmatter).toMatchObject({
      pageType: "entity",
      id: "entity.cli-entity",
      entityType: "system",
      canonicalId: "system.cli-entity",
      aliases: ["cli-svc", "CLI"],
      sourceIds: ["source.alpha"],
    });
    expect(parsed.body).toContain("Entity from CLI.");
    await expect(
      fs.readFile(path.join(rootDir, "entities", "index.md"), "utf8"),
    ).resolves.toContain("[CLI Entity](cli-entity.md)");
  });

  it("rejects apply concept and entity without a source id or body", async () => {
    await expect(
      runWikiCommand(["apply", "concept", "No Source", "--body", "Body"]),
    ).rejects.toThrow("wiki apply concept requires at least one --source-id.");
    await expect(
      runWikiCommand(["apply", "entity", "No Body", "--source-id", "source.alpha"]),
    ).rejects.toThrow("wiki apply entity requires --body or --body-file.");
  });
});
