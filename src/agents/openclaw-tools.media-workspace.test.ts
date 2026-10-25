import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getMediaDir, saveMediaBuffer } from "../media/store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.registration.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { loadMediaToolReferences } from "./tools/media-tool-shared.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/BsAAAAASUVORK5CYII=",
  "base64",
);

it.each([
  ["capture.mp4", false],
  ["/workspace/capture.mp4", true],
  ["/etc/passwd", false],
] as const)("guards node output %s (sandbox=%s)", async (outPath, sandbox) => {
  const workspaceDir = tempDirs.make("openclaw-nodes-workspace-");
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const tool = applyNodesToolWorkspaceGuard(
    { name: "nodes", label: "Nodes", description: "Nodes", parameters: Type.Object({}), execute },
    {
      workspaceDir,
      fsPolicy: { workspaceOnly: true },
      ...(sandbox ? { sandboxRoot: workspaceDir, sandboxContainerWorkdir: "/workspace" } : {}),
    },
  );
  const result = tool.execute("capture", { action: "screen_record", outPath });
  if (outPath === "/etc/passwd") {
    await expect(result).rejects.toThrow(/Path escapes sandbox root/);
    expect(execute).not.toHaveBeenCalled();
  } else {
    await result;
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "capture",
      { action: "screen_record", outPath: path.join(workspaceDir, "capture.mp4") },
      undefined,
      undefined,
    );
  }
});
function createMediaTool(name: string, options: Parameters<typeof createOpenClawTools>[0]) {
  const tool = createOpenClawTools({
    config: { plugins: { enabled: false } },
    agentDir: tempDirs.make("openclaw-media-agent-"),
    modelHasVision: true,
    ...options,
  }).find((candidate) => candidate.name === name);
  assert(tool, `Expected registered ${name} tool`);
  return tool;
}

async function expectLoadedImage(tool: ReturnType<typeof createMediaTool>, imagePath: string) {
  const result = await tool.execute("inspect-screenshot", { path: imagePath });
  expect(result.content).toContainEqual(
    expect.objectContaining({ type: "image", mimeType: "image/png", data: expect.any(String) }),
  );
}

async function sessionFiles(name = "reference.png") {
  const workspaceDir = tempDirs.make("openclaw-media-canonical-");
  const sessionRoot = tempDirs.make("openclaw-media-worktree-");
  const cwd = path.join(sessionRoot, "task");
  await fs.mkdir(cwd);
  const imagePath = path.join(sessionRoot, name);
  const outsidePath = path.join(workspaceDir, name);
  await Promise.all([imagePath, outsidePath].map((file) => fs.writeFile(file, png)));
  return {
    imagePath,
    outsidePath,
    options: { workspaceDir, cwd, fsPolicy: { workspaceOnly: true, root: sessionRoot } },
  };
}
const expectOutside = (result: Promise<unknown>) =>
  expect(result).rejects.toThrow(/not under an allowed directory/i);

it("loads Gateway media with workspace-only access while rejecting outside files and symlinks", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-media-state-"));
  const workspaceDir = tempDirs.make("openclaw-media-worktree-");
  const tool = createMediaTool("view_image", {
    workspaceDir,
    fsPolicy: { workspaceOnly: true, root: workspaceDir },
  });
  for (const subdir of ["browser", "inbound/openclaw-staged-fixture", "generated"]) {
    const saved = await saveMediaBuffer(png, "image/png", subdir);
    await expectLoadedImage(tool, saved.path);
  }

  const outsidePath = path.join(tempDirs.make("openclaw-media-outside-"), "private.png");
  await fs.writeFile(outsidePath, png);
  const aliasPath = path.join(getMediaDir(), "escape.png");
  await fs.symlink(outsidePath, aliasPath);
  for (const imagePath of [outsidePath, aliasPath]) {
    await expectOutside(tool.execute("outside-image", { path: imagePath }));
  }
});

it("loads session-worktree images with workspaceOnly=true", async () => {
  const { outsidePath, options } = await sessionFiles("shared.png");
  const imagePath = path.join(options.cwd, "screenshot.png");
  await fs.writeFile(imagePath, png);
  const tool = createMediaTool("view_image", options);
  await expectLoadedImage(tool, imagePath);
  await expectLoadedImage(tool, "screenshot.png");
  await expectLoadedImage(tool, "../shared.png");
  await expectOutside(tool.execute("outside-image", { path: outsidePath }));
});

it("keeps sandbox media on its bridge despite a different host session root", async () => {
  const { imagePath: hostImage, options } = await sessionFiles("host.png");
  const sandboxRoot = tempDirs.make("openclaw-media-sandbox-");
  await fs.writeFile(path.join(sandboxRoot, "screenshot.png"), png);
  const tool = createMediaTool("view_image", {
    ...options,
    sandboxRoot,
    sandboxFsBridge: createHostSandboxFsBridge(sandboxRoot),
  });

  await expectLoadedImage(tool, "screenshot.png");
  await expect(tool.execute("host-image", { path: hostImage })).rejects.toThrow(
    /escapes sandbox root/i,
  );
});

it("discards an image when the run is cancelled during a sandbox read", async () => {
  const sandboxRoot = tempDirs.make("openclaw-media-sandbox-");
  await fs.writeFile(path.join(sandboxRoot, "screenshot.png"), png);
  const bridge = createHostSandboxFsBridge(sandboxRoot);
  const readStarted = createDeferredCore();
  const finishRead = createDeferredCore();
  const controller = new AbortController();
  const tool = createMediaTool("view_image", {
    sandboxRoot,
    sandboxFsBridge: {
      ...bridge,
      readFile: async (params) => {
        readStarted.resolve();
        await finishRead.promise;
        return await bridge.readFile(params);
      },
    },
  });

  const result = tool.execute("cancelled-image", { path: "screenshot.png" }, controller.signal);
  const rejected = expect(result).rejects.toThrow("cancelled image inspection");
  await readStarted.promise;
  controller.abort(new Error("cancelled image inspection"));
  finishRead.resolve();
  await rejected;
});

it("rejects image/png as a PDF after reading within the session root", async () => {
  const { imagePath, outsidePath, options } = await sessionFiles();
  const tool = createMediaTool("pdf", {
    config: {
      plugins: { allow: [] },
      tools: { allow: ["pdf"] },
      agents: { defaults: { pdfModel: { primary: "fixture/pdf-model" } } },
    },
    ...options,
  });

  // Reaching content validation proves file access without invoking a PDF provider.
  for (const pdf of [imagePath, "../reference.png"]) {
    await expect(tool.execute("read-reference", { pdf })).rejects.toThrow(
      "Expected PDF but got image/png",
    );
  }
  await expectOutside(tool.execute("outside-reference", { pdf: outsidePath }));
});

it("image_generate shared reference loader follows the task cwd and session boundary", async () => {
  const { imagePath, outsidePath, options } = await sessionFiles();
  const loadReferences = (inputs: string[]) =>
    loadMediaToolReferences({
      inputs,
      toolName: "image_generate",
      expectedKind: "image",
      ...options,
      sandbox: null,
      maxBytes: 1024 * 1024,
      mapMedia: (media) => media.buffer.byteLength,
    });

  const loaded = await loadReferences([imagePath, "../reference.png"]);
  expect(loaded).toHaveLength(2);
  expect(loaded.every(({ source }) => typeof source === "number" && source > 0)).toBe(true);
  await expectOutside(loadReferences([outsidePath]));
});
