import fsSync from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryWikiCompiledDigestClaim,
  MemoryWikiCompiledDigestPage,
} from "./compiled-cache.js";
import { resolveMemoryWikiAgentConfig, type ResolvedMemoryWikiConfig } from "./config.js";
import {
  createWikiPromptSectionBuilder,
  createWikiPromptSectionPreparer,
} from "./prompt-section.js";
import {
  createCompiledDigestPage,
  createCompiledSnapshot,
  createMemoryWikiTestHarness,
  publishCompiledSnapshot,
} from "./test-helpers.js";
import { initializeMemoryWikiVault } from "./vault.js";

const { createVault } = createMemoryWikiTestHarness();
afterEach(() => vi.restoreAllMocks());

function digestPage(
  title: string,
  claims: Array<Partial<MemoryWikiCompiledDigestClaim> & { text: string }> = [],
  overrides: Partial<MemoryWikiCompiledDigestPage> = {},
) {
  return createCompiledDigestPage({
    title,
    claimCount: Math.max(1, claims.length),
    topClaims: claims.map((claim) =>
      Object.assign({ status: "supported", freshnessLevel: "unknown" }, claim),
    ),
    ...overrides,
  });
}

async function seedCompiledDigest(
  config: ResolvedMemoryWikiConfig,
  pages: MemoryWikiCompiledDigestPage[],
  claimCount = 1,
  contradictionCount = 0,
) {
  await initializeMemoryWikiVault(config);
  await publishCompiledSnapshot(
    config,
    createCompiledSnapshot({
      claimCount,
      contradictionCount,
      pages: pages.map((page, index) => ({ ...page, path: `entities/page-${index}.md` })),
    }),
  );
}

function createStaticPreparer(config: ResolvedMemoryWikiConfig) {
  return createWikiPromptSectionPreparer({ config, resolveConfig: () => config });
}

describe("Memory Wiki prompt section", () => {
  const buildGuidance = createWikiPromptSectionBuilder();

  it("prefers shared memory corpus guidance when memory tools are available", () => {
    const prompt = buildGuidance({
      availableTools: new Set(["memory_search", "memory_get", "wiki_search", "wiki_get"]),
    }).join("\n");
    for (const text of [
      "`memory_search` with `corpus=all`",
      "`memory_get` with `corpus=wiki` or `corpus=all`",
      "wiki-specific ranking or provenance details",
    ]) {
      expect(prompt).toContain(text);
    }
  });

  it.each([
    {
      name: "oversized structured claims without splitting UTF-16 surrogate pairs",
      pages: [digestPage("Alpha", [{ text: `${"c".repeat(699)}🤖${"c".repeat(20_000)}` }])],
      retained: "c".repeat(699),
      omitted: "🤖",
    },
    {
      name: "oversized page titles without splitting UTF-16 surrogate pairs",
      pages: [
        digestPage(`${"t".repeat(159)}🤖${"t".repeat(20_000)}`, [
          { text: "The claim remains visible after its page title." },
        ]),
      ],
      retained: "The claim remains visible after its page title.",
      omitted: "🤖",
    },
    {
      name: "the complete digest across multiple independently bounded claims",
      pages: Array.from({ length: 4 }, (_, pageIndex) =>
        digestPage(
          `Page ${pageIndex}`,
          Array.from({ length: 2 }, (_claim, claimIndex) => ({
            text: `claim ${pageIndex}-${claimIndex} ${"x".repeat(680)}`,
          })),
        ),
      ),
      retained: "claim 0-0",
      omitted: "claim 3-1",
    },
  ])("hard-bounds $name before model-context injection", async ({ pages, retained, omitted }) => {
    const { config } = await createVault({
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await seedCompiledDigest(config, pages, pages.length * 2);

    const lines = await createStaticPreparer(config)({ availableTools: new Set() });
    const prompt = lines.join("\n");

    expect(prompt).toContain("## Compiled Wiki Snapshot");
    expect(prompt).toContain(retained);
    expect(prompt).not.toContain(omitted);
    expect(prompt.length).toBeLessThanOrEqual(2_800);
    expect(prompt).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it("keeps the digest disabled by default", async () => {
    const { config } = await createVault();
    await seedCompiledDigest(config, [digestPage("Alpha")]);

    await expect(createStaticPreparer(config)({ availableTools: new Set() })).resolves.toEqual([]);
  });

  it("stabilizes digest ordering for prompt-cache-friendly output", async () => {
    const { config } = await createVault({
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    const pages = [
      digestPage(
        "Zulu",
        [{ text: "Zulu fallback note.", confidence: 0.3, freshnessLevel: "stale" }],
        { kind: "concept", claimCount: 2 },
      ),
      digestPage(
        "Alpha",
        [
          { text: "Alpha was renamed in 2026.", confidence: 0.42, freshnessLevel: "aging" },
          {
            text: "Alpha uses PostgreSQL for production writes.",
            confidence: 0.91,
            freshnessLevel: "fresh",
          },
        ],
        {
          claimCount: 4,
          questions: ["Still active?"],
          contradictions: ["Conflicts with source.beta"],
        },
      ),
    ] as const;
    await seedCompiledDigest(config, [...pages], 6, 1);
    const firstLines = await createStaticPreparer(config)({ availableTools: new Set() });
    const [firstPage, secondPage] = pages;
    await seedCompiledDigest(
      config,
      [{ ...secondPage, topClaims: secondPage.topClaims?.toReversed() }, firstPage],
      6,
      1,
    );
    const secondLines = await createStaticPreparer(config)({ availableTools: new Set() });

    expect(firstLines).toEqual(secondLines);
    expect(firstLines.join("\n")).toContain(
      "Alpha uses PostgreSQL for production writes. (status supported, confidence 0.91, freshness fresh)",
    );
  });

  it("does no filesystem work during synchronous prompt guidance", () => {
    const readFileSync = vi.spyOn(fsSync, "readFileSync");

    expect(buildGuidance({ availableTools: new Set(["web_search"]) })).toEqual([]);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("prepares only the invoking agent's compiled digest", async () => {
    const appConfig = {
      agents: { entries: { support: {}, marketing: {} } },
    };
    const { config } = await createVault({
      config: {
        vault: { scope: "agent" },
        context: { includeCompiledDigestPrompt: true },
      },
    });
    for (const [agentId, marker] of [
      ["support", "SUPPORT_SENTINEL"],
      ["marketing", "MARKETING_SENTINEL"],
    ] as const) {
      const agentConfig = resolveMemoryWikiAgentConfig({ config, appConfig, agentId });
      await seedCompiledDigest(agentConfig, [digestPage(agentId, [{ text: marker }])]);
    }
    const prepare = createWikiPromptSectionPreparer({
      config,
      resolveConfig: (agentId) => resolveMemoryWikiAgentConfig({ config, appConfig, agentId }),
    });

    const support = await prepare({ availableTools: new Set(), agentId: "support" });
    const marketing = await prepare({ availableTools: new Set(), agentId: "marketing" });

    expect(support.join("\n")).toContain("SUPPORT_SENTINEL");
    expect(support.join("\n")).not.toContain("MARKETING_SENTINEL");
    expect(marketing.join("\n")).toContain("MARKETING_SENTINEL");
    expect(marketing.join("\n")).not.toContain("SUPPORT_SENTINEL");
    await expect(prepare({ availableTools: new Set() })).resolves.toEqual([]);
  });
});
