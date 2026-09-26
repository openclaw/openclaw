// Diffs tests cover tool render output plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffScreenshotter } from "./browser.runtime.js";
import { resolveDiffsPluginDefaults } from "./config.js";
import { createDiffStoreHarness } from "./test-helpers.js";

const DEFAULT_DIFFS_TOOL_DEFAULTS = resolveDiffsPluginDefaults(undefined);

const { renderDiffDocumentMock } = vi.hoisted(() => ({
  renderDiffDocumentMock: vi.fn(),
}));

vi.mock("./render.js", () => ({
  renderDiffDocument: renderDiffDocumentMock,
}));

afterAll(() => {
  vi.doUnmock("./render.js");
  vi.resetModules();
});

describe("diffs tool rendered output guards", () => {
  let createDiffsTool: typeof import("./tool.js").createDiffsTool;
  let cleanupRootDir: () => Promise<void>;
  let store: Awaited<ReturnType<typeof createDiffStoreHarness>>["store"];

  beforeAll(async () => {
    ({ createDiffsTool } = await import("./tool.js"));
  });

  beforeEach(async () => {
    renderDiffDocumentMock.mockReset();
    ({ store, cleanup: cleanupRootDir } = await createDiffStoreHarness(
      "openclaw-diffs-tool-render-output-",
    ));
  });

  afterEach(async () => {
    await cleanupRootDir();
  });

  it("accepts empty string image html for file output", async () => {
    renderDiffDocumentMock.mockResolvedValue({
      title: "Text diff",
      fileCount: 1,
      inputKind: "before_after",
      imageHtml: "",
    });

    const screenshotHtml = vi.fn<DiffScreenshotter["screenshotHtml"]>(
      async ({ html, outputPath }) => {
        expect(html).toBe("");
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, Buffer.from("png"));
        return outputPath;
      },
    );

    const tool = createDiffsTool({
      getConfig: () => ({}),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter: { screenshotHtml },
    });

    const result = await tool.execute?.("tool-empty-image-html", {
      before: "one\n",
      after: "two\n",
      mode: "file",
    });

    expect(screenshotHtml).toHaveBeenCalledTimes(1);
    expect((result.details as Record<string, unknown>).filePath).toMatch(/preview\.png$/);
  });
});
