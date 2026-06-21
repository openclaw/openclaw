// Memory Wiki tests cover source page shared plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMarkdownFence, renderWikiMarkdown } from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";

function buildSourcePage(raw: string, updatedAt: string): string {
  return renderWikiMarkdown({
    frontmatter: {
      pageType: "source",
      id: "source.imported",
      title: "imported",
      sourceType: "memory-unsafe-local",
      status: "active",
      updatedAt,
    },
    body: [
      "# imported",
      "",
      "## Content",
      renderMarkdownFence(raw, "text"),
      "",
      "## Notes",
      "<!-- openclaw:human:start -->",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n"),
  });
}

describe("writeImportedSourcePage", () => {
  let suiteRoot: string;

  beforeEach(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-page-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(suiteRoot, { recursive: true, force: true });
  });

  it("falls back when the source mtime is outside the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    const sourcePath = path.join(suiteRoot, "source.txt");
    await fs.writeFile(sourcePath, "source body", "utf8");
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      entries: {},
      version: 1,
    };

    const result = await writeImportedSourcePage({
      vaultRoot: suiteRoot,
      syncKey: "unsafe:source",
      sourcePath,
      sourceUpdatedAtMs: 8_700_000_000_000_000,
      sourceSize: 11,
      renderFingerprint: "fingerprint",
      pagePath: "pages/source.md",
      group: "unsafe-local",
      state,
      buildRendered: (raw, updatedAt) => `updatedAt: ${updatedAt}\n${raw}`,
    });

    await expect(fs.readFile(path.join(suiteRoot, "pages/source.md"), "utf8")).resolves.toBe(
      "updatedAt: 2026-05-01T12:00:00.000Z\nsource body",
    );
    expect(result).toEqual({ pagePath: "pages/source.md", changed: true, created: true });
    expect(state.entries["unsafe:source"]?.sourceUpdatedAtMs).toBe(8_700_000_000_000_000);
  });

  it("preserves the human Notes block when an imported source page is updated", async () => {
    const sourcePath = path.join(suiteRoot, "imported.txt");
    const pagePath = "sources/imported.md";
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      entries: {},
      version: 1,
    };

    await fs.writeFile(sourcePath, "first body", "utf8");
    await writeImportedSourcePage({
      vaultRoot: suiteRoot,
      syncKey: "bridge:imported",
      sourcePath,
      sourceUpdatedAtMs: Date.UTC(2026, 4, 1),
      sourceSize: 10,
      renderFingerprint: "fp-1",
      pagePath,
      group: "bridge",
      state,
      buildRendered: buildSourcePage,
    });

    const absPage = path.join(suiteRoot, pagePath);
    const userNote = "IMPORTED PAGE NOTE";
    const edited = (await fs.readFile(absPage, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(absPage, edited, "utf8");

    await fs.writeFile(sourcePath, "second body changed", "utf8");
    const result = await writeImportedSourcePage({
      vaultRoot: suiteRoot,
      syncKey: "bridge:imported",
      sourcePath,
      sourceUpdatedAtMs: Date.UTC(2026, 4, 2),
      sourceSize: 19,
      renderFingerprint: "fp-2",
      pagePath,
      group: "bridge",
      state,
      buildRendered: buildSourcePage,
    });

    const after = await fs.readFile(absPage, "utf8");
    expect(result.changed).toBe(true);
    expect(after).toContain("second body changed");
    expect(after).toContain(userNote);
  });
});
