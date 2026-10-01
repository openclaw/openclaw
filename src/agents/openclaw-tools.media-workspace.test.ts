import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function guardedNodes(workspaceDir: string, sandbox = false) {
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const tool = applyNodesToolWorkspaceGuard(
    { name: "nodes", label: "Nodes", description: "Nodes", parameters: Type.Object({}), execute },
    {
      workspaceDir,
      fsPolicy: { workspaceOnly: true },
      ...(sandbox ? { sandboxRoot: workspaceDir, sandboxContainerWorkdir: "/workspace" } : {}),
    },
  );
  return { tool, execute };
}

describe("nodes output paths", () => {
  it.each([
    { outPath: "capture.mp4", sandbox: false },
    { outPath: "/workspace/capture.mp4", sandbox: true },
  ])("normalizes $outPath before executing the node tool", async ({ outPath, sandbox }) => {
    const workspace = tempDirs.make("openclaw-nodes-workspace-");
    const { tool, execute } = guardedNodes(workspace, sandbox);
    await tool.execute("capture", { action: "screen_record", outPath });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "capture",
      { action: "screen_record", outPath: path.join(workspace, "capture.mp4") },
      undefined,
      undefined,
    );
  });

  it("rejects an output outside the workspace before node execution", async () => {
    const { tool, execute } = guardedNodes(tempDirs.make("openclaw-nodes-workspace-"));
    await expect(tool.execute("capture", { outPath: "/etc/passwd" })).rejects.toThrow(
      /Path escapes sandbox root/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

function createMediaTool(name: string, options: Parameters<typeof createOpenClawTools>[0]) {
  const tool = createOpenClawTools({
    config: { plugins: { enabled: false } },
    agentDir: tempDirs.make("openclaw-media-agent-"),
    modelHasVision: true,
    ...options,
  }).find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected registered ${name} tool`);
  }
  return tool;
}

async function expectLoadedImage(tool: ReturnType<typeof createMediaTool>, imagePath: string) {
  const result = await tool.execute("inspect-screenshot", { path: imagePath });
  expect(result.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "image", mimeType: "image/png", data: expect.any(String) }),
    ]),
  );
}

describe("media references in task workspaces", () => {
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
      await expect(tool.execute("outside-image", { path: imagePath })).rejects.toThrow(
        /not under an allowed directory/i,
      );
    }
  });

  it.each([false, true])(
    "loads session-worktree images with workspaceOnly=%s",
    async (workspaceOnly) => {
      const workspaceDir = tempDirs.make("openclaw-media-canonical-");
      const sessionRoot = tempDirs.make("openclaw-media-worktree-");
      const cwd = path.join(sessionRoot, "task");
      await fs.mkdir(cwd);
      const imagePath = path.join(cwd, "screenshot.png");
      await fs.writeFile(imagePath, png);
      await fs.writeFile(path.join(sessionRoot, "shared.png"), png);
      const tool = createMediaTool("view_image", {
        workspaceDir,
        cwd,
        fsPolicy: { workspaceOnly, root: sessionRoot },
      });

      await expectLoadedImage(tool, imagePath);
      await expectLoadedImage(tool, "screenshot.png");
      await expectLoadedImage(tool, "../shared.png");

      if (workspaceOnly) {
        const outsideImage = path.join(workspaceDir, "outside.png");
        await fs.writeFile(outsideImage, png);
        await expect(tool.execute("outside-image", { path: outsideImage })).rejects.toThrow(
          /not under an allowed directory/i,
        );
      }
    },
  );

  it("keeps sandbox media on its bridge despite a different host session root", async () => {
    const workspaceDir = tempDirs.make("openclaw-media-canonical-");
    const hostRoot = tempDirs.make("openclaw-media-host-");
    const sandboxRoot = tempDirs.make("openclaw-media-sandbox-");
    await fs.writeFile(path.join(sandboxRoot, "screenshot.png"), png);
    const hostImage = path.join(hostRoot, "host.png");
    await fs.writeFile(hostImage, png);
    const tool = createMediaTool("view_image", {
      workspaceDir,
      cwd: hostRoot,
      fsPolicy: { workspaceOnly: true, root: hostRoot },
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

  it.each([{ name: "reference.png", bytes: png, mime: "image/png" }])(
    "rejects $mime as a PDF after reading within the session root",
    async ({ name, bytes, mime }) => {
      const workspaceDir = tempDirs.make("openclaw-media-canonical-");
      const sessionRoot = tempDirs.make("openclaw-media-worktree-");
      const cwd = path.join(sessionRoot, "task");
      await fs.mkdir(cwd);
      const imagePath = path.join(sessionRoot, name);
      const outsidePath = path.join(workspaceDir, name);
      await fs.writeFile(imagePath, bytes);
      await fs.writeFile(outsidePath, bytes);
      const tool = createMediaTool("pdf", {
        config: {
          plugins: { allow: [] },
          tools: { allow: ["pdf"] },
          agents: { defaults: { pdfModel: { primary: "fixture/pdf-model" } } },
        },
        workspaceDir,
        cwd,
        fsPolicy: { workspaceOnly: true, root: sessionRoot },
      });

      // Reaching content validation proves file access without invoking a PDF provider.
      for (const pdf of [imagePath, `../${name}`]) {
        await expect(tool.execute("read-reference", { pdf })).rejects.toThrow(
          `Expected PDF but got ${mime}`,
        );
      }
      await expect(tool.execute("outside-reference", { pdf: outsidePath })).rejects.toThrow(
        /not under an allowed directory/i,
      );
    },
  );

  it.each(["image_generate"] as const)(
    "%s shared reference loader follows the task cwd and session boundary",
    async (toolName) => {
      const workspaceDir = tempDirs.make("openclaw-media-canonical-");
      const sessionRoot = tempDirs.make("openclaw-media-worktree-");
      const cwd = path.join(sessionRoot, "task");
      await fs.mkdir(cwd);
      const imagePath = path.join(sessionRoot, "reference.png");
      const outsidePath = path.join(workspaceDir, "reference.png");
      await fs.writeFile(imagePath, png);
      await fs.writeFile(outsidePath, png);
      const loadReferences = (inputs: string[]) =>
        loadMediaToolReferences({
          inputs,
          toolName,
          expectedKind: "image",
          workspaceDir,
          cwd,
          fsPolicy: { workspaceOnly: true, root: sessionRoot },
          sandbox: null,
          maxBytes: 1024 * 1024,
          mapMedia: (media) => media.buffer.byteLength,
        });

      const loaded = await loadReferences([imagePath, "../reference.png"]);
      expect(loaded).toHaveLength(2);
      for (const reference of loaded) {
        expect(reference.source).toBeGreaterThan(0);
      }
      await expect(loadReferences([outsidePath])).rejects.toThrow(
        /not under an allowed directory/i,
      );
    },
  );
});
