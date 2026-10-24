import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaywrightDiffScreenshotter } from "./browser.runtime.js";
import { resolveDiffsPluginDefaults } from "./config.js";
import { DiffArtifactStore } from "./store.js";
import {
  createDiffStoreHarness,
  diffContext as toolContext,
  expireDiffArtifactForTest,
  registerDiffsForTest,
} from "./test-helpers.js";
import type { DiffRenderOptions } from "./types.js";

let createDiffsTool: typeof import("./tool.js").createDiffsTool;
type DiffScreenshotter = Pick<PlaywrightDiffScreenshotter, "screenshotHtml">;

const { browserRuntime } = vi.hoisted(() => ({
  browserRuntime: { screenshotter: undefined as DiffScreenshotter | undefined },
}));

afterAll(() => {
  vi.doUnmock("./browser.runtime.js");
  vi.resetModules();
});

const DEFAULT_DIFFS_TOOL_DEFAULTS = resolveDiffsPluginDefaults(undefined);
const requireRecord = createRequireRecord("object", "expected-label");

function executeDiff(tool: ReturnType<typeof createDiffsTool>, args: Record<string, unknown> = {}) {
  return tool.execute("diff", { before: "one\n", after: "two\n", ...args });
}

async function readViewerHtml(store: DiffArtifactStore, result: unknown) {
  const [id, token] = String(readDetails(result).viewerPath).split("/").slice(-2);
  const viewer = await store.readAuthorizedViewer(
    requireString(id, "artifact id"),
    requireString(token, "artifact token"),
  );
  return Buffer.from(viewer!.html).toString("utf8");
}

describe("diffs tool", () => {
  let rootDir: string;
  let store: DiffArtifactStore;
  let cleanupRootDir: () => Promise<void>;
  let stopRegistration: (() => Promise<void>) | undefined;
  let blobStore: Awaited<ReturnType<typeof createDiffStoreHarness>>["blobStore"];

  beforeEach(async () => {
    stopRegistration = undefined;
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
    ({
      rootDir,
      store,
      blobStore,
      cleanup: cleanupRootDir,
    } = await createDiffStoreHarness("openclaw-diffs-tool-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await stopRegistration?.();
    await cleanupRootDir();
  });

  function createTool(
    overrides: Omit<Partial<Parameters<typeof createDiffsTool>[0]>, "defaults"> & {
      defaults?: Partial<Parameters<typeof createDiffsTool>[0]["defaults"]>;
    } = {},
    screenshotter?: DiffScreenshotter,
  ) {
    if (screenshotter) {
      browserRuntime.screenshotter = screenshotter;
    }
    return createDiffsTool({
      getConfig: () => ({}),
      store,
      ...overrides,
      defaults: { ...DEFAULT_DIFFS_TOOL_DEFAULTS, ...overrides.defaults },
    });
  }

  it("uses current public origin for retained tools after config reload", async () => {
    let config: OpenClawConfig = { gateway: { publicOrigin: "https://first.example" } };
    const registration = registerDiffsForTest({
      stateDir: path.join(path.dirname(rootDir), "state"),
      blobStore,
      getConfig: () => config,
    });
    stopRegistration = registration.stop;
    const getRuntimeConfig = vi.fn(() => config);
    const tool = registration.tool({
      config: { gateway: { publicOrigin: "https://authored.example" } },
      runtimeConfig: { gateway: { publicOrigin: "https://initial.example" } },
      getRuntimeConfig,
    });
    for (const origin of ["https://first.example", "https://second.example"]) {
      config = { gateway: { publicOrigin: origin } };
      const result = await executeDiff(tool, { mode: "view" });
      expect(String(readDetails(result).viewerUrl)).toMatch(`${origin}/plugins/diffs/view/`);
    }
    expect(getRuntimeConfig).toHaveBeenCalledTimes(2);
  });

  it("short-circuits identical before/after input without creating an artifact", async () => {
    const screenshotHtml = vi.fn<DiffScreenshotter["screenshotHtml"]>();
    const tool = createTool({ context: toolContext }, { screenshotHtml });

    const result = await executeDiff(tool, {
      before: "same\n",
      after: "same\n",
    });

    expect(readTextContent(result, 0)).toBe(
      "Before and after are identical — no changes to render.",
    );
    expect(readDetails(result)).toEqual({
      changed: false,
      context: toolContext,
    });
    expect(screenshotHtml).not.toHaveBeenCalled();
    await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prefers per-call baseUrl over configured viewerBaseUrl", async () => {
    const tool = createTool({ viewerBaseUrl: "https://example.com/openclaw" });

    const result = await executeDiff(tool, {
      path: "README.md",
      mode: "view",
      baseUrl: "https://preview.example.com/review",
    });

    const url = "https://preview.example.com/review/plugins/diffs/view/";
    expect(readTextContent(result, 0)).toContain(url);
    expect(readDetails(result).viewerUrl).toContain(url);
  });

  it("renders PDF output when fileFormat is pdf", async () => {
    const screenshotter = createScreenshotter("pdf", ({ outputPath }) => {
      expect(outputPath).toMatch(/preview\.pdf$/);
    });

    const result = await executeDiff(createTool({}, screenshotter), {
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
      const screenshotter = createScreenshotter();
      const tool = createTool({ store: fixture.store, context: toolContext }, screenshotter);
      const result = await executeDiff(tool, {
        mode: "file",
        ttlSeconds: "1",
      });
      const filePath = requireString(readDetails(result).filePath, "filePath");
      expect(filePath).toMatch(/preview\.png$/);
      expect(filePath).toContain(fixture.rootDir);
      expect(Date.parse(String(readDetails(result).expiresAt))).toBeGreaterThan(Date.now());
      await expect(
        fixture.blobStore.lookup(String(readDetails(result).artifactId)),
      ).resolves.toMatchObject({
        key: readDetails(result).artifactId,
        sizeBytes: 0,
        metadata: { version: 1, kind: "rendered_file", format: "png", context: toolContext },
      });
      await fs.access(filePath);
      await fixture.store.stopCleanup();
      await expireDiffArtifactForTest(
        fixture.rootDir,
        requireString(readDetails(result).artifactId, "artifactId"),
        1000,
      );
      await fixture.store.cleanupExpired();
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
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
    const result = await executeDiff(createTool(), { mode: "both" });

    expect(result?.content).toHaveLength(1);
    expect(readTextContent(result, 0)).toContain("File rendering failed");
    expect(readDetails(result).fileError).toBe("browser missing");
    await expect(fs.readdir(rootDir)).resolves.toEqual([]);
    expect((await blobStore.entries()).map(({ metadata }) => metadata.kind)).toEqual(["viewer"]);
  });

  it("falls back to view output when the default image renderer cannot load", async () => {
    const result = await executeDiff(createTool(), { mode: "both" });

    expect(readTextContent(result, 0)).toContain("Diff viewer ready.");
    expect(readDetails(result).viewerUrl).toEqual(expect.any(String));
    expect(readDetails(result).fileError).toContain(
      "viewer-only rendering must not load the Playwright renderer",
    );
  });

  it.each([
    [
      "base URL",
      { before: "one\n", after: "two\n", mode: "view", baseUrl: "javascript:alert(1)" },
      "Invalid baseUrl",
    ],
    ["null", null, "Provide patch or both before and after text."],
    ["undefined", undefined, "Provide patch or both before and after text."],
    ["patch size", { patch: "x".repeat(2_100_000), mode: "view" }, "patch exceeds maximum size"],
    [
      "before size",
      { before: "x".repeat(600_000), after: "ok", mode: "view" },
      "before exceeds maximum size",
    ],
  ] as const)("rejects invalid %s input", async (_name, args, message) => {
    await expect(createTool().execute("invalid", args)).rejects.toThrow(message);
  });

  it("classifies patch render validation failures as tool input errors", async () => {
    const tool = createTool();

    await expect(
      tool.execute("tool-invalid-patch", {
        patch: "not a unified patch",
        mode: "view",
      }),
    ).rejects.toMatchObject({
      name: "ToolInputError",
      message: "Patch input did not contain any file diffs.",
    });
  });

  it("prefers explicit tool params over configured defaults", async () => {
    const screenshotter = createScreenshotter("png", ({ html, image }) => {
      expect(html).toContain("../../assets/viewer.js");
      expect(image).toMatchObject({
        format: "png",
        qualityPreset: "print",
        scale: 2.75,
        maxWidth: 1320,
      });
    });
    const tool = createTool(
      {
        context: toolContext,
        defaults: {
          mode: "view",
          theme: "light",
          layout: "split",
          fileQuality: "hq",
          fileScale: 2.2,
          fileMaxWidth: 1180,
        },
      },
      screenshotter,
    );

    const result = await executeDiff(tool, {
      mode: "both",
      theme: "dark",
      layout: "unified",
      fileQuality: "print",
      fileScale: 2.75,
      fileMaxWidth: 1320,
    });

    expect(screenshotter["screenshotHtml"]).toHaveBeenCalledTimes(1);
    expect(readDetails(result)).toMatchObject({
      mode: "both",
      fileFormat: "png",
      fileQuality: "print",
      fileScale: 2.75,
      fileMaxWidth: 1320,
    });
    const html = await readViewerHtml(store, result);
    expect(html).toContain('body data-theme="dark"');
  });
});

function createScreenshotter(
  format: DiffRenderOptions["image"]["format"] = "png",
  inspect?: (params: Parameters<DiffScreenshotter["screenshotHtml"]>[0]) => void,
): DiffScreenshotter {
  const screenshotHtml = vi.fn<DiffScreenshotter["screenshotHtml"]>(async (params) => {
    const { outputPath, image } = params;
    expect(image.format).toBe(format);
    inspect?.(params);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from(format === "pdf" ? "%PDF-1.7" : "png"));
    return outputPath;
  });
  return { screenshotHtml };
}

function readDetails(result: unknown): Record<string, unknown> {
  const details = (result as { details?: unknown } | null | undefined)?.details;
  return requireRecord(details, "diffs tool result details");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function readTextContent(result: unknown, index: number): string {
  const entry = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content?.[index];
  return entry?.type === "text" ? (entry.text ?? "") : "";
}
