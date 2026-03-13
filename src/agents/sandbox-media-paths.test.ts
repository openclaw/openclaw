import path from "node:path";
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
});

describe("resolveSandboxedBridgeMediaPath", () => {
  it("normalizes Windows path separators for inbound fallback lookups", async () => {
    const fallbackDir = "/sandbox/inbound";
    const fallbackPath = path.join(fallbackDir, "voice-note.m4a");
    const resolvePath = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("missing");
      })
      .mockReturnValueOnce({ hostPath: "/host/inbound/voice-note.m4a" });
    const stat = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === fallbackPath ? { isFile: true } : null,
    );

    const result = await resolveSandboxedBridgeMediaPath({
      sandbox: {
        root: "/sandbox",
        bridge: {
          resolvePath,
          stat,
        } as unknown as SandboxFsBridge,
      },
      mediaPath: "..\\private\\voice-note.m4a",
      inboundFallbackDir: fallbackDir,
    });

    expect(stat).toHaveBeenCalledWith({
      filePath: fallbackPath,
      cwd: "/sandbox",
    });
    expect(result).toEqual({
      resolved: "/host/inbound/voice-note.m4a",
      rewrittenFrom: "..\\private\\voice-note.m4a",
    });
  });
});
