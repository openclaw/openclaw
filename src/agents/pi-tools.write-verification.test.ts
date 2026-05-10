import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wrapEditToolWithRecovery } from "./pi-tools.host-edit.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import {
  WriteVerificationError,
  isWriteVerificationError,
  verifyHostFile,
  verifyWrittenStat,
} from "./pi-tools.write-verification.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-verify-"));
  cleanupDirs.push(dir);
  return dir;
}

describe("verifyWrittenStat", () => {
  it("throws when stat is missing", () => {
    expect(() => verifyWrittenStat({ absolutePath: "/tmp/x", content: "abc", stat: null })).toThrow(
      WriteVerificationError,
    );
  });

  it("throws when path is not a file (sandbox stat shape)", () => {
    expect(() =>
      verifyWrittenStat({
        absolutePath: "/tmp/x",
        content: "abc",
        stat: { type: "directory", size: 0 },
      }),
    ).toThrow(/not a file/);
  });

  it("throws when size mismatches expected bytes", () => {
    expect(() =>
      verifyWrittenStat({
        absolutePath: "/tmp/x",
        content: "abc",
        stat: { type: "file", size: 2 },
      }),
    ).toThrow(/expected 3 bytes but file has 2 bytes/);
  });

  it("accepts matching size for sandbox stat shape", () => {
    expect(() =>
      verifyWrittenStat({
        absolutePath: "/tmp/x",
        content: "abc",
        stat: { type: "file", size: 3 },
      }),
    ).not.toThrow();
  });

  it("accepts matching size for fs.Stats shape", () => {
    const stat = { isFile: () => true, size: 3 } as const;
    expect(() => verifyWrittenStat({ absolutePath: "/tmp/x", content: "abc", stat })).not.toThrow();
  });
});

describe("verifyHostFile", () => {
  it("succeeds for a freshly written file", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "hello.txt");
    await fs.writeFile(file, "hello", "utf-8");
    await expect(verifyHostFile(file, "hello")).resolves.toBeUndefined();
  });

  it("throws WriteVerificationError when the file is missing", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "missing.txt");
    await expect(verifyHostFile(file, "x")).rejects.toBeInstanceOf(WriteVerificationError);
  });

  it("throws WriteVerificationError when bytes do not match", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "short.txt");
    await fs.writeFile(file, "ab", "utf-8");
    await expect(verifyHostFile(file, "abc")).rejects.toThrow(/expected 3 bytes but file has 2/);
  });
});

describe("wrapEditToolWithRecovery + WriteVerificationError", () => {
  it("rethrows WriteVerificationError instead of converting to success", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "target.txt");
    await fs.writeFile(filePath, "original", "utf-8");

    const verifierError = new WriteVerificationError(
      `Write verification failed: file does not exist after write (${filePath})`,
    );

    // Base "edit" tool that pretends to succeed at writing, but the post-write
    // verifier throws (e.g. bridge resolved while disk shows nothing/wrong size).
    const base: AnyAgentTool = {
      label: "edit",
      description: "test",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw verifierError;
      },
    } as unknown as AnyAgentTool;

    const wrapped = wrapEditToolWithRecovery(base, {
      root: dir,
      // Simulate the case the sweeper warned about: readback after the failed
      // write would suggest content changed (here we just return a different
      // string), which would normally let the recovery wrapper return success.
      readFile: async () => "totally different content",
    });

    await expect(
      wrapped.execute(
        "call-1",
        {
          path: filePath,
          edits: [{ oldText: "original", newText: "totally different content" }],
        },
        undefined,
      ),
    ).rejects.toBe(verifierError);
  });

  it("isWriteVerificationError detects subclass and tagged errors", () => {
    expect(isWriteVerificationError(new WriteVerificationError("x"))).toBe(true);
    expect(isWriteVerificationError(new Error("plain"))).toBe(false);
    const tagged = Object.assign(new Error("tagged"), { verifierFailure: true });
    expect(isWriteVerificationError(tagged)).toBe(true);
  });
});
