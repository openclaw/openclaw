import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyHostFile, writeAndVerifySandboxFile } from "./agent-tools.write-verification.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { WriteVerificationError } from "./sessions/tools/write-verification.js";

describe("agent-tools write verification", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("rejects same-size stale host content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-verify-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "stale content\n", "utf-8");

    await expect(verifyHostFile(filePath, "fresh content\n")).rejects.toThrow(
      WriteVerificationError,
    );
  });

  it("rejects same-size stale sandbox content after a delegated write resolves", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-verify-"));
    const filePath = path.join(tmpDir, "demo.txt");
    const content = "fresh content\n";
    const bridge: SandboxFsBridge = {
      resolvePath: ({ filePath: inputPath }) => ({
        hostPath: inputPath,
        relativePath: path.relative(tmpDir, inputPath),
        containerPath: inputPath,
      }),
      readFile: async () => Buffer.from("stale content\n"),
      writeFile: async () => {},
      mkdirp: async () => {},
      remove: async () => {},
      rename: async () => {},
      stat: async () => ({
        type: "file",
        size: Buffer.byteLength(content, "utf8"),
        mtimeMs: Date.now(),
      }),
    };

    await expect(
      writeAndVerifySandboxFile({
        bridge,
        root: tmpDir,
        absolutePath: filePath,
        content,
      }),
    ).rejects.toThrow(WriteVerificationError);
  });
});
