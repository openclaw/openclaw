import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { loadMemoryWikiCompiledDashboards } from "./compiled-cache.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("compiled wiki overview", () => {
  it("groups wiki pages by kind and surfaces claims, questions, and contradictions", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-overview-",
      config: { render: { createBacklinks: false, createDashboards: false } },
      initialize: true,
    });

    async function writePage(
      relativePath: string,
      frontmatter: Parameters<typeof renderWikiMarkdown>[0]["frontmatter"],
      body = "Fixture page.",
    ) {
      const file = path.join(rootDir, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        renderWikiMarkdown({
          frontmatter,
          body,
        }),
        "utf8",
      );
    }
    await writePage(
      "syntheses/travel-system.md",
      {
        pageType: "synthesis",
        id: "synthesis.travel.system",
        title: "Travel system",
        updatedAt: "2026-04-10T12:00:00.000Z",
        claims: [
          { text: "Mariano prefers direct receipts from airlines when possible." },
          { text: "Travel admin friction keeps showing up across chats." },
        ],
        questions: ["Should flight receipts be standardized into one process?"],
        contradictions: ["Old BA receipts guidance may now be stale."],
      },
      "# Travel system\n\nThis synthesis rolls up recurring travel admin patterns from imported chats.\n",
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
    });
    expect(result.pageCounts).toEqual({
      synthesis: 1,
      entity: 1,
      concept: 0,
      source: 1,
      report: 0,
    });
    const synthesisCluster = result.clusters[0];
    expect(synthesisCluster).toMatchObject({
      key: "synthesis",
      label: "Syntheses",
      itemCount: 1,
      claimCount: 2,
      questionCount: 1,
      contradictionCount: 1,
    });

    const synthesisItem = synthesisCluster?.items[0];
    expect(synthesisItem).toMatchObject({
      title: "Travel system",
      snippet: "This synthesis rolls up recurring travel admin patterns from imported chats.",
    });
    expect(synthesisItem?.claims).toEqual([
      "Mariano prefers direct receipts from airlines when possible.",
      "Travel admin friction keeps showing up across chats.",
    ]);
    expect(synthesisItem?.questions).toEqual([
      "Should flight receipts be standardized into one process?",
    ]);
    expect(synthesisItem?.contradictions).toEqual(["Old BA receipts guidance may now be stale."]);
    expect(result.clusters[1]).toMatchObject({
      key: "entity",
      label: "Entities",
      itemCount: 1,
      claimCount: 1,
    });
  });
});
