// Memory Wiki tests cover tool plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import memoryWikiPlugin from "../index.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { parseWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiApplyTool, createWikiLintTool, createWikiOpenItemsTool } from "./tool.js";

async function writeSynthesisPage(
  rootDir: string,
  relativePath: string,
  frontmatterLines: string[],
): Promise<void> {
  const absolutePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(
    absolutePath,
    ["---", "pageType: synthesis", ...frontmatterLines, "---", "", "Body."].join("\n"),
    "utf8",
  );
}

function asSchemaObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON schema object");
  }
  return value as Record<string, unknown>;
}

function unionLiteralValues(schema: Record<string, unknown>): string[] {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(variants)) {
    throw new Error("Expected union schema variants");
  }
  return variants
    .map((variant) => asSchemaObject(variant).const)
    .filter((value): value is string => typeof value === "string")
    .toSorted();
}

describe("memory-wiki tools", () => {
  const harness = createMemoryWikiTestHarness();

  it("accepts CLI-style operation aliases in wiki_apply schema", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    const applyProperties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const opSchema = asSchemaObject(applyProperties.op);

    expect(unionLiteralValues(opSchema)).toEqual([
      "create_synthesis",
      "metadata",
      "synthesis",
      "update_metadata",
    ]);
  });

  it("allows provenance metadata in wiki_apply claim evidence", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    const applyProperties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const claimsSchema = asSchemaObject(applyProperties.claims);
    const claimSchema = asSchemaObject(claimsSchema.items);
    const claimProperties = asSchemaObject(claimSchema.properties);
    const evidenceSchema = asSchemaObject(claimProperties.evidence);
    const evidenceArraySchema = asSchemaObject(evidenceSchema.items);
    const evidenceProperties = asSchemaObject(evidenceArraySchema.properties);

    expect(Object.keys(evidenceProperties).toSorted()).toEqual([
      "confidence",
      "kind",
      "lines",
      "note",
      "path",
      "privacyTier",
      "sourceId",
      "updatedAt",
      "weight",
    ]);
    expect(evidenceProperties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
  });

  it("rejects non-object wiki_apply arguments without throwing a TypeError", async () => {
    const { config } = await harness.createVault({ initialize: true });
    const tool = createWikiApplyTool(config);

    await expect(tool.execute("malformed-null", null)).rejects.toThrow(
      'wiki mutation op must be one of "create_synthesis", "update_metadata"',
    );
    await expect(tool.execute("malformed-undefined", undefined)).rejects.toThrow(
      'wiki mutation op must be one of "create_synthesis", "update_metadata"',
    );
  });

  async function createApplyFixture() {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const pagePath = path.join(rootDir, "entities", "alpha.md");
    const original = [
      "---",
      "pageType: entity",
      "id: entity.alpha",
      "title: Alpha",
      "status: active",
      "updatedAt: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "# Alpha",
      "",
      "Keep this human note.",
      "",
    ].join("\n");
    await fs.writeFile(pagePath, original, "utf8");
    return { tool: createWikiApplyTool(config), pagePath, original };
  }

  it.each(["synthesise", "update"])(
    "keeps wiki pages unchanged for unknown operation %s",
    async (op) => {
      const { tool, pagePath, original } = await createApplyFixture();
      const outcome = await tool
        .execute("unknown-operation", { op, lookup: "entity.alpha", status: "review" })
        .then(
          () => "accepted",
          () => "rejected",
        );

      expect(await fs.readFile(pagePath, "utf8")).toBe(original);
      expect(outcome).toBe("rejected");
    },
  );

  it.each(["update_metadata", "metadata"])(
    "applies supported metadata operation %s",
    async (op) => {
      const { tool, pagePath } = await createApplyFixture();
      const result = await tool.execute("valid-operation", {
        op,
        lookup: "entity.alpha",
        status: "review",
      });
      const page = parseWikiMarkdown(await fs.readFile(pagePath, "utf8"));

      expect(result.details).toMatchObject({ changed: true, operation: "update_metadata" });
      expect(page.frontmatter.status).toBe("review");
      expect(page.body).toContain("Keep this human note.");
    },
  );

  it.each([-0.5, 999])(
    "keeps wiki pages unchanged for out-of-range claim confidence %s",
    async (confidence) => {
      const { tool, pagePath, original } = await createApplyFixture();

      await expect(
        tool.execute("invalid-claim-confidence", {
          op: "update_metadata",
          lookup: "entity.alpha",
          claims: [{ text: "Alpha fact", confidence }],
        }),
      ).rejects.toThrow(
        `claims[0].confidence must be a number between 0 and 1; received ${confidence}.`,
      );
      await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(original);
    },
  );

  it("returns tool-safe relative report paths from wiki_lint", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "syntheses", "bad.md"),
      [
        "---",
        "id: synth-bad",
        "pageType: synthesis",
        "title: Bad Page",
        "---",
        "",
        "This links to [[Missing Page]].",
      ].join("\n"),
      "utf8",
    );

    const tool = createWikiLintTool(config);
    const result = await tool.execute("lint-call", {});
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = asSchemaObject(result.details);

    expect(text).toContain("Report: reports/lint.md");
    expect(text).not.toContain(rootDir);
    expect(details.reportPath).toBe("reports/lint.md");
    expect(details).not.toHaveProperty("vaultRoot");
    expect(JSON.stringify(details)).not.toContain(rootDir);
    expect(asSchemaObject(details.issuesByCategory).links).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "broken-wikilink" })]),
    );

    const lintResult = await lintMemoryWikiVault(config);
    expect(path.isAbsolute(lintResult.reportPath)).toBe(true);
    expect(lintResult.reportPath).toContain(rootDir);
  });

  it("exposes a provider-safe flat string enum for the wiki_open_items kinds filter", () => {
    const tool = createWikiOpenItemsTool({} as ResolvedMemoryWikiConfig);
    const properties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const kindsSchema = asSchemaObject(properties.kinds);
    const itemSchema = asSchemaObject(kindsSchema.items);

    // Must be a flat { type: "string", enum: [...] }, not an anyOf union that
    // some provider tool-schema validators reject.
    expect(itemSchema.type).toBe("string");
    expect(itemSchema).not.toHaveProperty("anyOf");
    expect(itemSchema).not.toHaveProperty("oneOf");
    expect((itemSchema.enum as string[]).toSorted()).toEqual([
      "claim-contradiction",
      "low-confidence-claim",
      "low-confidence-page",
      "open-question",
      "page-contradiction",
    ]);
  });

  it("enumerates open items and surfaces competing claim statements through the registered tool", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await writeSynthesisPage(rootDir, path.join("syntheses", "a.md"), [
      "id: synth-a",
      "title: Alpha",
      "confidence: 0.3",
      "questions:",
      "  - Is the March deadline still correct?",
      "claims:",
      "  - id: c1",
      "    text: deadline is March 15",
      "    status: supported",
    ]);
    await writeSynthesisPage(rootDir, path.join("syntheses", "b.md"), [
      "id: synth-b",
      "title: Beta",
      "claims:",
      "  - id: c1",
      "    text: deadline is April 1",
      "    status: supported",
    ]);

    const tool = createWikiOpenItemsTool(config);
    const result = await tool.execute("open-items-call", {});
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = asSchemaObject(result.details);
    const vaultCounts = asSchemaObject(details.vaultCounts);

    // The claim-contradiction item must carry the real competing statements.
    expect(text).toContain("deadline is March 15");
    expect(text).toContain("deadline is April 1");
    expect(text).not.toContain("[claim-contradiction] c1");
    expect(vaultCounts["open-question"]).toBe(1);
    expect(vaultCounts["low-confidence-page"]).toBe(1);
    expect(vaultCounts["claim-contradiction"]).toBe(1);
    expect(vaultCounts.total).toBe(3);
    expect(details.hasMore).toBe(false);
    expect(details).not.toHaveProperty("nextOffset");
    expect(JSON.stringify(details)).not.toContain(rootDir);
  });

  it("filters by kind and limit, and reports counts that match the returned items", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await writeSynthesisPage(rootDir, path.join("syntheses", "q.md"), [
      "id: synth-q",
      "title: Questions",
      "questions:",
      "  - First open question?",
      "  - Second open question?",
      "confidence: 0.2",
    ]);

    const tool = createWikiOpenItemsTool(config);

    const filtered = await tool.execute("open-items-filtered", { kinds: ["open-question"] });
    const filteredDetails = asSchemaObject(filtered.details);
    const filteredCounts = asSchemaObject(filteredDetails.counts);
    const filteredVaultCounts = asSchemaObject(filteredDetails.vaultCounts);
    expect(filteredCounts.total).toBe(2);
    expect(filteredCounts["open-question"]).toBe(2);
    expect(filteredCounts["low-confidence-page"]).toBe(0);
    // vaultCounts still reflects the whole vault (2 questions + 1 low-confidence page).
    expect(filteredVaultCounts.total).toBe(3);
    expect(filteredVaultCounts["low-confidence-page"]).toBe(1);

    const limited = await tool.execute("open-items-limited", { limit: 1 });
    const limitedCounts = asSchemaObject(asSchemaObject(limited.details).counts);
    expect(limitedCounts.total).toBe(1);
  });

  it("reports hasMore/nextOffset truthfully when `limit` clips a filtered match, not just budget clipping", async () => {
    const { config } = await harness.createVault({ initialize: true });
    await writeSynthesisPage(config.vault.path, path.join("syntheses", "two-questions.md"), [
      "id: synth-two-questions",
      "title: Two Questions",
      "questions:",
      "  - First short question?",
      "  - Second short question?",
    ]);

    const tool = createWikiOpenItemsTool(config);
    const result = await tool.execute("open-items-limit-clip", {
      kinds: ["open-question"],
      limit: 1,
    });
    const details = asSchemaObject(result.details);

    // Two matches exist; `limit: 1` returns only the first, so this must
    // report more remain rather than falsely claiming completeness.
    expect((details.items as unknown[]).length).toBe(1);
    expect(details.hasMore).toBe(true);
    expect(details.nextOffset).toBe(1);

    const nextPage = await tool.execute("open-items-limit-clip-page-2", {
      kinds: ["open-question"],
      limit: 1,
      offset: details.nextOffset as number,
    });
    const nextDetails = asSchemaObject(nextPage.details);
    expect((nextDetails.items as unknown[]).length).toBe(1);
    expect(nextDetails.hasMore).toBe(false);
    // The two pages together cover both questions, proving offset genuinely
    // reaches an item that a single call's limit made otherwise unreachable.
    const firstText = asSchemaObject((details.items as unknown[])[0] as Record<string, unknown>)
      .text as string;
    const secondText = asSchemaObject(
      (nextDetails.items as unknown[])[0] as Record<string, unknown>,
    ).text as string;
    expect(new Set([firstText, secondText])).toEqual(
      new Set(["First short question?", "Second short question?"]),
    );
  });

  it("caps output at a conservative default when limit is omitted", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    // Seed more open questions than the default cap so an omitted `limit`
    // cannot render (or retain in details.items) the entire vault.
    const questions = Array.from({ length: 25 }, (_, index) => `  - Open question ${index + 1}?`);
    await writeSynthesisPage(rootDir, path.join("syntheses", "many.md"), [
      "id: synth-many",
      "title: Many Questions",
      "questions:",
      ...questions,
    ]);

    const tool = createWikiOpenItemsTool(config);
    const result = await tool.execute("open-items-default-cap", {});
    const details = asSchemaObject(result.details);
    const counts = asSchemaObject(details.counts);
    const vaultCounts = asSchemaObject(details.vaultCounts);

    // Returned + rendered set is capped at the default (20); vaultCounts still
    // reports the true whole-vault total (25) so callers can detect truncation.
    expect((details.items as unknown[]).length).toBe(20);
    expect(counts.total).toBe(20);
    expect(vaultCounts.total).toBe(25);
    expect(details.hasMore).toBe(true);
    expect(details.nextOffset).toBe(20);
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("20. ");
    expect(text).not.toContain("21. ");
    expect(text).toContain("offset: 20");
  });

  it("caps oversized open-item fields in both rendered text and details", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const oversizedQuestion = "x".repeat(2_000);
    await writeSynthesisPage(rootDir, path.join("syntheses", "oversized.md"), [
      "id: synth-oversized",
      "title: Oversized",
      "questions:",
      `  - ${oversizedQuestion}`,
    ]);

    const tool = createWikiOpenItemsTool(config);
    const result = await tool.execute("open-items-oversized", {});
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = asSchemaObject(result.details);
    const [item] = details.items as Array<Record<string, unknown>>;

    expect(text).toContain(`${"x".repeat(499)}…`);
    expect(text).not.toContain("x".repeat(500));
    expect(item?.text).toBe(`${"x".repeat(499)}…`);
    expect(String(item?.text)).toHaveLength(500);
  });

  it("enforces one aggregate budget across rendered text and structured details", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const questions = Array.from({ length: 100 }, (_, index) => `  - ${"x".repeat(500)} ${index}`);
    await writeSynthesisPage(rootDir, path.join("syntheses", "large.md"), [
      "id: synth-large",
      "title: Large",
      "questions:",
      ...questions,
    ]);

    const tool = createWikiOpenItemsTool(config);
    const result = await tool.execute("open-items-aggregate-budget", { limit: 100 });
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = asSchemaObject(result.details);

    expect(details.hasMore).toBe(true);
    expect(typeof details.nextOffset).toBe("number");
    expect((details.items as unknown[]).length).toBeLessThan(100);
    // The pagination footer is intentionally excluded from the strict per-item
    // budget check (it's short and bounded); allow modest headroom for it here.
    expect(text.length + JSON.stringify(details).length).toBeLessThanOrEqual(7_200);
  });

  it("returns an identifiable locator, not a silent skip, when a single item exceeds the result budget", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    // Per-item text/pagePath/pageTitle are each capped at 500 chars, so no
    // single-field open-question or low-confidence item can alone exceed the
    // 7,000-char aggregate budget. A claim-contradiction item's `variants`
    // array (up to 10 entries, each with its own text/status/pagePath/title)
    // is not similarly capped in total size — 10 near-max-length competing
    // claims genuinely exceed the budget by itself, which is how this
    // actually happens in a real vault.
    const claimants = Array.from({ length: 10 }, (_, index) => index);
    for (const index of claimants) {
      await writeSynthesisPage(rootDir, path.join("syntheses", `claimant-${index}.md`), [
        `id: synth-claimant-${index}`,
        `title: ${"Claimant Page Title ".repeat(20)}${index}`,
        "claims:",
        "  - id: huge",
        `    text: ${"x".repeat(480)}${index}`,
        "    status: supported",
      ]);
    }
    // A separate, small item that sorts after the huge claim-contradiction
    // (claim-contradiction is derived before low-confidence-page) so it is
    // reachable only after the oversized one's locator is returned.
    await writeSynthesisPage(rootDir, path.join("syntheses", "normal.md"), [
      "id: synth-normal",
      "title: Normal",
      "confidence: 0.1",
    ]);

    const tool = createWikiOpenItemsTool(config);
    const result = await tool.execute("open-items-oversized-locator", {});
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = asSchemaObject(result.details);
    const items = details.items as Array<Record<string, unknown>>;

    // The oversized item is not silently skipped: a compact locator with its
    // real kind/claimId/page is returned so the caller can open the page
    // directly instead of losing the item entirely.
    expect(items.length).toBe(1);
    expect(items[0]?.kind).toBe("claim-contradiction");
    expect(items[0]?.claimId).toBe("huge");
    expect(items[0]?.variants).toBeUndefined();
    expect(items[0]?.text).toContain("too large to include");
    expect(text).not.toBe("No open wiki items.");
    expect(details.hasMore).toBe(true);
    expect(typeof details.nextOffset).toBe("number");

    // Advancing past the locator with the reported nextOffset reaches the
    // remaining normal item.
    const nextPage = await tool.execute("open-items-oversized-locator-next", {
      offset: details.nextOffset as number,
    });
    const nextDetails = asSchemaObject(nextPage.details);
    expect((nextDetails.items as unknown[]).length).toBe(1);
    expect(nextDetails.hasMore).toBe(false);
  });

  it("resolves wiki_open_items through real plugin registration — pagination, the oversized locator, and the lifecycle signal all live", async () => {
    // Every other test in this file calls createWikiOpenItemsTool directly,
    // and index.test.ts always mocks ./tool.js — so nothing exercised
    // plugin.register() -> the registered factory -> a started lifecycle
    // service -> the real tool against a real vault, end to end. That gap is
    // exactly why the dropped-signal regression this PR fixed went unnoticed:
    // resolveToolContext only produces a real (non-undefined) signal once the
    // plugin's registered service has actually been started.
    const { rootDir } = await harness.createVault({ initialize: true });
    await writeSynthesisPage(rootDir, path.join("syntheses", "questions.md"), [
      "id: synth-questions",
      "title: Questions",
      "questions:",
      "  - First registration question?",
      "  - Second registration question?",
    ]);
    // A claim-contradiction cluster large enough to alone exceed the result
    // budget (see the dedicated oversized-locator test above for why this
    // shape genuinely triggers it), to prove the locator through the same
    // real registration path, not just through a direct tool call.
    for (const index of Array.from({ length: 10 }, (_, i) => i)) {
      await writeSynthesisPage(rootDir, path.join("syntheses", `claimant-${index}.md`), [
        `id: synth-claimant-${index}`,
        `title: ${"Claimant Page Title ".repeat(20)}${index}`,
        "claims:",
        "  - id: huge",
        `    text: ${"x".repeat(480)}${index}`,
        "    status: supported",
      ]);
    }

    const { api, registerTool, registerService } = harness.createPluginApi();
    api.pluginConfig = { vault: { path: rootDir } };

    memoryWikiPlugin.register(api);

    // Starting the registered service is what creates the real
    // AbortController that resolveToolContext forwards as `signal`.
    expect(registerService).toHaveBeenCalledTimes(1);
    const service = registerService.mock.calls[0]?.[0] as { start: () => Promise<void> };
    await service.start();

    const registration = registerTool.mock.calls.find(
      ([, meta]) => meta?.name === "wiki_open_items",
    );
    type OpenItemsResult = {
      content: Array<{ type: string; text?: string }>;
      details: Record<string, unknown>;
    };
    const factory = registration?.[0] as (ctx: {
      agentId?: string;
      sessionKey?: string;
      sandboxed?: boolean;
    }) => { execute: (id: string, params: unknown) => Promise<OpenItemsResult> } | null;

    const tool = factory({ agentId: "main", sessionKey: "agent:main:test", sandboxed: false });
    expect(tool).not.toBeNull();

    // Pagination, through the real registration path: two questions exist,
    // `limit: 1` returns only the first and reports more remain, and
    // `offset: 1` reaches the second.
    const page1 = await tool!.execute("registration-page-1", {
      kinds: ["open-question"],
      limit: 1,
    });
    expect(page1.content.find((part) => part.type === "text")?.text).toContain(
      "First registration question?",
    );
    expect(page1.details.hasMore).toBe(true);
    expect(page1.details.nextOffset).toBe(1);

    const page2 = await tool!.execute("registration-page-2", {
      kinds: ["open-question"],
      limit: 1,
      offset: page1.details.nextOffset as number,
    });
    expect(page2.content.find((part) => part.type === "text")?.text).toContain(
      "Second registration question?",
    );
    expect(page2.details.hasMore).toBe(false);

    // The oversized-item locator, through the same real registration path:
    // filtering to just the huge cluster isolates it as the first (and only)
    // matched item, so the locator fallback is exercised for real here too,
    // not only via a direct createWikiOpenItemsTool call.
    const clusterResult = await tool!.execute("registration-oversized", {
      kinds: ["claim-contradiction"],
    });
    const clusterItems = clusterResult.details.items as Array<Record<string, unknown>>;
    expect(clusterItems.length).toBe(1);
    expect(clusterItems[0]?.kind).toBe("claim-contradiction");
    expect(clusterItems[0]?.claimId).toBe("huge");
    expect(clusterItems[0]?.variants).toBeUndefined();
  });

  it("excludes foreign and unowned bridge-page items for sandboxed callers", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const writeBridgeQuestion = async (slug: string, agentIds: string[], question: string) => {
      await fs.writeFile(
        path.join(rootDir, "sources", `${slug}.md`),
        [
          "---",
          "pageType: source",
          `id: source.${slug}`,
          `title: ${slug}`,
          "sourceType: memory-bridge",
          "bridgeAgentIds:",
          ...agentIds.map((agentId) => `  - ${agentId}`),
          "questions:",
          `  - ${question}`,
          "---",
          "",
          "Body.",
        ].join("\n"),
        "utf8",
      );
    };
    await writeBridgeQuestion("owned", ["main"], "owned open question");
    await writeBridgeQuestion("foreign", ["secondary"], "foreign open question");
    await writeBridgeQuestion("unowned", [], "unowned open question");

    const tool = createWikiOpenItemsTool(config, undefined, {
      agentId: "main",
      sandboxed: true,
    });
    const result = await tool.execute("open-items-sandboxed", { kinds: ["open-question"] });
    const text = result.content.find((part) => part.type === "text")?.text ?? "";

    expect(text).toContain("owned open question");
    expect(text).not.toContain("foreign open question");
    expect(text).not.toContain("unowned open question");
  });

  it("declares a bounded limit with a schema maximum", () => {
    const tool = createWikiOpenItemsTool({} as ResolvedMemoryWikiConfig);
    const properties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const limit = asSchemaObject(properties.limit);
    expect(limit.minimum).toBe(1);
    expect(limit.maximum).toBe(100);
  });

  it("declares a non-negative offset for pagination continuation", () => {
    const tool = createWikiOpenItemsTool({} as ResolvedMemoryWikiConfig);
    const properties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const offset = asSchemaObject(properties.offset);
    expect(offset.minimum).toBe(0);
  });
});
