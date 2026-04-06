import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWikiCli } from "./cli.js";
import { parseWikiMarkdown, renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("memory-wiki cli", () => {
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

  it("registers apply synthesis and writes a synthesis page", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-cli-" });
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
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-cli-",
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
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
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-cli-",
      config: {
        obsidian: { enabled: true, useOfficialCli: true },
      },
    });
    const program = new Command();
    program.name("test");
    registerWikiCli(program, config);
    await fs.rm(rootDir, { recursive: true, force: true });

    await program.parseAsync(["wiki", "doctor", "--json"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });
});
