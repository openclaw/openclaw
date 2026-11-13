// Guest branch coverage belongs to fs-safe's guest-filesystem, boundary,
// publication, and recovery suites. Keep OpenClaw launcher composition and
// the unmatched fault-injection regressions here.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { GUEST_FILESYSTEM_PYTHON } from "@openclaw/fs-safe/guest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildPinnedMutationPlan } from "./fs-bridge-mutation-helper.js";

function runMutationWithSource(source: string, args: string[], input?: string) {
  return spawnSync("python3", ["-c", source, ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runWritePlan(args: string[], input?: string) {
  const plan = buildPinnedMutationPlan({
    kind: "write",
    target: {
      hostPath: args[1] ?? "",
      containerPath: args[1] ?? "",
      relativePath: path.posix.join(args[2] ?? "", args[3] ?? ""),
      writable: true,
    },
    pinned: {
      mountRootPath: args[1] ?? "",
      relativeParentPath: args[2] ?? "",
      basename: args[3] ?? "",
    },
    mkdir: args[4] === "1",
  });

  return spawnSync("/bin/sh", ["-c", plan.script, "openclaw-sandbox-fs", ...(plan.args ?? [])], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function expectPathMissing(targetPath: string): Promise<void> {
  const err = await fs.access(targetPath).catch((caught: unknown) => caught);
  expect(err).toBeInstanceOf(Error);
  expect(err).toMatchObject({ code: "ENOENT" });
}

const expectFile = (filePath: string, content: string) =>
  expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);

const FORCED_EXDEV_MUTATION_PYTHON = GUEST_FILESYSTEM_PYTHON.replace(
  "        os.rename(src_basename, dst_basename, src_dir_fd=src_parent_fd, dst_dir_fd=dst_parent_fd)",
  "        raise OSError(errno.EXDEV, 'forced EXDEV for test')\n        os.rename(src_basename, dst_basename, src_dir_fd=src_parent_fd, dst_dir_fd=dst_parent_fd)",
);

const FORCED_COPY_FAILURE_MUTATION_PYTHON = GUEST_FILESYSTEM_PYTHON.replace(
  "        copy_completed = True",
  "        raise OSError(errno.ENOSPC, 'forced copy failure')\n        copy_completed = True",
);

function injectCreatePublicationRace(lines: string[]): string {
  const publication = "        rename_no_replace(staging_fd, temp_name, parent_fd, basename)";
  // A changed guest fragment must fail loudly instead of silently dropping the race.
  expect(GUEST_FILESYSTEM_PYTHON).toContain(publication);
  return GUEST_FILESYSTEM_PYTHON.replace(publication, [...lines, publication].join("\n"));
}

const FORCED_CREATE_TEMP_SUBSTITUTION_MUTATION_PYTHON = injectCreatePublicationRace([
  "        original_fd = os.open(temp_name, os.O_RDONLY, dir_fd=staging_fd)",
  "        try:",
  "            os.unlink(temp_name, dir_fd=staging_fd)",
  "            replacement_fd = os.open(temp_name, WRITE_FLAGS, 0o600, dir_fd=staging_fd)",
  "        finally:",
  "            os.close(original_fd)",
  "        try:",
  "            os.write(replacement_fd, b'replacement')",
  "        finally:",
  "            os.close(replacement_fd)",
]);

describe("sandbox pinned mutation helper", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-mutation-helper-");
    workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
  });

  const create = (source: string, input = "hello") =>
    runMutationWithSource(source, ["create", workspace, "", "note.txt", "0"], input);

  it("fails when the staged exclusive-create pathname is substituted", async () => {
    const filePath = path.join(workspace, "note.txt");

    const result = create(FORCED_CREATE_TEMP_SUBSTITUTION_MUTATION_PYTHON, "expected");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exclusive publication source changed");
    await expectFile(filePath, "replacement");
    await expect(fs.readdir(workspace)).resolves.toStrictEqual(["note.txt"]);
  });

  describe.runIf(process.platform !== "win32")("POSIX operations", () => {
    it("copies atomically over a long destination basename and preserves source mode", async () => {
      const name = `${"d".repeat(235)}.bin`;
      const destination = path.join(root, "destination");
      const target = path.join(destination, "nested", name);
      const source = path.join(workspace, "payload.bin");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(source, "streamed", "utf8");
      await fs.chmod(source, 0o640);
      await fs.writeFile(target, "old", "utf8");
      const result = runMutationWithSource(GUEST_FILESYSTEM_PYTHON, [
        "copy",
        workspace,
        "",
        "payload.bin",
        destination,
        "nested",
        name,
        "1",
      ]);
      expect(result.status).toBe(0);
      await expectFile(target, "streamed");
      expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    });

    it("removes a partial temporary file when streaming copy fails", async () => {
      const destinationRoot = path.join(root, "destination");
      await fs.mkdir(destinationRoot, { recursive: true });
      await fs.writeFile(path.join(workspace, "payload.bin"), "streamed", "utf8");

      const result = runMutationWithSource(FORCED_COPY_FAILURE_MUTATION_PYTHON, [
        "copy",
        workspace,
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

    it("preserves stdin payload bytes when the pinned write plan runs through sh", async () => {
      const result = runWritePlan(["write", workspace, "nested/deeper", "note.txt", "1"], "hello");

      expect(result.status).toBe(0);
      await expectFile(path.join(workspace, "nested", "deeper", "note.txt"), "hello");
    });

    it("rejects hardlinked files during rename EXDEV fallback", async () => {
      const destRoot = path.join(root, "dest");
      const outsideRoot = path.join(root, "outside");
      await fs.mkdir(destRoot, { recursive: true });
      await fs.mkdir(outsideRoot, { recursive: true });
      await fs.writeFile(path.join(outsideRoot, "secret.txt"), "classified", "utf8");
      await fs.link(path.join(outsideRoot, "secret.txt"), path.join(workspace, "linked.txt"));

      const result = runMutationWithSource(FORCED_EXDEV_MUTATION_PYTHON, [
        "rename",
        workspace,
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
  });
});
