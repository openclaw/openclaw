import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ImageDescriptionRequest,
  MediaUnderstandingProvider,
} from "../plugin-sdk/media-understanding.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { testing as imageTesting } from "./tools/image-tool.test-support.js";

const GIF = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");

describe("assembled image tool task workspace", () => {
  let root: string;
  let workspaceDir: string;
  let cwd: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-task-"));
    workspaceDir = path.join(root, "agent");
    cwd = path.join(root, "task");
    await Promise.all([fs.mkdir(workspaceDir), fs.mkdir(cwd)]);
    await fs.writeFile(path.join(cwd, "proof.gif"), GIF);
    await fs.writeFile(path.join(workspaceDir, "private.gif"), GIF);
  });

  afterEach(async () => {
    imageTesting.setProviderDepsForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function imageTool(
    options: Pick<
      OpenClawToolsOptions,
      "cwd" | "sandboxRoot" | "sandboxFsBridge" | "modelHasVision" | "config"
    > = { cwd },
  ) {
    const tool = createOpenClawTools({
      agentDir: path.join(root, "agent-state"),
      workspaceDir,
      modelHasVision: true,
      ...options,
      fsPolicy: { workspaceOnly: true },
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    }).find((candidate) => candidate.name === "view_image");
    if (!tool) {
      throw new Error("Expected native image tool");
    }
    return tool;
  }

  it.each(["relative", "absolute"])("inspects %s task-local images", async (kind) => {
    const imagePath = kind === "relative" ? "proof.gif" : path.join(cwd, "proof.gif");
    const result = await imageTool().execute("task-image", { path: imagePath });
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
  });

  it("does not grant the separate agent workspace or a sibling task", async () => {
    const tool = imageTool();
    await expect(
      tool.execute("outside-image", { path: path.join(workspaceDir, "private.gif") }),
    ).rejects.toThrow(/not under an allowed directory/i);
    await expect(tool.execute("traversal-image", { path: "../agent/private.gif" })).rejects.toThrow(
      /not under an allowed directory/i,
    );
    const sibling = path.join(root, "other-task");
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, "proof.gif"), GIF);
    await expect(
      tool.execute("sibling-image", { path: path.join(sibling, "proof.gif") }),
    ).rejects.toThrow(/not under an allowed directory/i);
  });

  it("keeps workspace-local images available when no task cwd is supplied", async () => {
    const result = await imageTool({}).execute("workspace-image", { path: "private.gif" });
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
  });

  it("preserves canonical workspace context for a fallback provider", async () => {
    const describeImage = vi.fn(async (request: ImageDescriptionRequest) => ({
      text: "Synthetic image inspected",
      model: request.model,
    }));
    const provider: MediaUnderstandingProvider = {
      id: "fixture",
      capabilities: ["image"],
      describeImage,
    };
    const resolveCompression = vi.fn(async () => ({ imageCount: 1 }));
    imageTesting.setProviderDepsForTest({
      resolveRegisteredMediaUnderstandingProvider: () => provider,
      buildProviderRegistry: () => new Map([[provider.id, provider]]),
      getMediaUnderstandingProvider: () => provider,
      resolveImageCompressionPolicy: resolveCompression,
    });
    const tool = imageTool({
      cwd,
      modelHasVision: false,
      config: { agents: { defaults: { imageModel: { primary: "fixture/vision" } } } },
    });
    await tool.execute("fallback-image", { path: "proof.gif" });
    expect(resolveCompression).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir }));
    expect(describeImage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir, buffer: GIF }),
    );
  });

  it("keeps a sandbox rooted separately from the host task cwd", async () => {
    const sandboxRoot = path.join(root, "sandbox");
    await fs.mkdir(sandboxRoot);
    await fs.writeFile(path.join(sandboxRoot, "sandbox.gif"), GIF);
    const tool = imageTool({
      cwd,
      sandboxRoot,
      sandboxFsBridge: createHostSandboxFsBridge(sandboxRoot),
    });
    const result = await tool.execute("sandbox-image", { path: "sandbox.gif" });
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
    await expect(tool.execute("host-image", { path: path.join(cwd, "proof.gif") })).rejects.toThrow(
      /escapes.*root/i,
    );
  });
});
