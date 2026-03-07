import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { createComfyGenerateTool } from "./comfy-generate-tool.js";

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return {
    id: "comfyui",
    name: "comfyui",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: { version: "test" },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    ...overrides,
  } as OpenClawPluginApi;
}

describe("comfy_generate tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns MEDIA path on successful bridge response", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-comfyui-test-"));
    const imagePath = path.join(tempDir, "generated.png");
    await fs.writeFile(imagePath, "png");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              job_id: "job-123",
              image_path: imagePath,
              width: 1024,
              height: 1024,
              seed: 42,
              model: "flux.1-dev",
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    );

    const tool = createComfyGenerateTool(
      fakeApi({
        pluginConfig: {
          allowedModels: ["flux.1-dev"],
          timeoutMs: 60_000,
          outputDir: tempDir,
          allowedPathRoots: [tempDir, os.tmpdir()],
        },
      }),
    );
    const result = await tool.execute("call-1", {
      prompt: "A studio photo of a fox",
      model: "flux.1-dev",
    });

    const mediaText = result.content?.find((entry) => entry.type === "text")?.text ?? "";
    expect(mediaText).toContain(`MEDIA:${imagePath}`);
  });

  it("rejects model override outside allowlist", async () => {
    const tool = createComfyGenerateTool(
      fakeApi({
        pluginConfig: {
          allowedModels: ["flux.1-dev"],
        },
      }),
    );

    await expect(
      tool.execute("call-2", {
        prompt: "A mountain",
        model: "sdxl.safetensors",
      }),
    ).rejects.toThrow(/model not allowed/i);
  });

  it("requires workflowPath when control stack is used", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-comfyui-test-"));
    const controlPath = path.join(tempDir, "control.png");
    await fs.writeFile(controlPath, "png");

    const tool = createComfyGenerateTool(
      fakeApi({
        pluginConfig: {
          allowedPathRoots: [tempDir, os.tmpdir()],
        },
      }),
    );

    await expect(
      tool.execute("call-3", {
        prompt: "A portrait",
        control: [{ type: "canny", imagePath: controlPath }],
      }),
    ).rejects.toThrow(/workflowPath is required/i);
  });
});
