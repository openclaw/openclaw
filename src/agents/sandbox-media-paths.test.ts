import { describe, expect, it, vi } from "vitest";
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

  it("rewrites media store refs through the inbound sandbox fallback", async () => {
    const stat = vi.fn(async () => ({ type: "file", size: 1, mtimeMs: 1 }));
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      relativePath: filePath,
      containerPath: `/sandbox/${filePath}`,
    }));

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/tmp/sandbox-root",
        bridge: { resolvePath, stat } as unknown as SandboxFsBridge,
      },
      mediaPath: "media://inbound/photo%20one.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({
      resolved: "/sandbox/media/inbound/photo one.png",
      rewrittenFrom: "media://inbound/photo%20one.png",
    });
    expect(stat).toHaveBeenCalledWith({
      filePath: "media/inbound/photo one.png",
      cwd: "/tmp/sandbox-root",
    });
    expect(resolvePath).toHaveBeenCalledWith({
      filePath: "media/inbound/photo one.png",
      cwd: "/tmp/sandbox-root",
    });
  });

  it("does not rewrite media store refs with nested decoded paths", async () => {
    const stat = vi.fn(async () => ({ type: "file", size: 1, mtimeMs: 1 }));
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      relativePath: filePath,
      containerPath: `/sandbox/${filePath}`,
    }));

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/tmp/sandbox-root",
        bridge: { resolvePath, stat } as unknown as SandboxFsBridge,
      },
      mediaPath: "media://inbound/nested%2Fsecret.png",
      inboundFallbackDir: "media/inbound",
    });

    expect(resolved).toEqual({ resolved: "/sandbox/media://inbound/nested%2Fsecret.png" });
    expect(stat).not.toHaveBeenCalled();
    expect(resolvePath).toHaveBeenCalledWith({
      filePath: "media://inbound/nested%2Fsecret.png",
      cwd: "/tmp/sandbox-root",
    });
  });
});
