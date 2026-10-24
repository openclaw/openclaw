import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOutboundMediaFile } from "../media/bounded-read-file.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "./sandbox-media-paths.js";
import { createSandboxFsBridge, type SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";

const root = "/tmp/sandbox-root";
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

  it("keeps workspace-only container paths under the sandbox workspace mount", async () => {
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => containerPath(filePath));
    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: sandbox({ resolvePath }, true),
      mediaPath: "image.png",
    });

    expect(resolved).toEqual({ resolved: "/remote/workspace/image.png" });
    expect(resolvePath).toHaveBeenCalledWith({ filePath: root, cwd: root });
  });

  it("rejects workspace-only container paths outside the sandbox workspace mount", async () => {
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) =>
      containerPath(filePath, "/remote/agent/secret.png"),
    );
    await expect(
      resolveSandboxedBridgeMediaPath({
        sandbox: sandbox({ resolvePath }, true),
        mediaPath: "/remote/agent/secret.png",
      }),
    ).rejects.toThrow("Sandbox path escapes workspace root: /remote/agent/secret.png");
  });

  it("rewrites inbound media URIs before direct sandbox resolution", async () => {
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      hostPath: `${root}/${filePath}`,
      relativePath: filePath,
      containerPath: `/sandbox/${filePath}`,
    }));
    const stat = vi.fn<SandboxFsBridge["stat"]>(async () => ({
      type: "file",
      size: 1,
      mtimeMs: 1,
    }));

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: sandbox({ resolvePath, stat }),
      mediaPath: "media://inbound/photo.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(stat).toHaveBeenCalledWith({ filePath: "media/inbound/photo.png", cwd: root });
    expect(resolvePath).toHaveBeenCalledWith({ filePath: "media/inbound/photo.png", cwd: root });
    expect(resolved).toEqual({
      resolved: "/tmp/sandbox-root/media/inbound/photo.png",
      rewrittenFrom: "media://inbound/photo.png",
    });
  });

  it("rejects missing staged inbound media URIs before direct sandbox resolution", async () => {
    const resolvePath = vi.fn();
    await expect(
      resolveSandboxedBridgeMediaPath({
        sandbox: sandbox({ resolvePath, stat: vi.fn(async () => null) }),
        mediaPath: "media://inbound/missing.png",
        inboundFallbackDir: "media/inbound",
      }),
    ).rejects.toThrow("Sandbox media reference is not staged: media://inbound/missing.png");
    expect(resolvePath).not.toHaveBeenCalled();
  });
});

describe("sandbox media container file URLs", () => {
  let tempRoot = "";
  let workspace = "";
  let imagePath = "";
  let bridge: SandboxFsBridge;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-media-container-url-"));
    workspace = path.join(tempRoot, "workspace");
    imagePath = path.join(workspace, "image.png");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(imagePath, "image", "utf8");
    bridge = createSandboxFsBridge({
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
  });

  afterEach(() => fs.rm(tempRoot, { recursive: true, force: true }));

  it("reads a mounted file from a FILE: URL", async () => {
    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: workspace, bridge, workspaceOnly: true },
      mediaPath: "FILE:/workspace/image.png",
    });

    expect(resolved).toEqual({ resolved: imagePath });
    await expect(fs.readFile(resolved.resolved, "utf8")).resolves.toBe("image");
  });

  it("rejects an outside mounted file from a FILE: URL", async () => {
    await expect(
      resolveSandboxedBridgeMediaPath({
        sandbox: { root: workspace, bridge, workspaceOnly: true },
        mediaPath: "FILE:/outside/image.png",
      }),
    ).rejects.toThrow(/escapes sandbox root/i);
  });
});
