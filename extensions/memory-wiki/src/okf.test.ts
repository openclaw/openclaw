import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWikiMarkdown, renderWikiMarkdown } from "./markdown.js";
import { importMemoryWikiOkfBundle } from "./okf.js";
import { searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

const OKF_LITERAL_LINK_EXAMPLES = [
  "    [customers](/tables/customers.md)",
  "> ```markdown\n> [customers](/tables/customers.md)\n> ```",
  "``\n[customers](/tables/customers.md)\n``",
  "- ```markdown\n  [customers](/tables/customers.md)\n  ```",
];

function getOnlyPagePath(paths: string[]): string {
  expect(paths).toHaveLength(1);
  const [pagePath] = paths;
  if (!pagePath) {
    throw new Error("Expected OKF import to produce one page path.");
  }
  return pagePath;
}

async function writeConcept(file: string, title: string, body: string, type = "BigQuery Table") {
  await fs.writeFile(file, renderWikiMarkdown({ frontmatter: { type, title }, body }), "utf8");
}

async function createImport(bundleName: string) {
  const rootDir = await createTempDir("memory-wiki-okf-");
  const bundlePath = path.join(rootDir, bundleName);
  await fs.mkdir(path.join(bundlePath, "tables"), { recursive: true });
  const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
  const run = (nowMs = Date.UTC(2026, 5, 12, 10, 0, 0)) =>
    importMemoryWikiOkfBundle({ config, bundlePath, nowMs });
  return { rootDir, bundlePath, config, run };
}

async function writeOkfBundle(rootDir: string) {
  const bundlePath = path.join(rootDir, "sales-okf");
  await fs.mkdir(path.join(bundlePath, "tables"), { recursive: true });
  await fs.mkdir(path.join(bundlePath, "metrics"), { recursive: true });
  await fs.writeFile(
    path.join(bundlePath, "index.md"),
    `---
id: sales-okf
okf_version: "0.1"
---

# Sales Bundle
`,
    "utf8",
  );
  await fs.writeFile(path.join(bundlePath, "log.md"), "# Directory Update Log\n", "utf8");
  await fs.writeFile(
    path.join(bundlePath, "tables", "customers.md"),
    `---
type: BigQuery Table
title: Customers
description: Customer table.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=customers
tags: [sales, customers]
timestamp: 2026-05-28T00:00:00Z
producer_field:
  owner: data
---

# Schema

Customer rows.
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(bundlePath, "tables", "orders.md"),
    `---
type: BigQuery Table
title: Orders
description: One row per completed order.
tags:
  - sales
  - orders
---

# Schema

Joined with [Customers](/tables/customers.md) and the [weekly metric](../metrics/weekly-active-users.md).
Titled link to [weekly metric](../metrics/weekly-active-users.md "metric docs").

Inline code keeps \`[customers](/tables/customers.md)\` unchanged.

\`\`\`markdown
[customers](/tables/customers.md)
\`\`\`

${OKF_LITERAL_LINK_EXAMPLES.join("\n\n")}

External citation stays as [BigQuery](https://cloud.google.com/bigquery).
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(bundlePath, "metrics", "weekly-active-users.md"),
    `---
type: Metric
title: Weekly Active Users
---

Computed from [orders](../tables/orders.md).
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(bundlePath, "tables", "draft.md"),
    `---
title: Draft
---

Missing type.
`,
    "utf8",
  );
  return bundlePath;
}

describe("importMemoryWikiOkfBundle", () => {
  it("imports OKF concept documents as searchable wiki concept pages", async () => {
    const rootDir = await createTempDir("memory-wiki-okf-");
    const bundlePath = await writeOkfBundle(rootDir);
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const result = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 0, 0),
    });

    expect(result).toMatchObject({ okfVersion: "0.1", importedCount: 3, skippedCount: 1 });
    expect(result.warnings[0]).toMatchObject({
      code: "missing-type",
      path: "tables/draft.md",
    });
    expect(result.pagePaths).toHaveLength(3);
    const repeat = await importMemoryWikiOkfBundle({
      config,
      bundlePath,
      nowMs: Date.UTC(2026, 5, 12, 10, 5, 0),
    });
    expect(repeat).toMatchObject({ importedCount: 3, updatedCount: 0 });

    const ordersPath = result.pagePaths.find((pagePath) => pagePath.includes("orders"));
    expect(ordersPath).toBeTruthy();
    const ordersRaw = await fs.readFile(path.join(config.vault.path, ordersPath!), "utf8");
    const orders = parseWikiMarkdown(ordersRaw);
    expect(orders.frontmatter).toMatchObject({
      pageType: "concept",
      title: "Orders",
      sourceType: "okf",
      provenanceMode: "okf-import",
      okfConceptId: "tables/orders",
      okfType: "BigQuery Table",
    });
    expect(orders.frontmatter.sourceIds).toEqual([
      expect.stringMatching(/^source\.okf\.sales-okf$/),
    ]);
    expect(orders.body).toMatch(/\]\(okf-sales-okf-tables-customers-/);
    expect(orders.body).toMatch(/\]\(okf-sales-okf-metrics-weekly-active-users-/);
    expect(orders.body).toContain('"metric docs"');
    expect(orders.body).toContain("`[customers](/tables/customers.md)`");
    expect(orders.body).toContain("```markdown\n[customers](/tables/customers.md)\n```");
    for (const example of OKF_LITERAL_LINK_EXAMPLES) {
      expect(orders.body).toContain(example);
    }
    expect(orders.body).toContain("https://cloud.google.com/bigquery");

    const okf = orders.frontmatter.okf as Record<string, unknown>;
    expect(okf).toMatchObject({
      version: "0.1",
      bundleName: "sales-okf",
      conceptId: "tables/orders",
      sourceRelativePath: "tables/orders.md",
    });
    expect(orders.frontmatter.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: expect.stringMatching(/^concepts\/okf-sales-okf-tables-customers-/),
          kind: "okf-link",
        }),
        expect.objectContaining({
          targetPath: expect.stringMatching(
            /^concepts\/okf-sales-okf-metrics-weekly-active-users-/,
          ),
          kind: "okf-link",
        }),
      ]),
    );

    const customersPath = result.pagePaths.find((pagePath) => pagePath.includes("customers"));
    const customersRaw = await fs.readFile(path.join(config.vault.path, customersPath!), "utf8");
    const customers = parseWikiMarkdown(customersRaw);
    const customersOkf = customers.frontmatter.okf as Record<string, unknown>;
    expect(customersOkf.frontmatter).toMatchObject({
      producer_field: { owner: "data" },
    });

    const searchResults = await searchMemoryWiki({
      config,
      query: "completed order",
      searchCorpus: "wiki",
    });
    expect(searchResults.map((searchResult) => searchResult.path)).toContain(ordersPath);
  });

  it("prunes repository metadata and dependency subtrees", async () => {
    const { bundlePath, run } = await createImport("pruned-okf");
    await Promise.all([
      fs.mkdir(path.join(bundlePath, "tables"), { recursive: true }),
      fs.mkdir(path.join(bundlePath, ".git"), { recursive: true }),
      fs.mkdir(path.join(bundlePath, "node_modules"), { recursive: true }),
    ]);
    const concept = `---\ntype: BigQuery Table\ntitle: Included\n---\n\nIncluded body.\n`;
    await Promise.all([
      fs.writeFile(path.join(bundlePath, "tables", "included.md"), concept),
      fs.writeFile(path.join(bundlePath, ".git", "ignored.md"), concept),
      fs.writeFile(path.join(bundlePath, "node_modules", "ignored.md"), concept),
    ]);

    const result = await run();

    expect(result.importedCount).toBe(1);
    expect(result.pagePaths).toHaveLength(1);
  });

  it("caps generated concept filenames for long OKF concept paths", async () => {
    const { bundlePath, config, run } = await createImport("long-okf");
    const deepSegments = Array.from({ length: 40 }, (_, index) => `segment-${index}`);
    const deepDir = path.join(bundlePath, ...deepSegments);
    await fs.mkdir(deepDir, { recursive: true });
    await writeConcept(path.join(deepDir, "orders.md"), "Long Orders", "Long concept body.\n");

    const result = await run();

    expect(result.importedCount).toBe(1);
    const [pagePath] = result.pagePaths;
    expect(pagePath).toBeDefined();
    if (!pagePath) {
      throw new Error("Expected OKF import to produce a page path.");
    }
    const fileName = path.basename(pagePath);
    expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
    await expect(fs.readFile(path.join(config.vault.path, pagePath), "utf8")).resolves.toContain(
      "Long concept body.",
    );
  });

  it("removes stale concept pages when an OKF bundle drops a concept", async () => {
    const { bundlePath, config, run } = await createImport("removing-okf");
    const customersPath = path.join(bundlePath, "tables", "customers.md");
    const ordersPath = path.join(bundlePath, "tables", "orders.md");
    await writeConcept(customersPath, "Customers", "Customer body.\n");
    await writeConcept(ordersPath, "Orders", "Order body.\n");
    const first = await run();
    const stalePagePath = first.pagePaths.find((pagePath) => pagePath.includes("orders"));
    expect(stalePagePath).toBeDefined();
    if (!stalePagePath) {
      throw new Error("Expected initial OKF import to include orders.");
    }

    await fs.rm(ordersPath);
    const second = await run();

    expect(second).toMatchObject({ importedCount: 1, removedCount: 1 });
    expect(second.removedPagePaths).toEqual([stalePagePath]);
    await expect(fs.stat(path.join(config.vault.path, stalePagePath))).rejects.toThrow();
    const results = await searchMemoryWiki({
      config,
      query: "Order body",
      searchCorpus: "wiki",
    });
    expect(results).toHaveLength(0);
  });

  it("detects body-only changes on timestamp-shaped markdown lines", async () => {
    const { bundlePath, config, run } = await createImport("body-timestamp-okf");
    const conceptPath = path.join(bundlePath, "tables", "events.md");
    await writeConcept(conceptPath, "Events", "updatedAt: 2026-06-12\n");
    const first = await run();
    const pagePath = getOnlyPagePath(first.pagePaths);
    await writeConcept(conceptPath, "Events", "updatedAt: 2026-06-13\n");

    const second = await run(Date.UTC(2026, 5, 13, 10, 0, 0));

    expect(second.updatedCount).toBe(1);
    await expect(fs.readFile(path.join(config.vault.path, pagePath), "utf8")).resolves.toContain(
      "updatedAt: 2026-06-13",
    );
  });

  it("rewrites percent-encoded OKF markdown links and preserves suffixes", async () => {
    const { bundlePath, config, run } = await createImport("encoded-okf");
    await writeConcept(
      path.join(bundlePath, "BigQuery Table.md"),
      "BigQuery Table",
      "Table body.\n",
    );
    await writeConcept(
      path.join(bundlePath, "links.md"),
      "Links",
      "See [table](BigQuery%20Table.md?view=compact#columns).\n",
      "Concept",
    );

    const result = await run();

    const linksPath = result.pagePaths.find((pagePath) => pagePath.includes("links"));
    expect(linksPath).toBeDefined();
    if (!linksPath) {
      throw new Error("Expected links page to be imported.");
    }
    await expect(fs.readFile(path.join(config.vault.path, linksPath), "utf8")).resolves.toMatch(
      /\[table\]\(okf-encoded-okf-[0-9a-f]{8}-bigquery-table-[^)]+\.md\?view=compact#columns\)/,
    );
  });

  it("refuses to write imported OKF concept pages through symlinks", async () => {
    const { rootDir, bundlePath, config, run } = await createImport("safe-okf");
    const conceptPath = path.join(bundlePath, "tables", "customers.md");
    await writeConcept(conceptPath, "Customers", "Original body.\n");
    const first = await run();
    const pagePath = getOnlyPagePath(first.pagePaths);
    const pageAbsolutePath = path.join(config.vault.path, pagePath);
    const externalTarget = path.join(rootDir, "outside.md");
    await fs.writeFile(externalTarget, "external target\n", "utf8");
    await fs.rm(pageAbsolutePath);
    await fs.symlink(externalTarget, pageAbsolutePath);
    await writeConcept(conceptPath, "Customers", "Updated body.\n");

    await expect(run(Date.UTC(2026, 5, 12, 11, 0, 0))).rejects.toThrow("through symlink");
    await expect(fs.readFile(externalTarget, "utf8")).resolves.toBe("external target\n");
  });

  it("refuses to import OKF concept files through hardlinks", async () => {
    const { rootDir, bundlePath, run } = await createImport("hardlink-okf");
    const externalSource = path.join(rootDir, "outside.md");
    await writeConcept(externalSource, "Private", "private body\n");
    await fs.link(externalSource, path.join(bundlePath, "tables", "private.md"));

    const result = await run();

    expect(result).toMatchObject({ importedCount: 0, skippedCount: 1 });
    expect(result.warnings[0]).toMatchObject({
      code: "unreadable-entry",
      path: "tables/private.md",
    });
  });
});
