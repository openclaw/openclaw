// Memory Wiki tests cover the per-compile page scan cache.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { renderWikiMarkdown, scanWikiPageSummary } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

vi.mock("./markdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./markdown.js")>();
  return { ...actual, scanWikiPageSummary: vi.fn(actual.scanWikiPageSummary) };
});

const { createVault } = createMemoryWikiTestHarness();

function writePage(targetPath: string, markdown: Parameters<typeof renderWikiMarkdown>[0]) {
  return fs.writeFile(targetPath, renderWikiMarkdown(markdown), "utf8");
}

function scannedContentKeys(): string[] {
  return vi
    .mocked(scanWikiPageSummary)
    .mock.calls.map(([params]) => `${params.relativePath}\n${params.raw}`);
}

describe("compileMemoryWikiVault page scan cache", () => {
  it("parses each distinct page text once per compile, including pages rewritten mid-compile", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-scan-cache-",
      initialize: true,
    });
    await writePage(path.join(rootDir, "sources", "alpha.md"), {
      frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
      body: "# Alpha\n",
    });
    await writePage(path.join(rootDir, "entities", "beta.md"), {
      frontmatter: {
        pageType: "entity",
        id: "entity.beta",
        title: "Beta",
        sourceIds: ["source.alpha"],
      },
      body: "# Beta\n",
    });
    await writePage(path.join(rootDir, "concepts", "gamma.md"), {
      frontmatter: { pageType: "concept", id: "concept.gamma", title: "Gamma" },
      body: "# Gamma\n",
    });
    vi.mocked(scanWikiPageSummary).mockClear();

    const result = await compileMemoryWikiVault(config);

    const keys = scannedContentKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);

    // Beta's related block is written during the compile, so the later scans
    // must parse the rewritten text instead of reusing the first scan's result.
    const betaKeys = keys.filter((key) => key.startsWith("entities/beta.md\n"));
    expect(betaKeys).toHaveLength(2);
    expect(betaKeys.filter((key) => key.includes("## Related"))).toHaveLength(1);
    expect(result.pages.find((page) => page.id === "entity.beta")).toBeDefined();
  });

  it("does not carry cached scans from one compile into the next", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-scan-cache-",
      initialize: true,
    });
    const pagePath = path.join(rootDir, "concepts", "gamma.md");
    await writePage(pagePath, {
      frontmatter: { pageType: "concept", id: "concept.gamma", title: "Gamma" },
      body: "# Gamma\n",
    });
    await compileMemoryWikiVault(config);

    await writePage(pagePath, {
      frontmatter: { pageType: "concept", id: "concept.gamma", title: "Gamma Renamed" },
      body: "# Gamma Renamed\n",
    });
    const result = await compileMemoryWikiVault(config);

    expect(result.pages.find((page) => page.id === "concept.gamma")?.title).toBe("Gamma Renamed");
  });
});
