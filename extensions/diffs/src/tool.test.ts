import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaywrightDiffScreenshotter } from "./browser.runtime.js";
import { resolveDiffsPluginDefaults } from "./config.js";
import {
  createDiffStoreHarness,
  diffContext as toolContext,
  expireDiffArtifactForTest,
  registerDiffsForTest,
} from "./test-helpers.js";
import type { DiffRenderOptions } from "./types.js";

let createDiffsTool: typeof import("./tool.js").createDiffsTool;
type DiffScreenshotter = Pick<PlaywrightDiffScreenshotter, "screenshotHtml">;

let renderer: DiffScreenshotter | undefined;

afterAll(() => {
  vi.doUnmock("./browser.runtime.js");
  vi.resetModules();
});

const requireRecord = createRequireRecord("object", "expected-label");
const rendererError = "renderer unavailable";

async function executeDiff(
  tool: ReturnType<typeof createDiffsTool>,
  args: Record<string, unknown> = {},
) {
  const result = await tool.execute("diff", { before: "one\n", after: "two\n", ...args });
  return {
    ...result,
    details: requireRecord(result.details, "diffs tool result details"),
    text: result.content.find((entry) => entry.type === "text")?.text ?? "",
  };
}

describe("diffs tool", () => {
  let fixture: Awaited<ReturnType<typeof createDiffStoreHarness>>;
  let stopRegistration: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    stopRegistration = undefined;
    vi.resetModules();
    renderer = undefined;
    vi.doMock("./browser.runtime.js", async (importOriginal) => {
      if (!renderer) {
        throw new Error(rendererError);
      }
      return {
        ...(await importOriginal<typeof import("./browser.runtime.js")>()),
        PlaywrightDiffScreenshotter: vi.fn(function () {
          return renderer;
        }),
      };
    });
    ({ createDiffsTool } = await import("./tool.js"));
    fixture = await createDiffStoreHarness("openclaw-diffs-tool-", { nativeKernel: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await stopRegistration?.();
    await fixture.cleanup();
  });

  function createTool(
    overrides: Omit<Partial<Parameters<typeof createDiffsTool>[0]>, "defaults"> & {
      defaults?: Partial<Parameters<typeof createDiffsTool>[0]["defaults"]>;
    } = {},
    screenshotter?: DiffScreenshotter,
  ) {
    if (screenshotter) {
      renderer = screenshotter;
    }
    return createDiffsTool({
      getConfig: () => ({}),
      store: fixture.store,
      ...overrides,
      defaults: { ...resolveDiffsPluginDefaults(undefined), ...overrides.defaults },
    });
  }

  it("uses current public origin for retained tools after config reload", async () => {
    let config: OpenClawConfig = { gateway: { publicOrigin: "https://first.example" } };
    const registration = registerDiffsForTest({
      stateDir: path.join(path.dirname(fixture.rootDir), "state"),
      blobStore: fixture.blobStore,
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
      expect(String(result.details.viewerUrl)).toMatch(`${origin}/plugins/diffs/view/`);
    }
  });

  it("short-circuits identical before/after input without creating an artifact", async () => {
    const result = await executeDiff(createTool({ context: toolContext }), {
      before: "same\n",
      after: "same\n",
    });

    expect(result.text).toBe("Before and after are identical — no changes to render.");
    expect(result.details).toEqual({ changed: false, context: toolContext });
    await expect(fs.stat(fixture.rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["image", "pdf"],
    ["file", "png"],
  ] as const)("renders and expires %s output as %s", async (mode, format) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const tool = createTool({ context: toolContext }, createScreenshotter(format));
    const result = await executeDiff(tool, { mode, fileFormat: format, ttlSeconds: "1" });
    const { filePath: output, artifactId, expiresAt } = result.details;
    const filePath = String(output);
    expect(result.text).toContain(`Diff ${format.toUpperCase()} generated at:`);
    expect(result.text).toContain("use an available file-sending tool");
    expect(result.text).not.toMatch(/`message`|\bmessage tool\b/);
    expect(result.details.fileFormat).toBe(format);
    expect(filePath.endsWith(`preview.${format}`)).toBe(true);
    expect(filePath).toContain(fixture.rootDir);
    expect(Date.parse(String(expiresAt))).toBeGreaterThan(Date.now());
    await expect(fixture.blobStore.lookup(String(artifactId))).resolves.toMatchObject({
      key: artifactId,
      sizeBytes: 0,
      metadata: { version: 1, kind: "rendered_file", format, context: toolContext },
    });
    await fs.access(filePath);
    await fixture.store.stopCleanup();
    await expireDiffArtifactForTest(fixture.rootDir, String(artifactId), 1000);
    await fixture.store.cleanupExpired();
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["render", "load"])("keeps the viewer when the renderer fails to %s", async (stage) => {
    if (stage === "render") {
      renderer = {
        screenshotHtml: vi.fn(async () => {
          throw new Error(rendererError);
        }),
      };
    }
    const result = await executeDiff(createTool(), { mode: "both" });
    expect(result?.content).toHaveLength(1);
    expect(result.text).toContain("Diff viewer ready.");
    expect(result.text).toContain("File rendering failed");
    expect(result.details.viewerUrl).toEqual(expect.any(String));
    if (stage === "render") {
      expect(result.details.fileError).toBe(rendererError);
      await expect(fs.readdir(fixture.rootDir)).resolves.toEqual([]);
    } else {
      expect(result.details.fileError).toContain(rendererError);
    }
    expect((await fixture.blobStore.entries()).map(({ metadata }) => metadata.kind)).toEqual([
      "viewer",
    ]);
  });

  it.each([
    [
      "base URL",
      { before: "one\n", after: "two\n", mode: "view", baseUrl: "javascript:alert(1)" },
      "Invalid baseUrl",
    ],
    ["undefined", undefined, "Provide patch or both before and after text."],
    ["patch size", { patch: "x".repeat(2_100_000), mode: "view" }, "patch exceeds maximum size"],
    [
      "before size",
      { before: "x".repeat(600_000), after: "ok", mode: "view" },
      "before exceeds maximum size",
    ],
    [
      "patch syntax",
      { patch: "not a unified patch", mode: "view" },
      "Patch input did not contain any file diffs.",
    ],
  ] as const)("rejects invalid %s input", async (_name, args, message) => {
    await expect(createTool().execute("invalid", args)).rejects.toMatchObject({
      name: "ToolInputError",
      message: _name === "patch syntax" ? message : expect.stringContaining(message),
    });
  });

  it("preserves trailing patch whitespace in the viewer payload", async () => {
    const result = await createTool().execute("patch-whitespace", {
      patch: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new  \n",
      mode: "view",
    });
    const details = requireRecord(result.details, "diffs tool result details");
    const [id = "", token = ""] = String(details.viewerPath).split("/").slice(-2);
    const viewer = await fixture.store.readAuthorizedViewer(id, token);
    assert(viewer, "viewer artifact missing");
    const encoded = Buffer.from(viewer.html)
      .toString("utf8")
      .match(
        /<script type="application\/json" data-openclaw-diff-payload>([\s\S]*?)<\/script>/,
      )?.[1];
    assert(encoded, "viewer payload missing");
    const payload = requireRecord(JSON.parse(encoded), "viewer payload");
    const fileDiff = requireRecord(payload.fileDiff, "file diff");
    expect(fileDiff.additionLines).toEqual(["new  \n"]);
    expect(fileDiff.deletionLines).toEqual(["old\n"]);
  });

  it("prefers explicit tool params over configured defaults", async () => {
    const tool = createTool(
      {
        context: toolContext,
        viewerBaseUrl: "https://example.com/openclaw",
        defaults: {
          mode: "view",
          theme: "light",
          layout: "split",
          fileQuality: "hq",
          fileScale: 2.2,
          fileMaxWidth: 1180,
        },
      },
      createScreenshotter(),
    );

    const result = await executeDiff(tool, {
      mode: "both",
      baseUrl: "https://preview.example.com/review",
      theme: "dark",
      layout: "unified",
      fileQuality: "print",
      fileScale: 2.75,
      fileMaxWidth: 1320,
    });

    expect(result.details).toMatchObject({
      mode: "both",
      fileFormat: "png",
      fileQuality: "print",
      fileScale: 2.75,
      fileMaxWidth: 1320,
    });
    const url = "https://preview.example.com/review/plugins/diffs/view/";
    expect(result.text).toContain(url);
    expect(result.details.viewerUrl).toContain(url);
    const [id = "", token = ""] = String(result.details.viewerPath).split("/").slice(-2);
    const viewer = await fixture.store.readAuthorizedViewer(id, token);
    const html = Buffer.from(viewer!.html).toString("utf8");
    expect(html).toContain('body data-theme="dark"');
  });
});

function createScreenshotter(
  format: DiffRenderOptions["image"]["format"] = "png",
): DiffScreenshotter {
  const screenshotHtml = vi.fn<DiffScreenshotter["screenshotHtml"]>(async (params) => {
    const { outputPath, image } = params;
    expect(image.format).toBe(format);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from(format === "pdf" ? "%PDF-1.7" : "png"));
    return outputPath;
  });
  return { screenshotHtml };
}
