import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parseWikiMarkdown, renderWikiMarkdown } from "./markdown.js";
import { importMemoryWikiOkfBundle } from "./okf.js";
import { searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

const OKF_LITERAL_LINK_EXAMPLES = [
  "`[customers](/tables/customers.md)`",
  "```markdown\n[customers](/tables/customers.md)\n```",
  "    [customers](/tables/customers.md)",
  "> ```markdown\n> [customers](/tables/customers.md)\n> ```",
  "``\n[customers](/tables/customers.md)\n``",
  "- ```markdown\n  [customers](/tables/customers.md)\n  ```",
];

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
  const page = (paths: string[], name?: string) => {
    if (!name) {
      expect(paths).toHaveLength(1);
    }
    return path.join(
      config.vault.path,
      expectDefined(
        name ? paths.find((entry) => entry.includes(name)) : paths[0],
        "imported OKF page",
      ),
    );
  };
  const read = (file: string) => fs.readFile(file, "utf8");
  const write = (file: string, body: string, title = "Customers") =>
    writeConcept(path.join(bundlePath, file), title, body);
  return { rootDir, bundlePath, config, run, page, read, write };
}

async function writeOkfBundle(bundlePath: string) {
  await fs.mkdir(path.join(bundlePath, "metrics"), { recursive: true });
  const write = (relativePath: string, frontmatter: Record<string, unknown>, body: string) =>
    fs.writeFile(path.join(bundlePath, relativePath), renderWikiMarkdown({ frontmatter, body }));
  await write("index.md", { id: "sales-okf", okf_version: "0.1" }, "# Sales Bundle\n");
  await fs.writeFile(path.join(bundlePath, "log.md"), "# Directory Update Log\n", "utf8");
  await write(
    "tables/customers.md",
    {
      type: "BigQuery Table",
      title: "Customers",
      description: "Customer table.",
      resource: "https://console.cloud.google.com/bigquery?p=acme&d=sales&t=customers",
      tags: ["sales", "customers"],
      timestamp: "2026-05-28T00:00:00Z",
      producer_field: { owner: "data" },
    },
    "# Schema\n\nCustomer rows.\n",
  );
  await write(
    "tables/orders.md",
    {
      type: "BigQuery Table",
      title: "Orders",
      description: "One row per completed order.",
      tags: ["sales", "orders"],
    },
    [
      "# Schema",
      "Joined with [Customers](/tables/customers.md) and the [weekly metric](../metrics/weekly%20active%20users.md?view=compact#columns).",
      'Titled link to [weekly metric](../metrics/weekly%20active%20users.md "metric docs").',
      ...OKF_LITERAL_LINK_EXAMPLES,
      "External citation stays as [BigQuery](https://cloud.google.com/bigquery).",
    ].join("\n\n"),
  );
  await write(
    "metrics/weekly active users.md",
    { type: "Metric", title: "Weekly Active Users" },
    "Computed from [orders](../tables/orders.md).\n",
  );
  await write("tables/draft.md", { title: "Draft" }, "Missing type.\n");
}

describe("importMemoryWikiOkfBundle", () => {
  it("imports OKF concept documents as searchable wiki concept pages", async () => {
    const { bundlePath, config, run, page, read } = await createImport("sales-okf");
    await writeOkfBundle(bundlePath);
    const result = await run();

    expect(result).toMatchObject({ okfVersion: "0.1", importedCount: 3, skippedCount: 1 });
    expect(result.warnings[0]).toMatchObject({ code: "missing-type", path: "tables/draft.md" });
    expect(result.pagePaths).toHaveLength(3);
    const repeat = await run(Date.UTC(2026, 5, 12, 10, 5));
    expect(repeat).toMatchObject({ importedCount: 3, updatedCount: 0 });

    const ordersPath = page(result.pagePaths, "orders");
    const orders = parseWikiMarkdown(await read(ordersPath));
    expect(orders.frontmatter).toMatchObject({
      pageType: "concept",
      sourceType: "okf",
      provenanceMode: "okf-import",
    });
    expect(orders.frontmatter.sourceIds).toEqual([
      expect.stringMatching(/^source\.okf\.sales-okf$/),
    ]);
    for (const target of ["tables-customers", "metrics-weekly-active-users"]) {
      expect(orders.body).toMatch(new RegExp(`\\]\\(okf-sales-okf-${target}-`));
      expect(orders.frontmatter.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetPath: expect.stringMatching(new RegExp(`^concepts/okf-sales-okf-${target}-`)),
            kind: "okf-link",
          }),
        ]),
      );
    }
    expect(orders.body).toContain('"metric docs"');
    expect(orders.body).toMatch(
      /\[weekly metric\]\(okf-sales-okf-metrics-weekly-active-users-[^)]+\.md\?view=compact#columns\)/,
    );
    for (const example of OKF_LITERAL_LINK_EXAMPLES) {
      expect(orders.body).toContain(example);
    }
    expect(orders.body).toContain("https://cloud.google.com/bigquery");

    const customers = parseWikiMarkdown(await read(page(result.pagePaths, "customers")));
    expect(customers.frontmatter).toMatchObject({
      okf: { frontmatter: { producer_field: { owner: "data" } } },
    });

    const searchResults = await searchMemoryWiki({
      config,
      query: "completed order",
      searchCorpus: "wiki",
    });
    expect(searchResults.map((searchResult) => searchResult.path)).toContain(
      path.relative(config.vault.path, ordersPath).split(path.sep).join("/"),
    );
  });

  it("prunes repository metadata and dependency subtrees", async () => {
    const { bundlePath, run } = await createImport("pruned-okf");
    for (const directory of ["tables", ".git", "node_modules"]) {
      await fs.mkdir(path.join(bundlePath, directory), { recursive: true });
      await writeConcept(path.join(bundlePath, directory, "included.md"), "Included", "Body.");
    }

    const result = await run();

    expect(result.importedCount).toBe(1);
    expect(result.pagePaths).toHaveLength(1);
  });

  it("caps generated concept filenames for long OKF concept paths", async () => {
    const { bundlePath, run, page, read } = await createImport("long-okf");
    const deepSegments = Array.from({ length: 40 }, (_, index) => `segment-${index}`);
    const deepDir = path.join(bundlePath, ...deepSegments);
    await fs.mkdir(deepDir, { recursive: true });
    await writeConcept(path.join(deepDir, "orders.md"), "Long Orders", "Long concept body.\n");

    const result = await run();

    expect(result.importedCount).toBe(1);
    const pagePath = page(result.pagePaths);
    const fileName = path.basename(pagePath);
    expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
    await expect(read(pagePath)).resolves.toContain("Long concept body.");
  });

  it("detects body-only changes on timestamp-shaped markdown lines", async () => {
    const { run, page, read, write } = await createImport("body-timestamp-okf");
    await write("tables/events.md", "updatedAt: 2026-06-12\n", "Events");
    const first = await run();
    await write("tables/events.md", "updatedAt: 2026-06-13\n", "Events");

    const second = await run(Date.UTC(2026, 5, 13, 10, 0, 0));

    expect(second.updatedCount).toBe(1);
    await expect(read(page(first.pagePaths))).resolves.toContain("updatedAt: 2026-06-13");
  });

  it("refuses to write imported OKF concept pages through symlinks", async () => {
    const { rootDir, run, page, read, write } = await createImport("safe-okf");
    await write("tables/customers.md", "Original body.\n");
    const first = await run();
    const pageAbsolutePath = page(first.pagePaths);
    const externalTarget = path.join(rootDir, "outside.md");
    await fs.writeFile(externalTarget, "external target\n", "utf8");
    await fs.rm(pageAbsolutePath);
    await fs.symlink(externalTarget, pageAbsolutePath);
    await write("tables/customers.md", "Updated body.\n");

    await expect(run(Date.UTC(2026, 5, 12, 11, 0, 0))).rejects.toThrow("through symlink");
    await expect(read(externalTarget)).resolves.toBe("external target\n");
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

  it.each([
    ["closed fence", ""],
    ["open fence", ""],
    ["legacy body", "Customer body."],
    ["legacy Notes", "## Notes\nProducer-owned note."],
  ])("preserves human Notes and replaces producer content: %s", async (name, legacy) => {
    const { run, page, read, write } = await createImport("notes-okf");
    const marked = legacy === "";
    const producer = (version: number) =>
      `Customer body ${version}.\n~~~markdown\n<!-- openclaw:human:start -->\nExample ${version}.\n<!-- openclaw:human:end -->\n~~~` +
      (name === "open fence" ? "\n```sql\nSELECT 1" : "");
    await write("customers.md", marked ? producer(1) : legacy);
    const first = await run();
    const pagePath = page(first.pagePaths);
    const raw = await read(pagePath);
    const emptyBlock = "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->";
    const humanBlock = [
      "<!-- openclaw:human:start -->",
      "  Keep café 🦞 and $& exactly.  ",
      "~~~markdown",
      emptyBlock,
      "~~~",
      "Keep this trailing handwritten note.",
      "<!-- openclaw:human:end -->",
    ].join("\r\n");
    if (marked) {
      // Legacy pages may lack a slot; append the note so regressions fail on data loss.
      await fs.writeFile(
        pagePath,
        raw.includes(emptyBlock)
          ? raw.replace(emptyBlock, () => humanBlock)
          : `${raw}\n## Notes\n${humanBlock}\n`,
      );
      await run(Date.UTC(2026, 5, 12, 11));
      await expect(read(pagePath)).resolves.toContain(humanBlock);
    } else {
      const { frontmatter } = parseWikiMarkdown(raw);
      await fs.writeFile(pagePath, renderWikiMarkdown({ frontmatter, body: legacy }));
    }
    const updated = marked ? producer(2) : "Updated producer body.";
    await write("customers.md", updated);
    const changed = await run(Date.UTC(2026, 5, 12, 12));
    expect(changed.pagePaths).toEqual(first.pagePaths);
    const refreshed = await read(pagePath);
    expect(refreshed).toContain(updated);
    expect(refreshed).toContain(marked ? humanBlock : `## Notes\n${emptyBlock}`);
    for (const old of marked ? ["Customer body 1.", "Example 1."] : [legacy]) {
      expect(refreshed).not.toContain(old);
    }
  });

  it("preserves imported concepts when malformed UTF-8 is mixed with valid input", async () => {
    const { bundlePath, run, page, read } = await createImport("encoding-okf");
    const conceptPath = path.join(bundlePath, "tables", "customers.md");
    await writeConcept(conceptPath, "Customers", "Original body.\n");
    await writeConcept(path.join(bundlePath, "valid.md"), "Valid", "Café 😀 literal \uFFFD\n");
    const first = await run();
    const pagePath = page(first.pagePaths, "customers");
    const original = await fs.readFile(pagePath);
    const malformed = Buffer.concat([
      Buffer.from("---\ntype: Concept\ntitle: Customers\n---\nBroken "),
      Buffer.from([0xc3, 0x28]),
    ]);
    await fs.writeFile(conceptPath, malformed);

    const result = await run();

    expect(result).toMatchObject({
      importedCount: 1,
      updatedCount: 0,
      removedCount: 0,
      skippedCount: 1,
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "unreadable-entry",
        path: "tables/customers.md",
        message: expect.stringContaining("UTF-8"),
      }),
    ]);
    await expect(fs.readFile(pagePath)).resolves.toEqual(original);
    await expect(fs.readFile(conceptPath)).resolves.toEqual(malformed);
    await expect(read(page(result.pagePaths))).resolves.toContain("Café 😀 literal \uFFFD");
  });

  it("rejects an unreadable root index without changing existing concept identities", async () => {
    const { bundlePath, config, run, page, read } = await createImport("invalid-index-okf");
    const indexPath = path.join(bundlePath, "index.md");
    const index = "---\nid: stable\n---\nBundle description.\n";
    await fs.writeFile(indexPath, index);
    const conceptPath = path.join(bundlePath, "tables", "customers.md");
    await writeConcept(conceptPath, "Customers", "Original body.\n");
    const first = await run();
    const pagesBefore = await fs.readdir(path.join(config.vault.path, "concepts"));
    const pagePath = page(first.pagePaths);
    const original = await fs.readFile(pagePath);
    await fs.writeFile(indexPath, Buffer.concat([Buffer.from(index), Buffer.from([0xff])]));
    await writeConcept(conceptPath, "Customers", "Updated body.\n");

    await expect(run()).rejects.toThrow(/index\.md.*UTF-8/);
    await expect(fs.readFile(pagePath)).resolves.toEqual(original);
    await expect(fs.readdir(path.join(config.vault.path, "concepts"))).resolves.toEqual(
      pagesBefore,
    );

    await fs.writeFile(indexPath, index);
    const recovered = await run();
    expect(recovered).toMatchObject({ importedCount: 1, updatedCount: 1, warnings: [] });
    expect(recovered.pagePaths).toEqual(first.pagePaths);
    await expect(read(pagePath)).resolves.toContain("Updated body.");
  });
});
