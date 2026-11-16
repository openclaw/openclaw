import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import {
  afterFileRead,
  asSource,
  hostFileTools,
  interceptOpen,
} from "./agent-tools.mutation.test-support.js";
import type { createHostWorkspaceWriteTool } from "./agent-tools.read.js";
import { createApplyPatchTool } from "./apply-patch.js";

describe("unrestricted host tool writes", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tempDir = "";
  afterEach(() => vi.restoreAllMocks());

  async function createFile(content: string) {
    tempDir = tempDirs.make("openclaw-host-write-");
    const filePath = path.join(tempDir, "important.txt");
    await fs.writeFile(filePath, content);
    return filePath;
  }

  function write(filePath: string, content: string) {
    return hostFileTools(tempDir).write(filePath, content);
  }

  function mutate(
    kind: "write" | "edit",
    filePath: string,
    content: string,
    options?: Parameters<typeof createHostWorkspaceWriteTool>[1],
  ) {
    const tools = hostFileTools(tempDir, options);
    return kind === "write"
      ? tools.write(filePath, content)
      : tools.edit(filePath, "original", "replacement");
  }

  it.each([
    { kind: "write", authority: "aborted" },
    { kind: "edit", authority: "revoked" },
    { kind: "apply_patch", authority: "budget-revoked" },
    { kind: "apply_patch", authority: "active" },
  ] as const)(
    "checks $authority authority for $kind after asynchronous file preparation",
    async ({ kind, authority }) => {
      const filePath = await createFile("original content\n");
      const generation = new AbortController();
      const originalClaim = {};
      let currentClaim: object | undefined = originalClaim;
      let budgetCurrent = true;
      const budget = createAgentToolExecutionBudget({
        signal: generation.signal,
        abort: (error) => generation.abort(error),
        isCurrent: () => budgetCurrent,
      });
      let prepared = false;
      afterFileRead(filePath, () => {
        prepared = true;
        if (authority === "aborted") {
          generation.abort(new Error("Permission change"));
        } else if (authority === "revoked") {
          currentClaim = undefined;
        } else if (authority === "budget-revoked") {
          budgetCurrent = false;
        }
      });
      const options = { workspaceOnly: false, abortSignal: generation.signal };
      const execute = () => {
        if (kind === "apply_patch") {
          return createApplyPatchTool({ cwd: tempDir, ...options }).execute("permission-write", {
            input: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-original content\n+replacement content\n*** End Patch`,
          });
        }
        return mutate(kind, filePath, "replacement content\n", options);
      };

      const pending = budget.run(() =>
        asSource("source-file-authority", () => currentClaim === originalClaim, execute),
      );
      if (authority === "active") {
        await expect(pending).resolves.toBeDefined();
      } else {
        await expect(pending).rejects.toThrow(
          authority === "aborted"
            ? "Permission change"
            : authority === "budget-revoked"
              ? "execution scope is no longer active"
              : "authority is no longer active",
        );
      }
      expect(prepared).toBe(true);
      expect(generation.signal.aborted).toBe(
        authority === "aborted" || authority === "budget-revoked",
      );
      expect(await fs.readFile(filePath, "utf8")).toBe(
        authority === "active" ? "replacement content\n" : "original content\n",
      );
    },
  );

  function failWrites(filePath: string, originalByteLength: number, prefix = false) {
    interceptOpen(filePath, (handle) => {
      const realWrite = handle.write.bind(handle);
      let failed = false;
      handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (prefix && !failed && position < originalByteLength) {
          failed = true;
          await realWrite(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        const result = await realWrite(buffer, offset, length, position);
        if (!prefix && position >= originalByteLength) {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        return result;
      }) as typeof handle.write;
    });
  }

  function failShrinkTruncate(filePath: string, originalByteLength: number) {
    interceptOpen(filePath, (handle) => {
      const realTruncate = handle.truncate.bind(handle);
      handle.truncate = (async (length: number) => {
        if (length < originalByteLength) {
          throw Object.assign(new Error("truncate failed"), { code: "EIO" });
        }
        return realTruncate(length);
      }) as typeof handle.truncate;
    });
  }

  function failTargetInspection(filePath: string) {
    const realMkdir = fs.mkdir.bind(fs);
    const realStat = fs.stat.bind(fs);
    let reachedWriter = false;
    vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      reachedWriter = true;
      return realMkdir(target, options as never);
    });
    vi.spyOn(fs, "stat").mockImplementation(async (target, options) => {
      if (reachedWriter && String(target) === filePath) {
        throw Object.assign(new Error("inspect failed"), { code: "EIO" });
      }
      return realStat(target, options as never);
    });
  }

  it.each([
    ["extension", "write", failWrites, "disk full"],
    ["prefix", "edit", (file: string, size: number) => failWrites(file, size, true), "disk full"],
    ["truncate", "write", failShrinkTruncate, "truncate failed"],
    ["inspection", "edit", failTargetInspection, "inspect failed"],
  ] as const)(
    "preserves the original after a %s failure through %s",
    async (failure, kind, inject, message) => {
      const original = `original\n${"important content\n".repeat(64)}`;
      const filePath = await createFile(original);
      inject(filePath, Buffer.byteLength(original));
      const fallback = vi.spyOn(fs, "writeFile");
      const pending = mutate(
        kind,
        filePath,
        failure === "truncate" ? "short\n" : "replacement content\n".repeat(64),
      );
      await expect(pending).rejects.toMatchObject({
        message,
        code: failure === "extension" || failure === "prefix" ? "ENOSPC" : "EIO",
      });
      expect(fallback).not.toHaveBeenCalled();
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(original);
      await expect(fs.readdir(tempDir)).resolves.toEqual(["important.txt"]);
    },
  );

  it("writes empty content", async () => {
    const filePath = await createFile("replace me\n");
    await write(filePath, "");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("");
  });

  it.runIf(process.platform !== "win32")("writes through an existing symlink", async () => {
    const targetPath = await createFile("original");
    const linkPath = path.join(tempDir, "linked.txt");
    await fs.symlink(targetPath, linkPath);

    await write(linkPath, "replacement");

    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("replacement");
  });

  const asUnprivilegedUser = process.platform !== "win32" && process.getuid?.() !== 0;

  it.runIf(asUnprivilegedUser)("rejects an unreadable existing file", async () => {
    const originalContent = "original\n";
    const filePath = await createFile(originalContent);
    await fs.chmod(filePath, 0o222);

    await expect(write(filePath, "replacement")).rejects.toMatchObject({ code: "EACCES" });

    await fs.chmod(filePath, 0o644);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
  });

  it.runIf(process.platform !== "win32")("updates a hard-linked existing file", async () => {
    const filePath = await createFile("original");
    await fs.chmod(filePath, 0o640);
    const content = "héllo crab 🦀 héllo\n";
    const aliasPath = path.join(tempDir, "alias.txt");
    await fs.link(filePath, aliasPath);
    const { ino, dev, uid, gid } = await fs.stat(filePath);

    await write(filePath, content);

    const after = await fs.stat(filePath);
    expect(after).toMatchObject({ ino, nlink: 2, dev, uid, gid });
    expect(after.mode & 0o777).toBe(0o640);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);
    await expect(fs.readFile(aliasPath, "utf8")).resolves.toBe(content);
  });

  it.runIf(process.platform !== "win32")("falls back to a fifo without opening it", async () => {
    await createFile("original");
    const fifoPath = path.join(tempDir, "pipe");
    execFileSync("mkfifo", [fifoPath]);
    const fifoOpenFlags: string[] = [];
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      if (String(target) === fifoPath) {
        fifoOpenFlags.push(String(flags));
      }
      return realOpen(target, flags as never, mode as never);
    });
    const fallback = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    await write(fifoPath, "replacement").catch(() => undefined);

    expect(fallback).toHaveBeenCalledWith(fifoPath, "replacement", "utf-8");
    expect(fifoOpenFlags).toEqual([]);
  });
});
