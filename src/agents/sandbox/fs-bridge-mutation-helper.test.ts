// Pinned mutation helper tests cover the native helper that performs sandbox
// filesystem mutations through directory file descriptors.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GUEST_FILESYSTEM_CREATE_EXISTS_EXIT_CODE,
  GUEST_FILESYSTEM_PYTHON,
} from "@openclaw/fs-safe/guest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let workspace: string;
beforeEach(async () => {
  root = tempDirs.make("openclaw-mutation-helper-");
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
});

function runMutation(args: string[], input?: string) {
  return runMutationWithSource(GUEST_FILESYSTEM_PYTHON, args, input);
}

function runMutationWithSource(source: string, args: string[], input?: string) {
  return spawnSync("python3", ["-c", source, ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function expectPathMissing(targetPath: string) {
  const access = fs.access(targetPath);
  await expect(access).rejects.toBeInstanceOf(Error);
  await expect(access).rejects.toMatchObject({ code: "ENOENT" });
}
async function expectFile(filePath: string, content: string) {
  await expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);
}

const crossDeviceScript = GUEST_FILESYSTEM_PYTHON.replace(
  "        os.rename(src_basename, dst_basename, src_dir_fd=src_parent_fd, dst_dir_fd=dst_parent_fd)",
  "        raise OSError(errno.EXDEV, 'forced EXDEV for test')\n        os.rename(src_basename, dst_basename, src_dir_fd=src_parent_fd, dst_dir_fd=dst_parent_fd)",
);

const failedCopyScript = GUEST_FILESYSTEM_PYTHON.replace(
  "        copy_completed = True",
  "        raise OSError(errno.ENOSPC, 'forced copy failure')\n        copy_completed = True",
);

const fifoWatchdogScript = GUEST_FILESYSTEM_PYTHON.replace(
  "def read_file(parent_fd, basename, max_bytes=None):",
  "def read_file(parent_fd, basename, max_bytes=None):\n    import signal\n    signal.alarm(1)",
);

const failedCreateScript = GUEST_FILESYSTEM_PYTHON.replace(
  "        # exclusive create payload is durable before publication",
  "        raise OSError(errno.ENOSPC, 'forced create failure')\n        # exclusive create payload is durable before publication",
);

function injectCreatePublicationRace(lines: string[]): string {
  const publication = "        rename_no_replace(staging_fd, temp_name, parent_fd, basename)";
  // A changed guest fragment must fail loudly instead of silently dropping the race.
  expect(GUEST_FILESYSTEM_PYTHON).toContain(publication);
  return GUEST_FILESYSTEM_PYTHON.replace(publication, [...lines, publication].join("\n"));
}

const racedDestinationScript = injectCreatePublicationRace([
  "        replacement_fd = os.open(basename, WRITE_FLAGS, 0o600, dir_fd=parent_fd)",
  "        try:",
  "            os.write(replacement_fd, b'replacement')",
  "        finally:",
  "            os.close(replacement_fd)",
]);

const substitutedStageScript = injectCreatePublicationRace([
  "        os.unlink(temp_name, dir_fd=staging_fd)",
  "        replacement_fd = os.open(temp_name, WRITE_FLAGS, 0o600, dir_fd=staging_fd)",
  "        try:",
  "            os.write(replacement_fd, b'replacement')",
  "        finally:",
  "            os.close(replacement_fd)",
]);

const missingRenameScript = GUEST_FILESYSTEM_PYTHON.replace(
  "    is_linux = sys.platform.startswith('linux')",
  "    is_linux = True",
).replace("        rename_fn = getattr(libc, 'renameat2', None)", "        rename_fn = None");

const unsupportedRenameScript = GUEST_FILESYSTEM_PYTHON.replace(
  "    is_linux = sys.platform.startswith('linux')",
  "    is_linux = True",
).replace(
  "        rename_fn = getattr(libc, 'renameat2', None)",
  [
    "        class UnsupportedRename:",
    "            argtypes = None",
    "            restype = None",
    "            def __call__(self, *_args):",
    "                ctypes.set_errno(errno.ENOSYS)",
    "                return -1",
    "        rename_fn = UnsupportedRename()",
  ].join("\n"),
);

const failedStageOpenScript = GUEST_FILESYSTEM_PYTHON.replace(
  "            staging_fd = open_dir(candidate, dir_fd=parent_fd)",
  "            raise OSError(errno.EMFILE, 'forced staging open failure')\n            staging_fd = open_dir(candidate, dir_fd=parent_fd)",
);

const lateSourceScript = crossDeviceScript.replace(
  "        remove_copied_entry(src_parent_fd, src_basename, ('dir', entry_identity(src_stat), copied_children))",
  [
    "        late_parent_fd = open_dir(src_basename, dir_fd=src_parent_fd)",
    "        late_fd = None",
    "        try:",
    "            late_fd = os.open('late.txt', WRITE_FLAGS, 0o600, dir_fd=late_parent_fd)",
    "            os.write(late_fd, b'late')",
    "        finally:",
    "            if late_fd is not None:",
    "                os.close(late_fd)",
    "            os.close(late_parent_fd)",
    "        remove_copied_entry(src_parent_fd, src_basename, ('dir', entry_identity(src_stat), copied_children))",
  ].join("\n"),
);

const replacedSourceScript = crossDeviceScript.replace(
  "        remove_copied_entry(src_parent_fd, src_basename, ('dir', entry_identity(src_stat), copied_children))",
  [
    "        replacement_parent_fd = open_dir(src_basename, dir_fd=src_parent_fd)",
    "        replacement_dir_fd = None",
    "        replacement_fd = None",
    "        try:",
    "            replacement_dir_fd = open_dir('nested', dir_fd=replacement_parent_fd)",
    "            os.unlink('file.txt', dir_fd=replacement_dir_fd)",
    "            replacement_fd = os.open('file.txt', WRITE_FLAGS, 0o600, dir_fd=replacement_dir_fd)",
    "            os.write(replacement_fd, b'replacement')",
    "        finally:",
    "            if replacement_fd is not None:",
    "                os.close(replacement_fd)",
    "            if replacement_dir_fd is not None:",
    "                os.close(replacement_dir_fd)",
    "            os.close(replacement_parent_fd)",
    "        remove_copied_entry(src_parent_fd, src_basename, ('dir', entry_identity(src_stat), copied_children))",
  ].join("\n"),
);

async function directoryMoveFixture() {
  const sourceRoot = path.join(root, "source");
  const destRoot = path.join(root, "dest");
  await fs.mkdir(path.join(sourceRoot, "dir", "nested"), { recursive: true });
  await fs.mkdir(destRoot);
  await fs.writeFile(path.join(sourceRoot, "dir", "nested", "file.txt"), "payload", "utf8");
  const move = (source = crossDeviceScript) =>
    runMutationWithSource(source, ["rename", sourceRoot, "", "dir", destRoot, "", "moved", "1"]);
  return { sourceRoot, destRoot, move };
}

describe("sandbox pinned mutation helper", () => {
  it("creates near-limit basenames", async () => {
    const basename = "n".repeat(240);
    const result = runMutation(["create", workspace, "", basename, "0"], "hello");
    expect(result.status).toBe(0);
    await expectFile(path.join(workspace, basename), "hello");
  });

  it.each([
    ["missing", missingRenameScript],
    ["unsupported", unsupportedRenameScript],
  ])("falls back when renameat2 is %s", async (_reason, source) => {
    const result = runMutationWithSource(
      source,
      ["create", workspace, "", "note.txt", "0"],
      "hello",
    );
    expect(result.status).toBe(0);
    await expectFile(path.join(workspace, "note.txt"), "hello");
    await expect(fs.readdir(workspace)).resolves.toStrictEqual(["note.txt"]);
  });

  it.each([
    ["staging open", failedStageOpenScript, "forced staging open failure"],
    ["payload write", failedCreateScript, "forced create failure"],
  ])("cleans private staging after %s fails", async (_phase, source, message) => {
    const result = runMutationWithSource(
      source,
      ["create", workspace, "", "note.txt", "0"],
      "partial",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    await expectPathMissing(path.join(workspace, "note.txt"));
    await expect(fs.readdir(workspace)).resolves.toStrictEqual([]);
  });

  it.each([
    {
      name: "preserves a destination raced into a staged exclusive create",
      source: racedDestinationScript,
      input: "partial",
      error: undefined,
    },
    {
      name: "fails when the staged exclusive-create pathname is substituted",
      source: substitutedStageScript,
      input: "expected",
      error: "exclusive publication source changed",
    },
  ])("$name", async ({ source, input, error }) => {
    const result = runMutationWithSource(source, ["create", workspace, "", "note.txt", "0"], input);
    if (error) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(error);
    } else {
      expect(result.status).toBe(GUEST_FILESYSTEM_CREATE_EXISTS_EXIT_CODE);
    }
    await expectFile(path.join(workspace, "note.txt"), "replacement");
    await expect(fs.readdir(workspace)).resolves.toStrictEqual(["note.txt"]);
  });

  describe.runIf(process.platform !== "win32")("POSIX descriptors", () => {
    it.each([0o644, 0o600])("preserves existing write permissions %i", async (mode) => {
      const filePath = path.join(workspace, "note.txt");
      await fs.writeFile(filePath, "before", "utf8");
      await fs.chmod(filePath, mode);
      expect(runMutation(["write", workspace, "", "note.txt", "0"], "after").status).toBe(0);
      await expectFile(filePath, "after");
      expect((await fs.stat(filePath)).mode & 0o777).toBe(mode);
    });

    it("rejects hardlinked read sources", async () => {
      await fs.writeFile(path.join(workspace, "read.txt"), "hello");
      await fs.link(path.join(workspace, "read.txt"), path.join(workspace, "hardlinked.txt"));
      const result = runMutation(["read", workspace, "", "hardlinked.txt"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/hardlinked file/i);
    });

    it("rejects growth on the opened read descriptor", async () => {
      await fs.writeFile(path.join(workspace, "growing.txt"), "hello", "utf8");
      const oversized = runMutation(["read", workspace, "", "growing.txt", "4"]);
      expect(oversized.status).not.toBe(0);
      expect(oversized.stdout).toBe("");
      expect(oversized.stderr).toMatch(/bounded read limit/i);
      const growingSource = GUEST_FILESYSTEM_PYTHON.replace(
        "        if max_bytes is not None and file_stat.st_size > max_bytes:",
        [
          "        if basename == 'growing.txt':",
          "            growth_fd = os.open(basename, os.O_WRONLY | os.O_APPEND, dir_fd=parent_fd)",
          "            try:",
          "                write_all(growth_fd, b'!')",
          "            finally:",
          "                os.close(growth_fd)",
          "        if max_bytes is not None and file_stat.st_size > max_bytes:",
        ].join("\n"),
      );
      const grown = runMutationWithSource(growingSource, [
        "read",
        workspace,
        "",
        "growing.txt",
        "5",
      ]);
      expect(grown.status).not.toBe(0);
      expect(grown.stdout).toBe("");
      expect(grown.stderr).toMatch(/bounded read limit/i);
    });

    it("copies atomically with source permissions", async () => {
      const sourceRoot = path.join(root, "source");
      const destinationRoot = path.join(root, "destination");
      const sourcePath = path.join(sourceRoot, "payload.bin");
      const destinationName = `${"d".repeat(235)}.bin`;
      const destinationPath = path.join(destinationRoot, "nested", destinationName);
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.writeFile(sourcePath, "streamed", "utf8");
      await fs.chmod(sourcePath, 0o640);
      await fs.writeFile(destinationPath, "old", "utf8");
      const copyResult = runMutation([
        "copy",
        sourceRoot,
        "",
        "payload.bin",
        destinationRoot,
        "nested",
        destinationName,
        "1",
      ]);
      expect(copyResult.status).toBe(0);
      await expectFile(destinationPath, "streamed");
      expect((await fs.stat(destinationPath)).mode & 0o777).toBe(0o640);
    });

    it("cleans partial copies on failure", async () => {
      const sourceRoot = path.join(root, "source");
      const destinationRoot = path.join(root, "destination");
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.mkdir(destinationRoot, { recursive: true });
      await fs.writeFile(path.join(sourceRoot, "payload.bin"), "streamed", "utf8");
      const result = runMutationWithSource(failedCopyScript, [
        "copy",
        sourceRoot,
        "",
        "payload.bin",
        destinationRoot,
        "",
        "payload.bin",
        "1",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("forced copy failure");
      await expectPathMissing(path.join(destinationRoot, "payload.bin"));
      await expect(fs.readdir(destinationRoot)).resolves.toEqual([]);
    });

    it("rejects FIFO reads without blocking", async () => {
      const fifoPath = path.join(workspace, "live.pipe");
      expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);
      expect(fifoWatchdogScript).not.toBe(GUEST_FILESYSTEM_PYTHON);
      const result = spawnSync(
        "python3",
        ["-c", fifoWatchdogScript, "read", workspace, "", "live.pipe"],
        {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          // Bound startup and cleanup separately from the one-second read watchdog.
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/only regular files are allowed/i);
    });

    it.each(["write", "mkdirp", "rename"] as const)(
      "rejects symlink parents during %s",
      async (operation) => {
        const outside = path.join(root, "outside");
        await fs.mkdir(outside);
        await fs.symlink(outside, path.join(workspace, "alias"));
        await fs.writeFile(path.join(workspace, "from.txt"), "payload");
        const args =
          operation === "write"
            ? ["write", workspace, "alias", "escape.txt", "0"]
            : operation === "mkdirp"
              ? ["mkdirp", workspace, "alias/nested"]
              : ["rename", workspace, "", "from.txt", workspace, "alias", "escape.txt", "1"];
        expect(runMutation(args, "owned").status).not.toBe(0);
        await expectPathMissing(
          path.join(outside, operation === "mkdirp" ? "nested" : "escape.txt"),
        );
        await expectFile(path.join(workspace, "from.txt"), "payload");
      },
    );

    it("moves directories across mount roots", async () => {
      const { sourceRoot, destRoot, move } = await directoryMoveFixture();
      const result = move();
      expect(result.status).toBe(0);
      await expectFile(path.join(destRoot, "moved", "nested", "file.txt"), "payload");
      await expectPathMissing(path.join(sourceRoot, "dir"));
    });

    it("rejects hardlinks during cross-device moves", async () => {
      const sourceRoot = path.join(root, "source");
      const destRoot = path.join(root, "dest");
      const outsideRoot = path.join(root, "outside");
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.mkdir(destRoot, { recursive: true });
      await fs.mkdir(outsideRoot, { recursive: true });
      await fs.writeFile(path.join(outsideRoot, "secret.txt"), "classified", "utf8");
      await fs.link(path.join(outsideRoot, "secret.txt"), path.join(sourceRoot, "linked.txt"));
      const result = runMutationWithSource(crossDeviceScript, [
        "rename",
        sourceRoot,
        "",
        "linked.txt",
        destRoot,
        "",
        "copied.txt",
        "1",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/hardlinked file/i);
      await expectPathMissing(path.join(destRoot, "copied.txt"));
      await expectFile(path.join(outsideRoot, "secret.txt"), "classified");
    });

    it("preserves sources and cleans failed directory moves", async () => {
      // EXDEV fallback copies first and removes only after validation; failures
      // must not delete or partially replace the source tree.
      const { sourceRoot, destRoot, move } = await directoryMoveFixture();
      const outsideRoot = path.join(root, "outside");
      await fs.mkdir(outsideRoot, { recursive: true });
      await fs.writeFile(path.join(outsideRoot, "secret.txt"), "classified", "utf8");
      await fs.link(
        path.join(outsideRoot, "secret.txt"),
        path.join(sourceRoot, "dir", "nested", "linked.txt"),
      );
      const result = move();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/hardlinked file/i);
      await expectFile(path.join(sourceRoot, "dir", "nested", "file.txt"), "payload");
      await expectFile(path.join(sourceRoot, "dir", "nested", "linked.txt"), "classified");
      await expectPathMissing(path.join(destRoot, "moved"));
      await expect(fs.readdir(destRoot)).resolves.toStrictEqual([]);
    });

    it.each([
      {
        name: "preserves source entries created after the directory rename fallback copy phase",
        source: lateSourceScript,
        sourceFiles: [
          ["late.txt", "late"],
          ["nested/file.txt", "payload"],
        ],
        stderr: null,
      },
      {
        name: "preserves source entries replaced after the directory rename fallback copy phase",
        source: replacedSourceScript,
        sourceFiles: [["nested/file.txt", "replacement"]],
        stderr: /source changed during move fallback cleanup/i,
      },
    ] as const)("$name", async ({ source, sourceFiles, stderr }) => {
      const { sourceRoot, destRoot, move } = await directoryMoveFixture();
      const result = move(source);
      expect(result.status).not.toBe(0);
      if (stderr) {
        expect(result.stderr).toMatch(stderr);
      }
      await expectFile(path.join(destRoot, "moved", "nested", "file.txt"), "payload");
      for (const [relativePath, expected] of sourceFiles) {
        await expectFile(path.join(sourceRoot, "dir", relativePath), expected);
      }
    });
  });
});
