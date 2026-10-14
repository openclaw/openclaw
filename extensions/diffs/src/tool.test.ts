// Diffs tests cover tool plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaywrightDiffScreenshotter } from "./browser.runtime.js";
import { resolveDiffsPluginDefaults } from "./config.js";
import { registerDiffsPlugin } from "./plugin.js";
import { DiffArtifactStore } from "./store.js";
import { createDiffStoreHarness, expireDiffArtifactForTest } from "./test-helpers.js";
import type { DiffRenderOptions } from "./types.js";

let createDiffsTool: typeof import("./tool.js").createDiffsTool;
type DiffScreenshotter = Pick<PlaywrightDiffScreenshotter, "screenshotHtml">;

const { resolvePreferredOpenClawTmpDir, browserRuntime } = vi.hoisted(() => ({
  resolvePreferredOpenClawTmpDir: vi.fn(),
  browserRuntime: { screenshotter: undefined as DiffScreenshotter | undefined },
}));

vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir,
}));

afterAll(() => {
  vi.doUnmock("./browser.runtime.js");
  vi.resetModules();
});

const DEFAULT_DIFFS_TOOL_DEFAULTS = resolveDiffsPluginDefaults(undefined);

describe("diffs tool", () => {
  let rootDir: string;
  let store: DiffArtifactStore;
  let cleanupRootDir: () => Promise<void>;
  let blobStore: Awaited<ReturnType<typeof createDiffStoreHarness>>["blobStore"];

  beforeEach(async () => {
    vi.resetModules();
    browserRuntime.screenshotter = undefined;
    vi.doMock("./browser.runtime.js", async (importOriginal) => {
      if (!browserRuntime.screenshotter) {
        throw new Error("viewer-only rendering must not load the Playwright renderer");
      }
      return {
        ...(await importOriginal<typeof import("./browser.runtime.js")>()),
        PlaywrightDiffScreenshotter: vi.fn(function () {
          return browserRuntime.screenshotter;
        }),
      };
    });
    ({ createDiffsTool } = await import("./tool.js"));
    resolvePreferredOpenClawTmpDir.mockReturnValue(os.tmpdir());
    ({
      rootDir,
      store,
      blobStore,
      cleanup: cleanupRootDir,
    } = await createDiffStoreHarness("openclaw-diffs-tool-"));
    resolvePreferredOpenClawTmpDir.mockReturnValue(rootDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupRootDir();
  });

  function createTool(overrides: Partial<Parameters<typeof createDiffsTool>[0]> = {}) {
    return createDiffsTool({
      getConfig: () => ({}),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      ...overrides,
    });
  }

  it("uses current public origin for retained tools after config reload", async () => {
    let config: OpenClawConfig = { gateway: { publicOrigin: "https://first.example" } };
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    const api = createTestPluginApi({ id: "diffs", config, registerTool });
    api.runtime.state = {
      ...api.runtime.state,
      openBlobStore: vi.fn().mockReturnValue(blobStore),
    };
    registerDiffsPlugin(api);
    const factory = registerTool.mock.calls[0]?.[0];
    if (typeof factory !== "function") {
      throw new Error("Diffs did not register a tool factory");
    }
    const getRuntimeConfig = vi.fn(() => config);
    const tool = factory({
      config: { gateway: { publicOrigin: "https://authored.example" } },
      runtimeConfig: { gateway: { publicOrigin: "https://initial.example" } },
      getRuntimeConfig,
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("Diffs did not return a tool");
    }
    for (const origin of ["https://first.example", "https://second.example"]) {
      config = { gateway: { publicOrigin: origin } };
      const result = await tool.execute("reload-origin", {
        before: "one\n",
        after: "two\n",
        mode: "view",
      });
      expect(String(readDetails(result).viewerUrl)).toMatch(`${origin}/plugins/diffs/view/`);
    }
    expect(getRuntimeConfig).toHaveBeenCalledTimes(2);
  });

  it("short-circuits identical before/after input without creating an artifact", async () => {
    const screenshotHtml = vi.fn<DiffScreenshotter["screenshotHtml"]>();
    const tool = createToolWithScreenshotter(store, { screenshotHtml });

    const result = await tool.execute?.("tool-identical", {
      before: "same\n",
      after: "same\n",
    });

    expect(readTextContent(result, 0)).toBe(
      "Before and after are identical — no changes to render.",
    );
    expect(readDetails(result)).toEqual({
      changed: false,
      context: {
        agentId: "main",
        sessionId: "session-123",
        messageChannel: "discord",
        agentAccountId: "default",
      },
    });
    expect(screenshotHtml).not.toHaveBeenCalled();
    await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prefers per-call baseUrl over configured viewerBaseUrl", async () => {
    const tool = createTool({
      viewerBaseUrl: "https://example.com/openclaw",
    });

    const result = await tool.execute?.("tool-viewer-override", {
      before: "one\n",
      after: "two\n",
      path: "README.md",
      mode: "view",
      baseUrl: "https://preview.example.com/review",
    });

    expect(readTextContent(result, 0)).toContain(
      "https://preview.example.com/review/plugins/diffs/view/",
    );
    expect(String(readDetails(result).viewerUrl)).toContain(
      "https://preview.example.com/review/plugins/diffs/view/",
    );
  });

  it("renders PDF output when fileFormat is pdf", async () => {
    const screenshotter = createPdfScreenshotter({
      assertOutputPath: (outputPath) => {
        expect(outputPath).toMatch(/preview\.pdf$/);
      },
    });

    browserRuntime.screenshotter = screenshotter;
    const tool = createTool();

    const result = await tool.execute?.("tool-2b", {
      before: "one\n",
      after: "two\n",
      mode: "image",
      fileFormat: "pdf",
    });

    expect(screenshotter["screenshotHtml"]).toHaveBeenCalledTimes(1);
    expect(readTextContent(result, 0)).toContain("Diff PDF generated at:");
    expect(readTextContent(result, 0)).toContain("use an available file-sending tool");
    expect(readTextContent(result, 0)).not.toMatch(/`message`|\bmessage tool\b/);
    expect(readDetails(result).fileFormat).toBe("pdf");
    expect(readDetails(result).filePath).toMatch(/preview\.pdf$/);
  });

  it("honors ttlSeconds for artifact-only file output", async () => {
    await fs.mkdir(rootDir, { recursive: true });
    const fixture = await createDiffStoreHarness("openclaw-diffs-tool-ttl-", {
      nativeKernel: true,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const screenshotter = createPngScreenshotter();
      const tool = createToolWithScreenshotter(fixture.store, screenshotter);
      const result = await tool.execute?.("tool-2c-ttl", {
        before: "one\n",
        after: "two\n",
        mode: "file",
        ttlSeconds: "1",
      });
      const filePath = requireString(readDetails(result).filePath, "filePath");
      await fs.access(filePath);
      await fixture.store.stopCleanup();
      await expireDiffArtifactForTest(
        fixture.rootDir,
        requireString(readDetails(result).artifactId, "artifactId"),
        1000,
      );
      await fixture.store.cleanupExpired();
      await expectFsEnoent(fs.stat(filePath));
    } finally {
      vi.useRealTimers();
      await fixture.cleanup();
    }
  });

  it("falls back to view output when both mode cannot render an image", async () => {
    browserRuntime.screenshotter = {
      screenshotHtml: vi.fn(async () => {
        throw new Error("browser missing");
      }),
    };
    const tool = createTool();

    const result = await tool.execute?.("tool-3", {
      before: "one\n",
      after: "two\n",
      mode: "both",
    });

    expect(result?.content).toHaveLength(1);
    expect(readTextContent(result, 0)).toContain("File rendering failed");
    expect(readDetails(result).fileError).toBe("browser missing");
    await expect(fs.readdir(rootDir)).resolves.toEqual([]);
  });

  it("falls back to view output when the default image renderer cannot load", async () => {
    const tool = createTool();

    const result = await tool.execute?.("tool-3b", {
      before: "one\n",
      after: "two\n",
      mode: "both",
    });

    expect(readTextContent(result, 0)).toContain("Diff viewer ready.");
    expect(readDetails(result).viewerUrl).toEqual(expect.any(String));
    expect(readDetails(result).fileError).toContain(
      "viewer-only rendering must not load the Playwright renderer",
    );
  });

  it("rejects invalid base URLs as tool input errors", async () => {
    const tool = createTool();

    await expect(
      tool.execute?.("tool-4", {
        before: "one\n",
        after: "two\n",
        mode: "view",
        baseUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow("Invalid baseUrl");
  });

  it("returns a tool input error for malformed raw arguments", async () => {
    const tool = createTool();

    await expect(tool.execute?.("tool-malformed-null", null)).rejects.toThrow(
      "Provide patch or both before and after text.",
    );
    await expect(tool.execute?.("tool-malformed-undefined", undefined)).rejects.toThrow(
      "Provide patch or both before and after text.",
    );
  });

  it("rejects oversized patch payloads", async () => {
    const tool = createTool();

    await expect(
      tool.execute?.("tool-oversize-patch", {
        patch: "x".repeat(2_100_000),
        mode: "view",
      }),
    ).rejects.toThrow("patch exceeds maximum size");
  });

  it("classifies patch render validation failures as tool input errors", async () => {
    const tool = createTool();

    const error = await tool
      .execute?.("tool-invalid-patch", {
        patch: "not a unified patch",
        mode: "view",
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toMatchObject({
      name: "ToolInputError",
      message: "Patch input did not contain any file diffs.",
    });
  });

  it("rejects oversized before/after payloads", async () => {
    const tool = createTool();

    const large = "x".repeat(600_000);
    await expect(
      tool.execute?.("tool-oversize-before", {
        before: large,
        after: "ok",
        mode: "view",
      }),
    ).rejects.toThrow("before exceeds maximum size");
  });

  it("uses configured defaults when tool params omit them", async () => {
    const tool = createTool({
      defaults: {
        ...DEFAULT_DIFFS_TOOL_DEFAULTS,
        mode: "view",
        theme: "light",
        layout: "split",
        wordWrap: false,
        background: false,
        fontFamily: "JetBrains Mono",
        fontSize: 17,
      },
      context: {
        agentId: "main",
        sessionId: "session-123",
        messageChannel: "discord",
        agentAccountId: "default",
      },
    });

    const result = await tool.execute?.("tool-5", {
      before: "one\n",
      after: "two\n",
      path: "README.md",
    });

    expect(readTextContent(result, 0)).toContain("Diff viewer ready.");
    expect(readDetails(result).mode).toBe("view");
    expect(readDetails(result).context).toEqual({
      agentId: "main",
      sessionId: "session-123",
      messageChannel: "discord",
      agentAccountId: "default",
    });

    const viewerPath = String(readDetails(result).viewerPath);
    const id = extractViewerArtifactId(viewerPath);
    const viewer = await store.readAuthorizedViewer(id, extractViewerArtifactToken(viewerPath));
    const html = Buffer.from(viewer!.html).toString("utf8");
    expect(html).toContain('body data-theme="light"');
    expect(html).toContain("--diffs-font-size: 17px;");
    expect(html).toContain("JetBrains Mono");
  });

  it("prefers explicit tool params over configured defaults", async () => {
    const screenshotter = createPngScreenshotter({
      assertHtml: (html) => {
        expect(html).toContain("../../assets/viewer.js");
      },
      assertImage: (image) => {
        expect(image.format).toBe("png");
        expect(image.qualityPreset).toBe("print");
        expect(image.scale).toBe(2.75);
        expect(image.maxWidth).toBe(1320);
      },
    });
    const tool = createToolWithScreenshotter(store, screenshotter, {
      ...DEFAULT_DIFFS_TOOL_DEFAULTS,
      mode: "view",
      theme: "light",
      layout: "split",
      fileQuality: "hq",
      fileScale: 2.2,
      fileMaxWidth: 1180,
    });

    const result = await tool.execute?.("tool-6", {
      before: "one\n",
      after: "two\n",
      mode: "both",
      theme: "dark",
      layout: "unified",
      fileQuality: "print",
      fileScale: 2.75,
      fileMaxWidth: 1320,
    });

    expect(readDetails(result).mode).toBe("both");
    expect(screenshotter["screenshotHtml"]).toHaveBeenCalledTimes(1);
    expect(readDetails(result).fileFormat).toBe("png");
    expect(readDetails(result).fileQuality).toBe("print");
    expect(readDetails(result).fileScale).toBe(2.75);
    expect(readDetails(result).fileMaxWidth).toBe(1320);
    const viewerPath = String(readDetails(result).viewerPath);
    const id = extractViewerArtifactId(viewerPath);
    const viewer = await store.readAuthorizedViewer(id, extractViewerArtifactToken(viewerPath));
    const html = Buffer.from(viewer!.html).toString("utf8");
    expect(html).toContain('body data-theme="dark"');
  });
});

function createToolWithScreenshotter(
  store: DiffArtifactStore,
  screenshotter: DiffScreenshotter,
  defaults = DEFAULT_DIFFS_TOOL_DEFAULTS,
  context: OpenClawPluginToolContext = {
    agentId: "main",
    sessionId: "session-123",
    messageChannel: "discord",
    agentAccountId: "default",
  },
) {
  browserRuntime.screenshotter = screenshotter;
  return createDiffsTool({
    getConfig: () => ({}),
    store,
    defaults,
    context,
  });
}

function createPngScreenshotter(
  params: {
    assertHtml?: (html: string) => void;
    assertImage?: (image: DiffRenderOptions["image"]) => void;
    assertOutputPath?: (outputPath: string) => void;
  } = {},
): DiffScreenshotter {
  const screenshotHtml: DiffScreenshotter["screenshotHtml"] = vi.fn(
    async ({
      html,
      outputPath,
      image,
    }: {
      html: string;
      outputPath: string;
      image: DiffRenderOptions["image"];
    }) => {
      params.assertHtml?.(html);
      params.assertImage?.(image);
      params.assertOutputPath?.(outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from("png"));
      return outputPath;
    },
  );
  return {
    screenshotHtml,
  };
}

function createPdfScreenshotter(
  params: {
    assertOutputPath?: (outputPath: string) => void;
  } = {},
): DiffScreenshotter {
  const screenshotHtml: DiffScreenshotter["screenshotHtml"] = vi.fn(
    async ({ outputPath, image }: { outputPath: string; image: DiffRenderOptions["image"] }) => {
      expect(image.format).toBe("pdf");
      params.assertOutputPath?.(outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from("%PDF-1.7"));
      return outputPath;
    },
  );
  return { screenshotHtml };
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDetails(result: unknown): Record<string, unknown> {
  const details = (result as { details?: unknown } | null | undefined)?.details;
  if (!isObjectValue(details)) {
    throw new Error("expected diffs tool result details");
  }
  return details;
}

function extractViewerArtifactId(viewerPath: string): string {
  const id = viewerPath.split("/").at(-2);
  if (!id) {
    throw new Error(`Missing artifact id in viewer path: ${viewerPath}`);
  }
  return id;
}

function extractViewerArtifactToken(viewerPath: string): string {
  const token = viewerPath.split("/").findLast((segment) => segment.length > 0);
  if (!token) {
    throw new Error("expected viewer artifact token");
  }
  return token;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

async function expectFsEnoent(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe("ENOENT");
    return;
  }
  throw new Error("expected ENOENT");
}

function readTextContent(result: unknown, index: number): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  const entry = content?.[index];
  return entry?.type === "text" ? (entry.text ?? "") : "";
}
