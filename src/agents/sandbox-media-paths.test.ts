import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readOutboundMediaFile } from "../media/bounded-read-file.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "./sandbox-media-paths.js";
import { createSandboxFsBridge, type SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";

const root = "/tmp/sandbox-root";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function sandbox(bridge: Partial<SandboxFsBridge>, workspaceOnly = false) {
  return { root, bridge: bridge as SandboxFsBridge, workspaceOnly };
}
function containerPath(filePath: string, target = `/remote/workspace/${filePath}`) {
  return {
    relativePath: filePath === root ? "" : filePath,
    containerPath: filePath === root ? "/remote/workspace" : target,
  };
}

describe("createSandboxBridgeReadFile", () => {
  it("delegates reads through the sandbox bridge with sandbox root cwd", async () => {
    const readFile = vi.fn(async () => Buffer.from("ok"));
    const scopedRead = createSandboxBridgeReadFile({ sandbox: sandbox({ readFile }) });
    await expect(
      readOutboundMediaFile(scopedRead, "media/inbound/example.png", { maxBytes: 1024 }),
    ).resolves.toEqual(Buffer.from("ok"));
    expect(readFile).toHaveBeenCalledWith({
      filePath: "media/inbound/example.png",
      cwd: root,
      maxBytes: 1024,
    });
  });

  it.each([false, true])("enforces the workspace mount (outside=%s)", async (outside) => {
    const target = outside ? "/remote/agent/secret.png" : "/remote/workspace/image.png";
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) =>
      containerPath(filePath, target),
    );
    const result = resolveSandboxedBridgeMediaPath({
      sandbox: sandbox({ resolvePath }, true),
      mediaPath: outside ? target : "image.png",
    });
    if (outside) {
      await expect(result).rejects.toThrow(`Sandbox path escapes workspace root: ${target}`);
    } else {
      await expect(result).resolves.toEqual({ resolved: target });
      expect(resolvePath).toHaveBeenCalledWith({ filePath: root, cwd: root });
    }
  });

  it.each([true, false])("resolves only staged inbound media (staged=%s)", async (staged) => {
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      hostPath: `${root}/${filePath}`,
      relativePath: filePath,
      containerPath: `/sandbox/${filePath}`,
    }));
    const stat = vi.fn<SandboxFsBridge["stat"]>(async ({ filePath }) =>
      staged && filePath === "media/inbound/photo.png"
        ? { type: "file", size: 1, mtimeMs: 1 }
        : null,
    );
    const result = resolveSandboxedBridgeMediaPath({
      sandbox: sandbox({ resolvePath, stat }),
      mediaPath: "media://inbound/photo.png",
      inboundFallbackDir: "media/inbound",
    });
    if (!staged) {
      await expect(result).rejects.toThrow(
        "Sandbox media reference is not staged: media://inbound/photo.png",
      );
      expect(resolvePath).not.toHaveBeenCalled();
      return;
    }
    const resolved = await result;
    expect(stat).toHaveBeenCalledWith({ filePath: "media/inbound/photo.png", cwd: root });
    expect(resolvePath).toHaveBeenCalledWith({ filePath: "media/inbound/photo.png", cwd: root });
    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/photo.png",
      rewrittenFrom: "media://inbound/photo.png",
    });
  });
});

describe("sandbox media container file URLs", () => {
  it.each([false, true])("checks FILE: URL containment (outside=%s)", async (outside) => {
    const workspace = tempDirs.make("openclaw-sandbox-media-container-url-");
    const imagePath = path.join(workspace, "image.png");
    await fs.writeFile(imagePath, "image", "utf8");
    const bridge = createSandboxFsBridge({
      sandbox: {
        ...createSandboxTestContext({
          overrides: { workspaceDir: workspace, agentWorkspaceDir: workspace },
        }),
        backend: {
          runShellCommand: async () => {
            throw new Error("Path resolution must not execute backend commands");
          },
        },
      },
    });
    const result = resolveSandboxedBridgeMediaPath({
      sandbox: { root: workspace, bridge, workspaceOnly: true },
      mediaPath: outside ? "FILE:/outside/image.png" : "FILE:/workspace/image.png",
    });
    if (outside) {
      await expect(result).rejects.toThrow(/escapes sandbox root/i);
      return;
    }
    const resolved = await result;
    expect(resolved).toEqual({ resolved: imagePath });
    await expect(fs.readFile(resolved.resolved, "utf8")).resolves.toBe("image");
  });
});
