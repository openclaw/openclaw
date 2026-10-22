import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { loadMemoryWikiCompiledDashboards } from "./compiled-cache.js";
import { projectMemoryWikiImportInsight } from "./import-insights.js";
import { renderWikiMarkdown, scanWikiPageSummary } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

function createInsightVault() {
  return createVault({
    config: { render: { createBacklinks: false, createDashboards: false } },
    initialize: true,
  });
}

describe("projectMemoryWikiImportInsight", () => {
  it.each([
    {
      name: "deduplicates before the four-signal cap without folding case",
      preferences: ["same", "same", "Same", "third", "fourth", "fifth"],
      corrections: ["You're right, use docs."],
      expected: ["same", "Same", "third", "fourth"],
      expectedCorrections: ["You're right, use docs."],
    },
    {
      name: "deduplicates prefixed corrections against preferences in input order",
      preferences: ["Correction detected: You're right, use docs.", "first"],
      corrections: ["You're right, use docs.", "Bad assumption, reset."],
      expected: [
        "Correction detected: You're right, use docs.",
        "first",
        "Correction detected: Bad assumption, reset.",
      ],
      expectedCorrections: ["You're right, use docs.", "Bad assumption, reset."],
    },
    {
      name: "does not backfill duplicate corrections beyond the upstream two-correction cap",
      preferences: [],
      corrections: ["You're right.", "You're right.", "Bad assumption."],
      expected: ["Correction detected: You're right."],
      expectedCorrections: ["You're right.", "You're right."],
    },
    {
      name: "keeps empty input empty",
      preferences: [],
      corrections: [],
      expected: [],
      expectedCorrections: [],
    },
    {
      name: "keeps withheld content out of all signal lists",
      preferences: ["private preference"],
      corrections: ["You're right, private correction."],
      withheld: true,
      expected: [],
      expectedCorrections: [],
    },
  ])("$name", ({ preferences, corrections, withheld, expected, expectedCorrections }) => {
    const scan = scanWikiPageSummary({
      absolutePath: "/vault/sources/signals.md",
      relativePath: "sources/signals.md",
      raw: renderWikiMarkdown({
        frontmatter: { pageType: "source", sourceType: "chatgpt-export", title: "Signals" },
        body: [
          "## Auto Digest",
          ...(withheld ? ["- Auto digest withheld from durable-candidate generation."] : []),
          "- Preference signals:",
          ...preferences.map((value) => `  - ${value}`),
          "## Active Branch Transcript",
          ...corrections.flatMap((value) => ["### Assistant", value]),
        ].join("\n"),
      }),
    });
    if (scan.status !== "valid") {
      throw new Error(`Expected valid source page, got ${scan.status}`);
    }
    expect(projectMemoryWikiImportInsight(scan.page, scan.parsed)).toMatchObject({
      candidateSignals: expected,
      correctionSignals: expectedCorrections,
      preferenceSignals: withheld ? [] : preferences,
      digestStatus: withheld ? "withheld" : "available",
    });
  });
});

describe("compiled import insights", () => {
  it("clusters import digests with privacy filtering and Unicode-safe summaries", async () => {
    const { rootDir, config, page } = await createInsightVault();
    const assistantOpener = `${"a".repeat(178)}😀${"b".repeat(20)}`;
    await page(
      "sources/chatgpt-travel.md",
      {
        pageType: "source",
        id: "source.chatgpt.travel",
        title: "ChatGPT Export: BA flight receipts process",
        sourceType: "chatgpt-export",
        riskLevel: "low",
        riskReasons: [],
        labels: ["domain/personal", "area/travel", "topic/travel"],
        createdAt: "2026-01-11T14:07:58.552Z",
        updatedAt: "2026-01-11T14:08:45.377Z",
      },
      `# ChatGPT Export: BA flight receipts process\n\n## Auto Digest\n- User messages: 2\n- Assistant messages: 2\n- First user line: how do i get receipts?\n- Last user line: that option does not exist\n- Preference signals:\n  - prefers direct airline receipts\n\n## Active Branch Transcript\n### User\n\nhow do i get receipts?\n\n### Assistant\n\n${assistantOpener}\n`,
    );
    await page(
      "sources/chatgpt-health.md",
      {
        pageType: "source",
        id: "source.chatgpt.health",
        title: "ChatGPT Export: Migraine Medication Advice",
        sourceType: "chatgpt-export",
        riskLevel: "high",
        riskReasons: ["health"],
        labels: ["domain/personal", "area/health", "topic/health"],
        updatedAt: "2026-01-31T20:18:00.000Z",
      },
      "# ChatGPT Export: Migraine Medication Advice\n\n## Auto Digest\n- Auto digest withheld from durable-candidate generation until reviewed.\n- Risk reasons: health content\n- First user line: i have a migraine, pink or yellow?\n- Last user line: should i take this now?\n- Preference signals:\n  - prefers color-coded medication guidance\n\n## Active Branch Transcript\n### User\n\ni have a migraine, pink or yellow?\n\n### Assistant\n\nYou're right, let's reset and stick to safe dosing guidance.\n",
    );

    await compileMemoryWikiVault(config);
    await Promise.all([
      fs.unlink(path.join(rootDir, "sources", "chatgpt-travel.md")),
      fs.unlink(path.join(rootDir, "sources", "chatgpt-health.md")),
    ]);

    const { importInsights: result } = await loadMemoryWikiCompiledDashboards(config);

    expect(result).toMatchObject({
      sourceType: "chatgpt",
      totalItems: 2,
      totalClusters: 2,
    });
    const healthCluster = result.clusters[0];
    expect(healthCluster).toMatchObject({
      key: "topic/health",
      label: "Health",
      itemCount: 1,
      highRiskCount: 1,
      withheldCount: 1,
    });

    const travelCluster = result.clusters[1];
    expect(travelCluster).toMatchObject({
      key: "topic/travel",
      label: "Travel",
      itemCount: 1,
      preferenceSignalCount: 1,
    });

    const travelItem = travelCluster?.items[0];
    expect(travelItem).toMatchObject({
      title: "BA flight receipts process",
      riskReasons: [],
      activeBranchMessages: 0,
      userMessageCount: 2,
      assistantMessageCount: 2,
      firstUserLine: "how do i get receipts?",
      lastUserLine: "that option does not exist",
      assistantOpener,
      summary: `${"a".repeat(178)}…`,
      candidateSignals: ["prefers direct airline receipts"],
      correctionSignals: [],
      preferenceSignals: ["prefers direct airline receipts"],
      digestStatus: "available",
    });

    const healthItem = result.clusters
      .flatMap((cluster) => cluster.items)
      .find((item) => item.title === "Migraine Medication Advice");
    expect(healthItem?.summary).toBe(
      "Sensitive health chat withheld from durable-memory extraction because it touches health.",
    );
    expect(healthItem).toMatchObject({
      candidateSignals: [],
      correctionSignals: [],
      preferenceSignals: [],
      userMessageCount: 1,
      assistantMessageCount: 1,
    });
    expect(healthItem?.firstUserLine).toBeUndefined();
    expect(healthItem?.lastUserLine).toBeUndefined();
    expect(healthItem?.assistantOpener).toBeUndefined();
  });
});
