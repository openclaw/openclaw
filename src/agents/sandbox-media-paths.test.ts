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
});

describe("resolveSandboxedBridgeMediaPath media:// URIs", () => {
  it("resolves media://inbound URI via fallback dir instead of mangling through bridge", async () => {
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      relativePath: filePath,
      hostPath: `/host/${filePath}`,
      containerPath: `/sandbox/${filePath}`,
    }));
    const stat = vi.fn(async () => ({ type: "file" as const, size: 100, mtimeMs: 1 }));

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/workspace",
        bridge: { resolvePath, stat } as unknown as SandboxFsBridge,
      },
      mediaPath: "media://inbound/claim-check-test.png",
      inboundFallbackDir: "media/inbound",
    });

    // Should rewrite to fallback path and resolve through bridge
    expect(resolved.rewrittenFrom).toBe("media://inbound/claim-check-test.png");
    expect(resolved.resolved).toBe("/host/media/inbound/claim-check-test.png");
    // resolvePath should be called with the fallback path, not the raw URI
    expect(resolvePath).toHaveBeenCalledWith({
      filePath: "media/inbound/claim-check-test.png",
      cwd: "/workspace",
    });
  });

  it("returns raw media:// URI when inbound fallback stat fails", async () => {
    const resolvePath = vi.fn();
    const stat = vi.fn(async () => null);

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/workspace",
        bridge: { resolvePath, stat } as unknown as SandboxFsBridge,
      },
      mediaPath: "media://inbound/missing.png",
      inboundFallbackDir: "media/inbound",
    });

    // Should return the raw URI so loadWebMedia can resolve it
    expect(resolved.resolved).toBe("media://inbound/missing.png");
    expect(resolved.rewrittenFrom).toBeUndefined();
    // resolvePath should NOT have been called with the mangled URI
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it("returns raw media:// URI when no inbound fallback dir is provided", async () => {
    const resolvePath = vi.fn();

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/workspace",
        bridge: { resolvePath } as unknown as SandboxFsBridge,
      },
      mediaPath: "media://inbound/test.png",
    });

    expect(resolved.resolved).toBe("media://inbound/test.png");
    // Bridge resolvePath should never be called for media:// URIs
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it("does not intercept non-media:// paths", async () => {
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      relativePath: filePath,
      hostPath: `/host/${filePath}`,
      containerPath: `/sandbox/${filePath}`,
    }));

    const resolved = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/workspace",
        bridge: { resolvePath } as unknown as SandboxFsBridge,
      },
      mediaPath: "images/photo.png",
    });

    expect(resolved.resolved).toBe("/host/images/photo.png");
    // Normal paths still go through bridge resolution
    expect(resolvePath).toHaveBeenCalledWith({
      filePath: "images/photo.png",
      cwd: "/workspace",
    });
  });
});
