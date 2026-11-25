import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { scanWikiPageSummary } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

vi.mock("./markdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./markdown.js")>();
  return { ...actual, scanWikiPageSummary: vi.fn(actual.scanWikiPageSummary) };
});

const { createVault } = createMemoryWikiTestHarness();

it("reuses unchanged scans across compiles while observing edits, renames, and deletions", async () => {
  const { rootDir, config, page, read } = await createVault({
    initialize: true,
    config: { render: { createBacklinks: false, createDashboards: false } },
  });
  await page("concepts/alpha.md", { pageType: "concept", id: "alpha", title: "Alpha" });
  await page("concepts/beta.md", { pageType: "concept", id: "beta", title: "Beta" });
  const compile = () => compileMemoryWikiVault(config);
  const scans = vi.mocked(scanWikiPageSummary);
  scans.mockClear();
  await compile();
  const firstCount = scans.mock.calls.length;
  scans.mockClear();
  await compile();
  const secondCount = scans.mock.calls.length;
  console.info({ firstCount, secondCount });
  expect(firstCount).toBeGreaterThan(0);
  expect(secondCount).toBe(0);

  const alphaPath = path.join(rootDir, "concepts/alpha.md");
  const before = await fs.stat(alphaPath);
  await fs.writeFile(alphaPath, (await read("concepts/alpha.md")).replaceAll("Alpha", "Gamma"));
  await fs.utimes(alphaPath, before.atime, before.mtime);
  await fs.rename(path.join(rootDir, "concepts/beta.md"), path.join(rootDir, "concepts/moved.md"));
  scans.mockClear();
  const edited = await compile();
  expect(edited.pages.filter((entry) => entry.kind === "concept")).toMatchObject([
    { title: "Beta", relativePath: "concepts/moved.md" },
    { title: "Gamma", relativePath: "concepts/alpha.md" },
  ]);
  expect(scans.mock.calls.map(([entry]) => entry.relativePath).toSorted()).toEqual([
    "concepts/alpha.md",
    "concepts/moved.md",
  ]);
  await fs.unlink(alphaPath);
  const deleted = await compile();
  expect(deleted.pages.some((entry) => entry.id === "alpha")).toBe(false);
  await expect(read("index.md")).resolves.not.toContain("Gamma");
});

it("reparses compiler rewrites and keeps another vault's scans separate", async () => {
  const first = await createVault({ initialize: true });
  await first.page("sources/source.md", { pageType: "source", id: "source.one", title: "Source" });
  await first.page("concepts/same.md", {
    pageType: "concept",
    id: "one",
    title: "First",
    sourceIds: ["source.one"],
  });
  const second = await createVault({ initialize: true });
  await second.page("concepts/same.md", { pageType: "concept", id: "two", title: "Other" });
  vi.mocked(scanWikiPageSummary).mockClear();
  const result = await compileMemoryWikiVault(first.config);
  const rewritten = vi
    .mocked(scanWikiPageSummary)
    .mock.calls.filter(([entry]) => entry.relativePath === "concepts/same.md")
    .map(([entry]) => entry.raw.includes("## Related"));
  expect(rewritten).toEqual([false, true]);
  await compileMemoryWikiVault(second.config);
  const concept = result.pages.find((entry) => entry.id === "one");
  await expect(first.read("concepts/same.md")).resolves.toContain("## Related");
  if (concept) {
    concept.title = "Caller changed the returned page";
  }
  vi.mocked(scanWikiPageSummary).mockClear();
  const repeated = await compileMemoryWikiVault({ ...first.config });
  expect(repeated.pages.find((entry) => entry.id === "one")?.title).toBe("First");
  expect(vi.mocked(scanWikiPageSummary).mock.calls).toHaveLength(0);
});
