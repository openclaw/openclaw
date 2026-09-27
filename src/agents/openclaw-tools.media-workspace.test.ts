import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { loadMediaToolReferences } from "./tools/media-tool-shared.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/BsAAAAASUVORK5CYII=",
  "base64",
);

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

  it("uses the task cwd when no explicit session root is provided", async () => {
    const workspaceDir = tempDirs.make("openclaw-media-canonical-");
    const cwd = tempDirs.make("openclaw-media-task-cwd-");
    const imagePath = path.join(cwd, "screenshot.png");
    await fs.writeFile(imagePath, png);
    const tool = createMediaTool("view_image", {
      workspaceDir,
      cwd,
      fsPolicy: { workspaceOnly: true },
    });

    await expectLoadedImage(tool, imagePath);
    await expectLoadedImage(tool, "screenshot.png");
  });

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

  it.each([
    { name: "reference.png", bytes: png, mime: "image/png" },
    {
      name: "reference.txt",
      bytes: Buffer.from("This is a text document, not a PDF."),
      mime: "text/plain",
    },
    { name: "reference.json", bytes: Buffer.from('{"format":"json"}'), mime: "application/json" },
  ])(
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

  it.each(["image_generate", "video_generate", "music_generate"] as const)(
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
