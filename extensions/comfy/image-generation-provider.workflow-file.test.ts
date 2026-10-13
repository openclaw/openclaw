import { execFileSync, spawn } from "node:child_process";
import { truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { buildComfyImageGenerationProvider } from "./image-generation-provider.js";
import { buildComfyConfig } from "./test-helpers.js";

type FetchWithSsrFGuard = (typeof import("openclaw/plugin-sdk/ssrf-runtime"))["fetchWithSsrFGuard"];

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock as unknown as FetchWithSsrFGuard,
  };
});

const DEFAULT_COMFY_WORKFLOW_FILE_MAX_BYTES = 100 * 1024 * 1024;

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

it.runIf(process.platform !== "win32")(
  "rejects FIFO workflowPath files through provider generation and settles the writer",
  async () => {
    await withTempDir("openclaw-comfy-workflow-fifo-", async (tempRoot) => {
      const workflowPath = path.join(tempRoot, "workflow.pipe");
      execFileSync("mkfifo", [workflowPath]);
      const writer = spawn(
        "/bin/sh",
        ["-c", 'printf "{}" > "$1"', "openclaw-comfy-workflow-fifo", workflowPath],
        { stdio: "ignore" },
      );
      const writerClosed = new Promise<void>((resolve) => {
        writer.once("close", () => resolve());
      });

      try {
        await new Promise<void>((resolve, reject) => {
          writer.once("spawn", resolve);
          writer.once("error", reject);
        });
        await expect(
          buildComfyImageGenerationProvider().generateImage({
            provider: "comfy",
            model: "workflow",
            prompt: "draw from a FIFO workflow file",
            cfg: buildComfyConfig({
              workflowFileMaxBytes: DEFAULT_COMFY_WORKFLOW_FILE_MAX_BYTES,
              workflow: undefined,
              workflowPath,
              promptNodeId: "6",
              outputNodeId: "9",
            }),
          }),
        ).rejects.toThrow(/regular file/i);
        expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      } finally {
        if (writer.exitCode === null && writer.signalCode === null) {
          writer.kill("SIGKILL");
        }
        await writerClosed;
      }
    });
  },
);

it("preserves unconfigured workflowPath reads above the optional 100 MiB boundary", async () => {
  await withTempDir("openclaw-comfy-workflow-", async (tempRoot) => {
    const workflowPath = path.join(tempRoot, "legacy-large-workflow.json");
    await writeFile(workflowPath, "", "utf8");
    await truncate(workflowPath, DEFAULT_COMFY_WORKFLOW_FILE_MAX_BYTES + 1);

    await expect(
      buildComfyImageGenerationProvider().generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a legacy large workflow file",
        cfg: buildComfyConfig({
          workflow: undefined,
          workflowPath,
          promptNodeId: "6",
          outputNodeId: "9",
        }),
      }),
    ).rejects.toThrow(/Unexpected end of JSON input|Unexpected token/);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
