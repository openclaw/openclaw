import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("compileMemoryWikiVault", () => {
  it("writes root and directory indexes for native markdown", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-compile-",
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.source).toBe(1);
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "index.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
  });

  it("renders obsidian-friendly links when configured", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-compile-",
      initialize: true,
      config: {
        vault: { renderMode: "obsidian" },
      },
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[[sources/alpha|Alpha]]",
    );
  });

  it("writes related blocks from source ids and shared sources", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-compile-",
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "beta.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.beta",
          title: "Beta",
          sourceIds: ["source.alpha"],
        },
        body: "# Beta\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "gamma.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "concept",
          id: "concept.gamma",
          title: "Gamma",
          sourceIds: ["source.alpha"],
        },
        body: "# Gamma\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "## Related",
    );
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8")).resolves.toContain(
      "[Beta](entities/beta.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
  });

  it("writes dashboard report pages when createDashboards is enabled", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-compile-",
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.alpha"],
          questions: ["What changed after launch?"],
          contradictions: ["Conflicts with source.beta"],
          confidence: 0.3,
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha Source",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        body: "# Alpha Source\n",
      }),
      "utf8",
    );

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.report).toBeGreaterThanOrEqual(4);
    await expect(
      fs.readFile(path.join(rootDir, "reports", "open-questions.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): What changed after launch?");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "contradictions.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): Conflicts with source.beta");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "low-confidence.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): confidence 0.30");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "stale-pages.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): missing updatedAt");
  });

  it("skips dashboard report pages when createDashboards is disabled", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-compile-",
      initialize: true,
      config: {
        render: { createDashboards: false },
      },
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.alpha"],
          questions: ["What changed after launch?"],
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.access(path.join(rootDir, "reports", "open-questions.md"))).rejects.toThrow();
  });

  it("ignores generated related links when computing backlinks on repeated compile", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-compile-",
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "beta.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "entity", id: "entity.beta", title: "Beta" },
        body: "# Beta\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "gamma.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "concept", id: "concept.gamma", title: "Gamma" },
        body: "# Gamma\n\nSee [Beta](entities/beta.md).\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);
    const second = await compileMemoryWikiVault(config);

    expect(second.updatedFiles).toEqual([]);
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
    await expect(
      fs.readFile(path.join(rootDir, "concepts", "gamma.md"), "utf8"),
    ).resolves.not.toContain("### Referenced By");
  });
});
