import { disposeHighlighter } from "@pierre/diffs";
import { afterEach, expect, it } from "vitest";
import { resolveDiffImageRenderOptions, resolveDiffsPluginDefaults } from "./config.js";
import { renderDiffDocument } from "./render.js";
import type { DiffFileDefaults, DiffRenderOptions } from "./types.js";
import { parseViewerPayloadJson } from "./viewer-payload.js";

const DEFAULT_DIFFS_TOOL_DEFAULTS = resolveDiffsPluginDefaults(undefined);
function makeOptions(
  presentation: Partial<DiffRenderOptions["presentation"]> = {},
  file: Partial<DiffFileDefaults> = {},
  expandUnchanged = false,
): DiffRenderOptions {
  return {
    presentation: { ...DEFAULT_DIFFS_TOOL_DEFAULTS, ...presentation },
    image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS, ...file }),
    expandUnchanged,
  };
}
const renderOptions = makeOptions();

function patchFile(name: string, lines = "-const x = 1;\n+const x = 2;", hunk = "@@ -1 +1 @@") {
  return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${hunk}\n${lines}`;
}

afterEach(disposeHighlighter);

it("renders before/after input into a complete viewer document", async () => {
  const rendered = await renderDiffDocument(
    {
      kind: "before_after",
      before: "const value = 1;\n",
      after: "const value = 2;\n",
      path: "src/example.ts",
    },
    renderOptions,
  );

  expect(rendered).toMatchObject({
    title: "src/example.ts",
    fileCount: 1,
  });
  expect(rendered.html).toContain("data-openclaw-diff-root");
  expect(rendered.html).toContain("src/example.ts");
  expect(rendered.html).toContain("../../assets/viewer.js");
  expect(rendered.html).toContain("min-height: 100vh;");
  expect(rendered.html).toContain('"diffIndicators":"bars"');
  expect(rendered.html).toContain('"disableLineNumbers":false');
  expect(rendered.html).toContain("--diffs-line-height: 24px;");
  expect(rendered.html).toContain("--diffs-font-size: 15px;");
  expect(rendered.html).toContain("@media (prefers-reduced-motion: reduce)");
  expect(rendered.html).toContain("scroll-behavior: auto;");
  expect(rendered.imageHtml).toContain("../../assets/viewer.js");
  expect(rendered.imageHtml).toContain("max-width: 960px;");
  expect(rendered.imageHtml).toContain("--diffs-font-size: 16px;");
  expect(rendered.html).not.toContain("fonts.googleapis.com");
  expect(rendered.html).not.toContain('<nav class="oc-diff-card oc-diff-nav"');
});

it("uses the language-pack viewer runtime for uncommon languages when available", async () => {
  const rendered = await renderDiffDocument(
    { kind: "before_after", before: "REPORT z_demo.\n", after: "REPORT z_demo2.\n", lang: "abap" },
    { ...renderOptions, languagePackAvailable: true },
    "viewer",
  );

  const html = rendered.html ?? "";
  const payload = parseViewerPayloadJson(
    html.match(/data-openclaw-diff-payload>(.*?)<\/script>/)?.[1] ?? "",
  );

  expect(html).toContain("../../../diffs-language-pack/assets/viewer.js");
  expect(payload.langs).toEqual(["abap"]);
});

it("renders multi-file patch input with a changed-files summary nav", async () => {
  const patch = [
    patchFile(
      "a.ts",
      "-const a = 1;\n+const a = 2;\n+const extra = true;\n const keep = 0;",
      "@@ -1,2 +1,3 @@",
    ),
    patchFile("b.ts", "-const b = 1;\n+const b = 2;"),
  ].join("\n");

  const rendered = await renderDiffDocument(
    { kind: "patch", patch, title: "Workspace patch" },
    makeOptions(
      { layout: "split", theme: "dark" },
      { fileQuality: "hq", fileMaxWidth: 1180 },
      true,
    ),
  );

  expect(rendered).toMatchObject({ title: "Workspace patch", fileCount: 2 });
  expect(rendered.html).toContain("Workspace patch");
  expect(rendered.imageHtml).toContain("max-width: 1180px;");

  const html = rendered.html ?? "";
  expect(html).toContain('<nav class="oc-diff-card oc-diff-nav" aria-label="Changed files">');
  expect(html).toContain("2 changed files");
  expect(html).toContain(
    '<span class="oc-diff-nav-additions">+3</span><span class="oc-diff-nav-deletions">-2</span>',
  );
  expect(html).toContain(
    '<span class="oc-diff-nav-additions">+2</span><span class="oc-diff-nav-deletions">-1</span>',
  );
  expect(html).toContain('href="#oc-diff-file-1"');
  expect(html).toContain('id="oc-diff-file-1"');
  expect(html).toContain('href="#oc-diff-file-2"');
  expect(html).toContain('id="oc-diff-file-2"');
  expect(rendered.imageHtml).toContain('<nav class="oc-diff-card oc-diff-nav"');
});

it("labels added, deleted, and renamed files in the summary nav and escapes names", async () => {
  const patch = [
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1 @@",
    "+const created = true;",
    "diff --git a/old.ts b/old.ts",
    "deleted file mode 100644",
    "--- a/old.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-const removed = true;",
    "diff --git a/before.ts b/after.ts",
    "similarity index 90%",
    "rename from before.ts",
    "rename to after.ts",
    "--- a/before.ts",
    "+++ b/after.ts",
    "@@ -1 +1 @@",
    "-const v = 1;",
    "+const v = 2;",
    patchFile("a&b.ts", "-x\n+y"),
  ].join("\n");

  const rendered = await renderDiffDocument({ kind: "patch", patch }, renderOptions, "viewer");

  const html = rendered.html ?? "";
  expect(html).toContain("4 changed files");
  expect(html).toContain('<span class="oc-diff-nav-badge" data-change="added">added</span>');
  expect(html).toContain('<span class="oc-diff-nav-badge" data-change="deleted">deleted</span>');
  expect(html).toContain('<span class="oc-diff-nav-badge" data-change="renamed">renamed</span>');
  expect(html).toContain("before.ts &rarr; after.ts");
  expect(html).toContain("a&amp;b.ts");
});

it("omits the summary nav for single-file patches", async () => {
  const rendered = await renderDiffDocument(
    { kind: "patch", patch: patchFile("solo.ts", "-const solo = 1;\n+const solo = 2;") },
    renderOptions,
    "viewer",
  );

  expect(rendered.fileCount).toBe(1);
  expect(rendered.html).not.toContain('<nav class="oc-diff-card oc-diff-nav"');
});

it("rejects patches that exceed file-count limits", async () => {
  const patch = Array.from({ length: 129 }, (_, i) => patchFile(`f${i}.ts`)).join("\n");

  await expect(renderDiffDocument({ kind: "patch", patch }, renderOptions)).rejects.toThrow(
    "too many files",
  );
});
