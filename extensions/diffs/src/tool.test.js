import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test-utils/plugin-api.js";
import { DEFAULT_DIFFS_TOOL_DEFAULTS } from "./config.js";
import { createDiffStoreHarness } from "./test-helpers.js";
import { createDiffsTool } from "./tool.js";
describe("diffs tool", () => {
  let store;
  let cleanupRootDir;
  beforeEach(async () => {
    ({ store, cleanup: cleanupRootDir } = await createDiffStoreHarness("openclaw-diffs-tool-"));
  });
  afterEach(async () => {
    await cleanupRootDir();
  });
  it("returns a viewer URL in view mode", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS
    });
    const result = await tool.execute?.("tool-1", {
      before: "one\n",
      after: "two\n",
      path: "README.md",
      mode: "view"
    });
    const text = readTextContent(result, 0);
    expect(text).toContain("http://127.0.0.1:18789/plugins/diffs/view/");
    expect((result?.details).viewerUrl).toBeDefined();
  });
  it("does not expose reserved format in the tool schema", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS
    });
    const parameters = tool.parameters;
    expect(parameters.properties).toBeDefined();
    expect(parameters.properties).not.toHaveProperty("format");
  });
  it("returns an image artifact in image mode", async () => {
    const cleanupSpy = vi.spyOn(store, "scheduleCleanup");
    const screenshotter = createPngScreenshotter({
      assertHtml: (html) => {
        expect(html).toContain("/plugins/diffs/assets/viewer.js");
      },
      assertImage: (image) => {
        expect(image).toMatchObject({
          format: "png",
          qualityPreset: "standard",
          scale: 2,
          maxWidth: 960
        });
      }
    });
    const tool = createToolWithScreenshotter(store, screenshotter);
    const result = await tool.execute?.("tool-2", {
      before: "one\n",
      after: "two\n",
      mode: "image"
    });
    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect(readTextContent(result, 0)).toContain("Diff PNG generated at:");
    expect(readTextContent(result, 0)).toContain("Use the `message` tool");
    expect(result?.content).toHaveLength(1);
    expect((result?.details).filePath).toBeDefined();
    expect((result?.details).imagePath).toBeDefined();
    expect((result?.details).format).toBe("png");
    expect((result?.details).fileQuality).toBe("standard");
    expect((result?.details).imageQuality).toBe("standard");
    expect((result?.details).fileScale).toBe(2);
    expect((result?.details).imageScale).toBe(2);
    expect((result?.details).fileMaxWidth).toBe(960);
    expect((result?.details).imageMaxWidth).toBe(960);
    expect((result?.details).viewerUrl).toBeUndefined();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
  it("renders PDF output when fileFormat is pdf", async () => {
    const screenshotter = createPdfScreenshotter({
      assertOutputPath: (outputPath) => {
        expect(outputPath).toMatch(/preview\.pdf$/);
      }
    });
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter
    });
    const result = await tool.execute?.("tool-2b", {
      before: "one\n",
      after: "two\n",
      mode: "image",
      fileFormat: "pdf"
    });
    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect(readTextContent(result, 0)).toContain("Diff PDF generated at:");
    expect((result?.details).format).toBe("pdf");
    expect((result?.details).filePath).toMatch(/preview\.pdf$/);
  });
  it("accepts mode=file as an alias for file artifact rendering", async () => {
    const screenshotter = createPngScreenshotter({
      assertOutputPath: (outputPath) => {
        expect(outputPath).toMatch(/preview\.png$/);
      }
    });
    const tool = createToolWithScreenshotter(store, screenshotter);
    const result = await tool.execute?.("tool-2c", {
      before: "one\n",
      after: "two\n",
      mode: "file"
    });
    expectArtifactOnlyFileResult(screenshotter, result);
  });
  it("honors ttlSeconds for artifact-only file output", async () => {
    vi.useFakeTimers();
    const now = /* @__PURE__ */ new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);
    try {
      const screenshotter = createPngScreenshotter();
      const tool = createToolWithScreenshotter(store, screenshotter);
      const result = await tool.execute?.("tool-2c-ttl", {
        before: "one\n",
        after: "two\n",
        mode: "file",
        ttlSeconds: 1
      });
      const filePath = (result?.details).filePath;
      await expect(fs.stat(filePath)).resolves.toBeDefined();
      vi.setSystemTime(new Date(now.getTime() + 2e3));
      await store.cleanupExpired();
      await expect(fs.stat(filePath)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("accepts image* tool options for backward compatibility", async () => {
    const screenshotter = createPngScreenshotter({
      assertImage: (image) => {
        expect(image).toMatchObject({
          qualityPreset: "hq",
          scale: 2.4,
          maxWidth: 1100
        });
      }
    });
    const tool = createToolWithScreenshotter(store, screenshotter);
    const result = await tool.execute?.("tool-2legacy", {
      before: "one\n",
      after: "two\n",
      mode: "file",
      imageQuality: "hq",
      imageScale: 2.4,
      imageMaxWidth: 1100
    });
    expect((result?.details).fileQuality).toBe("hq");
    expect((result?.details).fileScale).toBe(2.4);
    expect((result?.details).fileMaxWidth).toBe(1100);
  });
  it("accepts deprecated format alias for fileFormat", async () => {
    const screenshotter = createPdfScreenshotter();
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter
    });
    const result = await tool.execute?.("tool-2format", {
      before: "one\n",
      after: "two\n",
      mode: "file",
      format: "pdf"
    });
    expect((result?.details).fileFormat).toBe("pdf");
    expect((result?.details).filePath).toMatch(/preview\.pdf$/);
  });
  it("honors defaults.mode=file when mode is omitted", async () => {
    const screenshotter = createPngScreenshotter();
    const tool = createToolWithScreenshotter(store, screenshotter, {
      ...DEFAULT_DIFFS_TOOL_DEFAULTS,
      mode: "file"
    });
    const result = await tool.execute?.("tool-2d", {
      before: "one\n",
      after: "two\n"
    });
    expectArtifactOnlyFileResult(screenshotter, result);
  });
  it("falls back to view output when both mode cannot render an image", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter: {
        screenshotHtml: vi.fn(async () => {
          throw new Error("browser missing");
        })
      }
    });
    const result = await tool.execute?.("tool-3", {
      before: "one\n",
      after: "two\n",
      mode: "both"
    });
    expect(result?.content).toHaveLength(1);
    expect(readTextContent(result, 0)).toContain("File rendering failed");
    expect((result?.details).fileError).toBe("browser missing");
    expect((result?.details).imageError).toBe("browser missing");
  });
  it("rejects invalid base URLs as tool input errors", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS
    });
    await expect(
      tool.execute?.("tool-4", {
        before: "one\n",
        after: "two\n",
        mode: "view",
        baseUrl: "javascript:alert(1)"
      })
    ).rejects.toThrow("Invalid baseUrl");
  });
  it("rejects oversized patch payloads", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS
    });
    await expect(
      tool.execute?.("tool-oversize-patch", {
        patch: "x".repeat(21e5),
        mode: "view"
      })
    ).rejects.toThrow("patch exceeds maximum size");
  });
  it("rejects oversized before/after payloads", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS
    });
    const large = "x".repeat(6e5);
    await expect(
      tool.execute?.("tool-oversize-before", {
        before: large,
        after: "ok",
        mode: "view"
      })
    ).rejects.toThrow("before exceeds maximum size");
  });
  it("uses configured defaults when tool params omit them", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: {
        ...DEFAULT_DIFFS_TOOL_DEFAULTS,
        mode: "view",
        theme: "light",
        layout: "split",
        wordWrap: false,
        background: false,
        fontFamily: "JetBrains Mono",
        fontSize: 17
      }
    });
    const result = await tool.execute?.("tool-5", {
      before: "one\n",
      after: "two\n",
      path: "README.md"
    });
    expect(readTextContent(result, 0)).toContain("Diff viewer ready.");
    expect((result?.details).mode).toBe("view");
    const viewerPath = String((result?.details).viewerPath);
    const [id] = viewerPath.split("/").filter(Boolean).slice(-2);
    const html = await store.readHtml(id);
    expect(html).toContain('body data-theme="light"');
    expect(html).toContain("--diffs-font-size: 17px;");
    expect(html).toContain("JetBrains Mono");
  });
  it("prefers explicit tool params over configured defaults", async () => {
    const screenshotter = createPngScreenshotter({
      assertHtml: (html2) => {
        expect(html2).toContain("/plugins/diffs/assets/viewer.js");
      },
      assertImage: (image) => {
        expect(image).toMatchObject({
          format: "png",
          qualityPreset: "print",
          scale: 2.75,
          maxWidth: 1320
        });
      }
    });
    const tool = createToolWithScreenshotter(store, screenshotter, {
      ...DEFAULT_DIFFS_TOOL_DEFAULTS,
      mode: "view",
      theme: "light",
      layout: "split",
      fileQuality: "hq",
      fileScale: 2.2,
      fileMaxWidth: 1180
    });
    const result = await tool.execute?.("tool-6", {
      before: "one\n",
      after: "two\n",
      mode: "both",
      theme: "dark",
      layout: "unified",
      fileQuality: "print",
      fileScale: 2.75,
      fileMaxWidth: 1320
    });
    expect((result?.details).mode).toBe("both");
    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect((result?.details).format).toBe("png");
    expect((result?.details).fileQuality).toBe("print");
    expect((result?.details).fileScale).toBe(2.75);
    expect((result?.details).fileMaxWidth).toBe(1320);
    const viewerPath = String((result?.details).viewerPath);
    const [id] = viewerPath.split("/").filter(Boolean).slice(-2);
    const html = await store.readHtml(id);
    expect(html).toContain('body data-theme="dark"');
  });
});
function createApi() {
  return createTestPluginApi({
    id: "diffs",
    name: "Diffs",
    description: "Diffs",
    source: "test",
    config: {
      gateway: {
        port: 18789,
        bind: "loopback"
      }
    },
    runtime: {}
  });
}
function createToolWithScreenshotter(store, screenshotter, defaults = DEFAULT_DIFFS_TOOL_DEFAULTS) {
  return createDiffsTool({
    api: createApi(),
    store,
    defaults,
    screenshotter
  });
}
function expectArtifactOnlyFileResult(screenshotter, result) {
  expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
  expect((result?.details).mode).toBe("file");
  expect((result?.details).viewerUrl).toBeUndefined();
}
function createPngScreenshotter(params = {}) {
  const screenshotHtml = vi.fn(
    async ({
      html,
      outputPath,
      image
    }) => {
      params.assertHtml?.(html);
      params.assertImage?.(image);
      params.assertOutputPath?.(outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from("png"));
      return outputPath;
    }
  );
  return {
    screenshotHtml
  };
}
function createPdfScreenshotter(params = {}) {
  const screenshotHtml = vi.fn(
    async ({ outputPath, image }) => {
      expect(image.format).toBe("pdf");
      params.assertOutputPath?.(outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from("%PDF-1.7"));
      return outputPath;
    }
  );
  return { screenshotHtml };
}
function readTextContent(result, index) {
  const content = result?.content;
  const entry = content?.[index];
  return entry?.type === "text" ? entry.text ?? "" : "";
}
