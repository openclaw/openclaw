import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWikiMarkdown, renderWikiMarkdown } from "./markdown.js";
import {
  ensurePageStructure,
  findOrphanSourceShells,
  isOrphanSourceShell,
  repairMemoryWikiVault,
} from "./structure-repair.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("ensurePageStructure", () => {
  it("backfills id, pageType, title, and updatedAt on a human-authored concept", async () => {
    const { rootDir } = await createVault({ initialize: true });
    const relativePath = "concepts/dreaming-protocol.md";
    await fs.writeFile(
      path.join(rootDir, relativePath),
      "---\nkind: protocol\n---\n\n# Dreaming Protocol\n\nBody here.\n",
      "utf8",
    );

    const result = await ensurePageStructure({
      rootDir,
      relativePath,
      nowIso: "2026-04-19T00:00:00.000Z",
    });

    expect(result.operation).toBe("backfilled-structure");
    expect(result.fieldsAdded.toSorted()).toEqual(["id", "pageType", "title", "updatedAt"]);

    const raw = await fs.readFile(path.join(rootDir, relativePath), "utf8");
    const parsed = parseWikiMarkdown(raw);
    expect(parsed.frontmatter.id).toBe("concept.dreaming-protocol");
    expect(parsed.frontmatter.pageType).toBe("concept");
    expect(parsed.frontmatter.title).toBe("Dreaming Protocol");
    expect(parsed.frontmatter.kind).toBe("protocol");
    expect(typeof parsed.frontmatter.updatedAt).toBe("string");
    expect(parsed.body.trim()).toBe("# Dreaming Protocol\n\nBody here.");
  });

  it("is a no-op when all required fields are present", async () => {
    const { rootDir } = await createVault({ initialize: true });
    const relativePath = "entities/alpha.md";
    const original = renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        id: "entity.alpha",
        title: "Alpha",
        updatedAt: "2026-04-18T12:00:00.000Z",
      },
      body: "# Alpha\n",
    });
    await fs.writeFile(path.join(rootDir, relativePath), original, "utf8");

    const result = await ensurePageStructure({
      rootDir,
      relativePath,
      nowIso: "2026-04-19T00:00:00.000Z",
    });

    expect(result.operation).toBe("skipped");
    expect(result.fieldsAdded).toEqual([]);
    const raw = await fs.readFile(path.join(rootDir, relativePath), "utf8");
    expect(raw).toBe(original);
  });

  it("falls back to filename for title when no heading or title field exists", async () => {
    const { rootDir } = await createVault({ initialize: true });
    const relativePath = "entities/bare-page.md";
    await fs.writeFile(path.join(rootDir, relativePath), "Just prose, no heading.\n", "utf8");

    const result = await ensurePageStructure({
      rootDir,
      relativePath,
      nowIso: "2026-04-19T00:00:00.000Z",
    });

    expect(result.operation).toBe("backfilled-structure");
    const raw = await fs.readFile(path.join(rootDir, relativePath), "utf8");
    const parsed = parseWikiMarkdown(raw);
    expect(parsed.frontmatter.title).toBe("bare page");
    expect(parsed.frontmatter.pageType).toBe("entity");
    expect(parsed.frontmatter.id).toBe("entity.bare-page");
  });
});

describe("isOrphanSourceShell", () => {
  it("detects the related-block-only shell produced by stray compile runs", () => {
    const shell = [
      "## Related",
      "<!-- openclaw:wiki:related:start -->",
      "- No related pages yet.",
      "<!-- openclaw:wiki:related:end -->",
    ].join("\n");
    expect(isOrphanSourceShell(shell)).toBe(true);
  });

  it("does not mis-classify a page whose body has real content", () => {
    const body = [
      "# Real Title",
      "",
      "Real content here.",
      "",
      "## Related",
      "<!-- openclaw:wiki:related:start -->",
      "- No related pages yet.",
      "<!-- openclaw:wiki:related:end -->",
    ].join("\n");
    expect(isOrphanSourceShell(body)).toBe(false);
  });
});

describe("repairMemoryWikiVault", () => {
  it("backfills structure across an unhealthy vault and optionally removes orphans", async () => {
    const { rootDir, config } = await createVault({ initialize: true });

    await fs.writeFile(
      path.join(rootDir, "concepts", "unstructured.md"),
      "# Concept Alpha\n\nSome prose.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "canon", "2026-04-25.md"),
      "# Daily Canon\n\nSome canon prose.\n",
      "utf8",
    );

    const orphanShell =
      "## Related\n<!-- openclaw:wiki:related:start -->\n- No related pages yet.\n<!-- openclaw:wiki:related:end -->\n";
    await fs.writeFile(path.join(rootDir, "sources", "orphan.md"), orphanShell, "utf8");

    await fs.writeFile(
      path.join(rootDir, "entities", "healthy.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.healthy",
          title: "Healthy",
          updatedAt: "2026-04-18T12:00:00.000Z",
        },
        body: "# Healthy\n",
      }),
      "utf8",
    );

    const detectedOrphans = await findOrphanSourceShells(config);
    expect(detectedOrphans).toEqual(["sources/orphan.md"]);

    const result = await repairMemoryWikiVault(config, {
      removeOrphans: true,
      nowMs: Date.UTC(2026, 3, 19),
    });

    expect(result.backfilled).toBe(2);
    expect(result.orphansRemoved).toBe(1);
    expect(
      result.pages.find((entry) => entry.relativePath === "concepts/unstructured.md")?.operation,
    ).toBe("backfilled-structure");
    expect(
      result.pages.find((entry) => entry.relativePath === "canon/2026-04-25.md")?.operation,
    ).toBe("backfilled-structure");
    expect(
      result.pages.find((entry) => entry.relativePath === "sources/orphan.md")?.operation,
    ).toBe("removed-orphan");
    expect(
      result.pages.find((entry) => entry.relativePath === "entities/healthy.md")?.operation,
    ).toBe("skipped");

    await expect(
      fs.stat(path.join(rootDir, "sources", "orphan.md")).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);

    const repaired = await fs.readFile(path.join(rootDir, "concepts", "unstructured.md"), "utf8");
    const parsed = parseWikiMarkdown(repaired);
    expect(parsed.frontmatter.id).toBe("concept.unstructured");
    expect(parsed.frontmatter.pageType).toBe("concept");
    expect(parsed.frontmatter.title).toBe("Concept Alpha");
    expect(typeof parsed.frontmatter.updatedAt).toBe("string");

    const repairedCanon = await fs.readFile(path.join(rootDir, "canon", "2026-04-25.md"), "utf8");
    const parsedCanon = parseWikiMarkdown(repairedCanon);
    expect(parsedCanon.frontmatter.id).toBe("canon.2026-04-25");
    expect(parsedCanon.frontmatter.pageType).toBe("canon");
    expect(parsedCanon.frontmatter.title).toBe("Daily Canon");
  });

  it("preserves orphan shells when removeOrphans is not set", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const shell =
      "## Related\n<!-- openclaw:wiki:related:start -->\n- No related pages yet.\n<!-- openclaw:wiki:related:end -->\n";
    await fs.writeFile(path.join(rootDir, "sources", "stay.md"), shell, "utf8");

    const result = await repairMemoryWikiVault(config);
    expect(result.orphansRemoved).toBe(0);
    await expect(fs.readFile(path.join(rootDir, "sources", "stay.md"), "utf8")).resolves.toBe(
      shell,
    );
  });
});
