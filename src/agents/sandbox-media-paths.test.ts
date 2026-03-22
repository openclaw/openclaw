import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "./sandbox-media-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

describe("createSandboxBridgeReadFile", () => {
  it("delegates reads through the sandbox bridge with sandbox root cwd", async () => {
    const readFile = vi.fn(async () => Buffer.from("ok"));
    const scopedRead = createSandboxBridgeReadFile({
      sandbox: {
        root: "/tmp/sandbox-root",
        bridge: {
          readFile,
        } as unknown as SandboxFsBridge,
      },
    });
    await expect(scopedRead("media/inbound/example.png")).resolves.toEqual(Buffer.from("ok"));
    expect(readFile).toHaveBeenCalledWith({
      filePath: "media/inbound/example.png",
      cwd: "/tmp/sandbox-root",
    });
  });

  it("falls back to container paths when the bridge has no host path", async () => {
    const stat = vi.fn(async () => ({ type: "file", size: 1, mtimeMs: 1 }));
    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/tmp/sandbox-root",
        bridge: {
          resolvePath: ({ filePath }: { filePath: string }) => ({
            relativePath: filePath,
            containerPath: `/sandbox/${filePath}`,
          }),
          stat,
        } as unknown as SandboxFsBridge,
      },
      mediaPath: "image.png",
    });

    expect(resolved).toEqual({ resolved: "/sandbox/image.png" });
    expect(stat).not.toHaveBeenCalled();
  });

  it("allows default media roots when workspaceOnly is enabled", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-root-"));
    const defaultRoot = resolvePreferredOpenClawTmpDir();
    await fs.mkdir(defaultRoot, { recursive: true });
    const mediaDir = await fs.mkdtemp(path.join(defaultRoot, "openclaw-sandbox-media-"));
    const mediaPath = path.join(mediaDir, "generated.png");
    await fs.writeFile(mediaPath, Buffer.from("ok"));

    try {
      const resolved = await resolveSandboxedBridgeMediaPath({
        sandbox: {
          root: sandboxRoot,
          workspaceOnly: true,
          bridge: {
            resolvePath: ({ filePath }: { filePath: string }) => ({
              relativePath: path.basename(filePath),
              containerPath: filePath,
              hostPath: filePath,
            }),
          } as unknown as SandboxFsBridge,
        },
        mediaPath,
      });

      expect(resolved).toEqual({ resolved: mediaPath });
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
      await fs.rm(mediaDir, { recursive: true, force: true });
    }
  });
});
