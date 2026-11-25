import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { loadMemoryWikiCompiledDashboards } from "./compiled-cache.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

it("groups wiki pages by kind and surfaces claims, questions, and contradictions", async () => {
  const { rootDir, config } = await createVault({
    config: { render: { createBacklinks: false, createDashboards: false } },
    initialize: true,
  });

  async function writePage(
    relativePath: string,
    frontmatter: Parameters<typeof renderWikiMarkdown>[0]["frontmatter"],
    body = "Fixture page.",
  ) {
    const file = path.join(rootDir, relativePath);
    const rendered = renderWikiMarkdown({ frontmatter, body });
    await fs.writeFile(file, rendered, "utf8");
  }
  await writePage(
    "syntheses/travel-system.md",
    {
      pageType: "synthesis",
      id: "synthesis.travel.system",
      title: "Travel system",
      updatedAt: "2026-04-10T12:00:00.000Z",
      claims: [{ text: "Direct receipts." }, { text: "Recurring friction." }],
      questions: ["Standardize receipts?"],
      contradictions: ["Old guidance is stale."],
    },
    "# Travel system\n\nTravel summary.\n",
  );
  await writePage("sources/raw-chat.md", {
    pageType: "source",
    id: "source.raw.chat",
    title: "Raw chat source",
    sourceType: "chatgpt",
    updatedAt: "2026-04-08T08:00:00.000Z",
  });
  await writePage("entities/mariano.md", {
    pageType: "entity",
    id: "entity.mariano",
    title: "Mariano",
    updatedAt: "2026-04-09T08:00:00.000Z",
    claims: [{ text: "He prefers compact, inspectable systems." }],
  });

  await compileMemoryWikiVault(config);
  await Promise.all([
    fs.unlink(path.join(rootDir, "syntheses", "travel-system.md")),
    fs.unlink(path.join(rootDir, "sources", "raw-chat.md")),
    fs.unlink(path.join(rootDir, "entities", "mariano.md")),
  ]);

  const { overview: result } = await loadMemoryWikiCompiledDashboards(config);
  expect(result).toMatchObject({
    totalItems: 2,
    totalPages: 3,
    totalClaims: 3,
    totalQuestions: 1,
    totalContradictions: 1,
    clusters: [
      {
        key: "synthesis",
        label: "Syntheses",
        itemCount: 1,
        claimCount: 2,
        questionCount: 1,
        contradictionCount: 1,
        items: [
          {
            title: "Travel system",
            snippet: "Travel summary.",
            claims: ["Direct receipts.", "Recurring friction."],
            questions: ["Standardize receipts?"],
            contradictions: ["Old guidance is stale."],
          },
        ],
      },
      { key: "entity", label: "Entities", itemCount: 1, claimCount: 1 },
    ],
  });
  expect(result.pageCounts).toEqual({
    synthesis: 1,
    entity: 1,
    concept: 0,
    source: 1,
    report: 0,
  });
});
