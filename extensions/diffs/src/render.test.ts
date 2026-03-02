import { describe, expect, it } from "vitest";
import { DEFAULT_DIFFS_TOOL_DEFAULTS } from "./config.js";
import { renderDiffDocument } from "./render.js";

describe("renderDiffDocument", () => {
  it("renders before/after input into a complete viewer document", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "const value = 1;\n",
        after: "const value = 2;\n",
        path: "src/example.ts",
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        expandUnchanged: false,
      },
    );

    expect(rendered.title).toBe("src/example.ts");
    expect(rendered.fileCount).toBe(1);
    expect(rendered.html).toContain("data-openclaw-diff-root");
    expect(rendered.html).toContain("src/example.ts");
    expect(rendered.html).toContain("/plugins/diffs/assets/viewer.js");
    expect(rendered.imageHtml).not.toContain("/plugins/diffs/assets/viewer.js");
    expect(rendered.imageHtml).toContain('data-openclaw-diffs-ready="true"');
    expect(rendered.imageHtml).toContain("max-width: 960px;");
    expect(rendered.imageHtml).toContain("--diffs-font-size: 16px;");
    expect(rendered.html).toContain('"diffIndicators":"bars"');
    expect(rendered.html).toContain('"disableLineNumbers":false');
    expect(rendered.html).toContain("--diffs-line-height: 24px;");
    expect(rendered.html).toContain("--diffs-font-size: 15px;");
    expect(rendered.html).not.toContain("fonts.googleapis.com");
  });

  it("renders multi-file patch input", async () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-const b = 1;",
      "+const b = 2;",
    ].join("\n");

    const rendered = await renderDiffDocument(
      {
        kind: "patch",
        patch,
        title: "Workspace patch",
      },
      {
        presentation: {
          ...DEFAULT_DIFFS_TOOL_DEFAULTS,
          layout: "split",
          theme: "dark",
        },
        expandUnchanged: true,
      },
    );

    expect(rendered.title).toBe("Workspace patch");
    expect(rendered.fileCount).toBe(2);
    expect(rendered.html).toContain("Workspace patch");
  });
});
