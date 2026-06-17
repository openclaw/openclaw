import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyMemoryWikiMutation } from "./apply.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

async function listSynthesisPages(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(rootDir, "syntheses"));
  return entries.filter((entry) => entry.endsWith(".md") && entry !== "index.md").toSorted();
}

describe("title-keyed wiki page slug collisions", () => {
  it("keeps distinct syntheses whose titles slugify equal in separate pages", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-collision-" });

    const first = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Q3 Report",
        body: "Revenue grew 12 percent in Q3.",
        sourceIds: ["source.finance"],
        claims: [
          {
            id: "claim.q3.revenue",
            text: "Q3 revenue up 12 percent.",
            status: "supported",
            confidence: 0.9,
            evidence: [],
          },
        ],
        confidence: 0.9,
      },
    });

    const second = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Q3-Report",
        body: "Headcount fell 4 percent in Q3.",
        sourceIds: ["source.hr"],
        confidence: 0.5,
      },
    });

    expect(first.pagePath).toBe("syntheses/q3-report.md");
    expect(second.pagePath).not.toBe(first.pagePath);
    expect(second.pageId).not.toBe(first.pageId);
    expect(await listSynthesisPages(rootDir)).toHaveLength(2);

    const firstRaw = await fs.readFile(path.join(rootDir, first.pagePath), "utf8");
    const secondRaw = await fs.readFile(path.join(rootDir, second.pagePath), "utf8");
    expect(firstRaw).toContain("Revenue grew 12 percent");
    expect(firstRaw).toContain("claim.q3.revenue");
    expect(firstRaw).toContain("source.finance");
    expect(secondRaw).toContain("Headcount fell 4 percent");
    expect(secondRaw).not.toContain("Revenue grew 12 percent");

    const hits = await searchMemoryWiki({ config, query: "Revenue grew 12 percent" });
    expect(JSON.stringify(hits)).toContain("Revenue grew 12 percent");
  });

  it("still updates a synthesis in place when the same title is re-applied", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-idempotent-" });

    const first = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Q3 Report",
        body: "Revenue grew 12 percent in Q3.",
        sourceIds: ["source.finance"],
      },
    });
    const second = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Q3 Report",
        body: "Revenue grew 15 percent in Q3.",
        sourceIds: ["source.finance"],
      },
    });

    expect(second.pagePath).toBe(first.pagePath);
    expect(second.pageId).toBe(first.pageId);
    expect(await listSynthesisPages(rootDir)).toEqual(["q3-report.md"]);
    const raw = await fs.readFile(path.join(rootDir, first.pagePath), "utf8");
    expect(raw).toContain("Revenue grew 15 percent");
    expect(raw).not.toContain("Revenue grew 12 percent");
  });

  it("updates the existing hashed collision page when a colliding title is re-applied with surrounding whitespace", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-ws-collision-" });

    await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Q3 Report",
        body: "Revenue grew 12 percent.",
        sourceIds: ["source.finance"],
      },
    });
    const collided = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Q3-Report",
        body: "Headcount fell 4 percent.",
        sourceIds: ["source.hr"],
      },
    });
    const reapplied = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "  Q3-Report  ",
        body: "Headcount fell 6 percent.",
        sourceIds: ["source.hr"],
      },
    });

    expect(collided.pagePath).not.toBe("syntheses/q3-report.md");
    expect(reapplied.pagePath).toBe(collided.pagePath);
    expect(reapplied.pageId).toBe(collided.pageId);
    expect(await listSynthesisPages(rootDir)).toHaveLength(2);
    const raw = await fs.readFile(path.join(rootDir, collided.pagePath), "utf8");
    expect(raw).toContain("Headcount fell 6 percent.");
    expect(raw).not.toContain("Headcount fell 4 percent.");
  });

  it("keeps distinct ingested sources whose titles slugify equal in separate pages", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-collision-");
    const firstInput = path.join(rootDir, "first.txt");
    const secondInput = path.join(rootDir, "second.txt");
    await fs.writeFile(firstInput, "finance source body\n", "utf8");
    await fs.writeFile(secondInput, "headcount source body\n", "utf8");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    const first = await ingestMemoryWikiSource({
      config,
      inputPath: firstInput,
      title: "Q3 Report",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });
    const second = await ingestMemoryWikiSource({
      config,
      inputPath: secondInput,
      title: "Q3-Report",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(first.pagePath).toBe("sources/q3-report.md");
    expect(second.pagePath).not.toBe(first.pagePath);
    expect(second.pageId).not.toBe(first.pageId);

    const firstBody = await fs.readFile(path.join(config.vault.path, first.pagePath), "utf8");
    const secondBody = await fs.readFile(path.join(config.vault.path, second.pagePath), "utf8");
    expect(firstBody).toContain("finance source body");
    expect(secondBody).toContain("headcount source body");
  });

  it("does not overwrite a no-frontmatter raw source page when an ingest title slugifies onto it", async () => {
    const rootDir = await createTempDir("memory-wiki-raw-source-collision-");
    const input = path.join(rootDir, "incoming.txt");
    await fs.writeFile(input, "ingested finance body\n", "utf8");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    const rawSourcePath = path.join(config.vault.path, "sources", "q3-report.md");
    await fs.mkdir(path.dirname(rawSourcePath), { recursive: true });
    await fs.writeFile(rawSourcePath, "# Finance Notes\n\nHand authored raw source.\n", "utf8");

    const ingested = await ingestMemoryWikiSource({
      config,
      inputPath: input,
      title: "Q3 Report",
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(ingested.pagePath).not.toBe("sources/q3-report.md");
    const rawAfter = await fs.readFile(rawSourcePath, "utf8");
    expect(rawAfter).toContain("Hand authored raw source.");
    expect(rawAfter).not.toContain("ingested finance body");
    const ingestedBody = await fs.readFile(path.join(config.vault.path, ingested.pagePath), "utf8");
    expect(ingestedBody).toContain("ingested finance body");
  });
});
