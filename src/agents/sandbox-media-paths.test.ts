import { describe, expect, it, vi } from "vitest";
import { createSandboxBridgeReadFile } from "./sandbox-media-paths.js";
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
