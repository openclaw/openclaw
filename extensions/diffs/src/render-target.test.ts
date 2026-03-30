import { beforeEach, describe, expect, it, vi } from "vitest";

const { preloadFileDiffMock, preloadMultiFileDiffMock } = vi.hoisted(() => ({
  preloadFileDiffMock: vi.fn(async ({ fileDiff }: { fileDiff: unknown }) => ({
    prerenderedHTML: "<div>mock diff</div>",
    fileDiff,
  })),
  preloadMultiFileDiffMock: vi.fn(
    async ({ oldFile, newFile }: { oldFile: unknown; newFile: unknown }) => ({
      prerenderedHTML: "<div>mock diff</div>",
      oldFile,
      newFile,
    }),
  ),
}));

vi.mock("@pierre/diffs/ssr", () => ({
  preloadFileDiff: preloadFileDiffMock,
  preloadMultiFileDiff: preloadMultiFileDiffMock,
}));

import { DEFAULT_DIFFS_TOOL_DEFAULTS, resolveDiffImageRenderOptions } from "./config.js";
import { renderDiffDocument } from "./render.js";

function createRenderOptions() {
  return {
    presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
    image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
    expandUnchanged: false,
  };
}

describe("renderDiffDocument render targets", () => {
  beforeEach(() => {
    preloadFileDiffMock.mockClear();
    preloadMultiFileDiffMock.mockClear();
  });

  it("renders only the viewer variant for before/after viewer mode", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "one\n",
        after: "two\n",
      },
      createRenderOptions(),
      "viewer",
    );

    expect(rendered.html).toContain("mock diff");
    expect(rendered.imageHtml).toBeUndefined();
    expect(preloadMultiFileDiffMock).toHaveBeenCalledTimes(1);
  });

  it("renders both variants for before/after both mode", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "one\n",
        after: "two\n",
      },
      createRenderOptions(),
      "both",
    );

    expect(rendered.html).toContain("mock diff");
    expect(rendered.imageHtml).toContain("mock diff");
    expect(preloadMultiFileDiffMock).toHaveBeenCalledTimes(2);
  });

  it("renders only the image variant for patch image mode", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "patch",
        patch: [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
      },
      createRenderOptions(),
      "image",
    );

    expect(rendered.html).toBeUndefined();
    expect(rendered.imageHtml).toContain("mock diff");
    expect(preloadFileDiffMock).toHaveBeenCalledTimes(1);
  });
});
