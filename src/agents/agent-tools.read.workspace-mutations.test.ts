import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import {
  afterFileRead,
  asSource,
  hostFileTools,
  interceptOpen,
} from "./agent-tools.mutation.test-support.js";
import {
  createHostWorkspaceWriteTool,
  wrapToolMemoryFlushAppendOnlyWrite,
} from "./agent-tools.read.js";
import { createApplyPatchTool } from "./apply-patch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

describe("workspace mutation authority", () => {
  it.each([
    [false, "write", "aborted"],
    [false, "edit", "revoked"],
    [false, "apply_patch", "budget-revoked"],
    [false, "apply_patch", "active"],
    [true, "write", "revoked"],
    [true, "edit", "aborted"],
    [true, "append", "active"],
    [true, "append", "revoked"],
    [true, "append", "aborted"],
  ] as const)(
    "checks workspaceOnly=%s %s authority=%s after asynchronous preparation",
    async (workspaceOnly, kind, authority) => {
      const root = tempDirs.make("openclaw-mutation-");
      const filePath = path.join(root, "memory.md");
      const original = "original content\n";
      await fs.writeFile(filePath, original);
      const generation = new AbortController();
      let current = true,
        budgetCurrent = true,
        prepared = false;
      const cancelled = workspaceOnly ? "Workspace operation cancelled" : "Permission change";
      const finishPreparation = () => {
        prepared = true;
        if (authority === "revoked") {
          current = false;
        } else if (authority === "aborted") {
          generation.abort(new Error(cancelled));
        } else if (authority === "budget-revoked") {
          budgetCurrent = false;
        }
      };
      if (!workspaceOnly || kind === "append") {
        afterFileRead(filePath, finishPreparation, kind === "append");
      } else {
        const targetPath = await fs.realpath(filePath);
        __setFsSafeTestHooksForTest({
          // Native staging handles do not pass through node:fs.
          beforePinnedWriteParentAdmission: async (preparedPath) => {
            if (preparedPath === targetPath) {
              await Promise.resolve();
              finishPreparation();
            }
          },
        });
      }
      const options = { workspaceOnly, abortSignal: generation.signal };
      const execute = () => {
        if (kind === "apply_patch") {
          return createApplyPatchTool({ cwd: root, ...options }).execute("permission-write", {
            input: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-original content\n+replacement content\n*** End Patch`,
          });
        }
        if (kind === "append") {
          return wrapToolMemoryFlushAppendOnlyWrite(createHostWorkspaceWriteTool(root, options), {
            root,
            relativePath: "memory.md",
          }).execute(
            "workspace-append",
            { path: "memory.md", content: "appended\n" },
            generation.signal,
          );
        }
        const tools = hostFileTools(root, options);
        return kind === "edit"
          ? tools.edit(filePath, "original", "replacement")
          : tools.write(filePath, "replacement content\n");
      };
      const run = () => asSource("mutation-authority", () => current, execute);
      // Only unrestricted-host cases exercise execution-budget authority.
      const pending = workspaceOnly
        ? run()
        : createAgentToolExecutionBudget({
            signal: generation.signal,
            abort: (error) => generation.abort(error),
            isCurrent: () => budgetCurrent,
          }).run(run);
      if (authority === "active") {
        await expect(pending).resolves.toBeDefined();
      } else {
        await expect(pending).rejects.toThrow(
          authority === "aborted"
            ? cancelled
            : authority === "budget-revoked"
              ? "execution scope is no longer active"
              : "authority is no longer active",
        );
      }
      expect(prepared).toBe(true);
      expect(generation.signal.aborted).toBe(
        authority === "aborted" || authority === "budget-revoked",
      );
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
        authority !== "active"
          ? original
          : kind === "append"
            ? original + "appended\n"
            : "replacement content\n",
      );
      await expect(fs.readdir(root)).resolves.toEqual(["memory.md"]);
    },
  );

  it.each(["existing", "missing"] as const)(
    "rechecks authority before creating directories in a %s workspace",
    async (workspace) => {
      const fixture = tempDirs.make("openclaw-workspace-mkdir-authority-");
      const root = workspace === "existing" ? fixture : path.join(fixture, "workspace");
      const firstDirectory = workspace === "existing" ? path.join(root, "nested") : root;
      let current = true;
      let prepared = false;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation: async (operation, targetPath) => {
          if (operation === "mkdir" && targetPath === firstDirectory) {
            await Promise.resolve();
            current = false;
            prepared = true;
          }
        },
      });
      const { write } = hostFileTools(root, { workspaceOnly: true });
      const pending = asSource(
        "workspace-mkdir",
        () => current,
        () => write("nested/file.txt", "new"),
      );

      await expect(pending).rejects.toThrow("authority is no longer active");
      expect(prepared).toBe(true);
      await expect(fs.access(firstDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("creates a missing workspace and writes and edits inside its literal tilde directory", async () => {
    const fixture = tempDirs.make("openclaw-workspace-tilde-");
    const root = path.join(fixture, "workspace");
    const filePath = path.join(root, "~", "file.txt");
    const options = { workspaceOnly: true };

    const tools = hostFileTools(root, options);
    await tools.write(filePath, "original");
    await tools.edit(filePath, "original", "replacement");

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
  });

  it.runIf(process.platform !== "win32")(
    "writes through a directory symlink whose target is the workspace root",
    async () => {
      const root = tempDirs.make("openclaw-workspace-root-link-");
      const alias = path.join(root, "self");
      await fs.symlink(root, alias, "dir");
      await hostFileTools(root, { workspaceOnly: true }).write("self/file.txt", "new");

      await expect(fs.readFile(path.join(root, "file.txt"), "utf8")).resolves.toBe("new");
      expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    },
  );
});

describe("host file paths", () => {
  it("writes and edits the same OS-home path despite OPENCLAW_HOME", async () => {
    const home = process.env.HOME ?? os.homedir();
    const directory = tempDirs.make("openclaw-host-home-", home);
    const openclawHome = tempDirs.make("openclaw-home-override-");
    const filePath = path.join(directory, "nested", "file.txt");
    const modelPath = path.join("~", path.relative(home, filePath));

    await withEnvAsync({ OPENCLAW_HOME: openclawHome }, async () => {
      const tools = hostFileTools(openclawHome);
      await tools.write(modelPath, "original");
      await tools.edit(modelPath, "original", "replacement");
      expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
      expect(await fs.readdir(openclawHome)).toEqual([]);
    });
  });

  it.runIf(process.platform !== "win32")("reports the workspace escape through edit", async () => {
    const fixture = tempDirs.make("openclaw-edit-escape-");
    const root = path.join(fixture, "workspace");
    const outside = path.join(fixture, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, path.join(root, "escape"));

    await expect(
      hostFileTools(root, { workspaceOnly: true }).edit("escape/secret.txt", "secret", "changed"),
    ).rejects.toThrow("Path escapes workspace root");
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });
});

describe("unrestricted host tool writes", () => {
  let tempDir = "";

  async function createFile(content: string) {
    tempDir = tempDirs.make("openclaw-host-write-");
    const filePath = path.join(tempDir, "important.txt");
    await fs.writeFile(filePath, content);
    return filePath;
  }

  function write(filePath: string, content: string) {
    return hostFileTools(tempDir).write(filePath, content);
  }

  function mutate(kind: "write" | "edit", filePath: string, content: string) {
    const tools = hostFileTools(tempDir);
    return kind === "write"
      ? tools.write(filePath, content)
      : tools.edit(filePath, "original", "replacement");
  }

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
