import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { handleDirFetch } from "./dir-fetch.js";
import { createCanonicalDirListCommand } from "./dir-list-worker-command.js";
import { handleDirList } from "./dir-list.js";
import { useFiles } from "./node-host.test-support.js";

const { at, dir: makeDir, file: makeFile, seed } = useFiles("dir-list-test-", vi.restoreAllMocks);

async function listingCommand(directoryPath: string, canonical = directoryPath) {
  const stats = await fs.stat(canonical, { bigint: true });
  return createCanonicalDirListCommand({
    directoryPath,
    expectedCanonicalPath: canonical,
    expectedDevice: String(stats.dev),
    expectedInode: String(stats.ino),
    maxEntries: 10,
    offset: 0,
  });
}

function spawnCommand(command: string[], prefix: string, event: "close" | "exit") {
  const child = spawn(command[0]!, [command[1]!, prefix + command[2]!, ...command.slice(3)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once(event, resolve);
  });
  return { child, stdout, stderr, exit };
}

async function list(input: Parameters<typeof handleDirList>[0]) {
  const result = await handleDirList(input);
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result;
}

function failure(code: string, message: string, canonicalPath?: string) {
  return { ok: false, code, message, ...(canonicalPath === undefined ? {} : { canonicalPath }) };
}

describe("handleDirList", () => {
  it("rejects empty / non-string path", async () => {
    expect(await handleDirList({ path: "" })).toMatchObject({ ok: false, code: "INVALID_PATH" });
    expect(await handleDirList({ path: undefined })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });
  it.each(["malformed", "write", "device", "inode"] as const)(
    "rejects a %s binding before reading the directory",
    async (kind) => {
      const stats = await fs.stat(at(), { bigint: true });
      const binding = { kind: "existing", device: String(stats.dev), inode: String(stats.ino) };
      const expectedBinding = {
        malformed: null,
        write: {
          kind: "write",
          anchorPath: at(),
          anchorDevice: binding.device,
          anchorInode: binding.inode,
        },
        device: { ...binding, device: "different" },
        inode: { ...binding, inode: "different" },
      }[kind];
      const readdir = vi.spyOn(fs, "readdir");

      await expect(
        handleDirList({ path: at(), preflightOnly: true, expectedBinding }),
      ).resolves.toEqual(
        failure(
          "CANONICAL_PATH_CHANGED",
          "filesystem identity differs from the authorized target",
          at(),
        ),
      );
      expect(readdir).not.toHaveBeenCalled();
    },
  );
  it("preserves path and directory errors before validating the binding", async () => {
    const missing = at("missing");
    await expect(handleDirList({ path: missing, expectedBinding: null })).resolves.toEqual(
      failure("NOT_FOUND", "path not found"),
    );
    const file = await makeFile("file.txt", "keep");
    await expect(handleDirList({ path: file, expectedBinding: null })).resolves.toEqual(
      failure("IS_FILE", "path is not a directory", file),
    );
    await expect(
      handleDirList({ path: file, expectedCanonicalPath: at(), expectedBinding: null }),
    ).resolves.toEqual(
      failure("CANONICAL_PATH_CHANGED", "resolved path differs from the authorized target", file),
    );
  });

  it.each([
    ["dir.list", handleDirList, "PERMISSION_DENIED"],
    ["dir.fetch", handleDirFetch, "READ_ERROR"],
  ] as const)(
    "retains %s's permission-error classification",
    async (_command, handle, permissionCode) => {
      vi.spyOn(fs, "stat").mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      );

      await expect(handle({ path: at(), expectedBinding: null })).resolves.toEqual(
        failure(permissionCode, "stat failed: Error: denied", at()),
      );
    },
  );
  it.runIf(process.platform === "linux")("keeps enumeration bound after retargeting", async () => {
    const approved = at("approved");
    const replacement = at("replacement");
    const current = at("current");
    await seed(["approved/approved.txt", "replacement/secret.txt"]);
    await fs.symlink(approved, current);
    const command = await listingCommand(current, approved);
    const drained = at("worker-drained");
    // Retarget after the real chdir, before the unchanged worker checks and
    // enumerates its bound directory. Polling /proc can miss the entire child.
    // beforeExit also distinguishes natural settlement from any forced-exit alias.
    const retargetAfterBinding = `(() => {
        const fs = require("node:fs");
        process.once("beforeExit", () => fs.writeFileSync(${JSON.stringify(drained)}, "settled"));
        const chdir = process.chdir;
        process.chdir = (directory) => {
          chdir(directory);
          process.chdir = chdir;
          fs.unlinkSync(${JSON.stringify(current)});
          fs.symlinkSync(${JSON.stringify(replacement)}, ${JSON.stringify(current)});
        };
      })();`;
    const { child, stdout, stderr, exit } = spawnCommand(command, retargetAfterBinding, "close");
    try {
      expect(await exit, Buffer.concat(stderr).toString("utf8")).toBe(0);
      expect(await fs.readFile(drained, "utf8")).toBe("settled");
      expect(await fs.readlink(current)).toBe(replacement);
      const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
        entries: Array<{ name: string }>;
      };
      expect(result.entries.some((entry) => entry.name === "approved.txt")).toBe(true);
      expect(result.entries.some((entry) => entry.name === "secret.txt")).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exit.catch(() => undefined);
    }
  });

  it.runIf(process.platform === "linux")(
    "rejects a same-path replacement before binding",
    async () => {
      const approved = at("approved");
      const moved = at("moved");
      await makeFile("approved/approved.txt");
      const command = await listingCommand(approved);
      await fs.rename(approved, moved);
      await fs.mkdir(approved);
      await makeFile("approved/secret.txt");

      const drained = at("rejected-worker-drained");
      const observeNaturalExit = `process.once("beforeExit", () => require("node:fs").writeFileSync(${JSON.stringify(drained)}, "settled"));`;
      const { stdout, exit } = spawnCommand(command, observeNaturalExit, "exit");
      expect(await exit).toBe(78);
      expect(await fs.readFile(drained, "utf8")).toBe("settled");
      expect(Buffer.concat(stdout)).toHaveLength(0);
    },
  );

  it("binds the canonical target before listing entries", async () => {
    await makeFile("private.txt", "secret");
    const stats = await fs.stat(at(), { bigint: true });
    const binding = { kind: "existing", device: String(stats.dev), inode: String(stats.ino) };

    const preflight = await handleDirList({
      path: at(),
      preflightOnly: true,
      expectedBinding: { ...binding, extra: "not part of the binding" },
    });
    expect(preflight).toEqual({
      ok: true,
      path: at(),
      entries: [],
      truncated: false,
      preflight: true,
      binding,
    });

    const changed = await handleDirList({ path: at(), expectedCanonicalPath: at("other") });
    expect(changed).toEqual(
      failure("CANONICAL_PATH_CHANGED", "resolved path differs from the authorized target", at()),
    );
  });

  it("lists files and subdirs with metadata, sorted by name", async () => {
    await seed([".hidden", "a.png"]);
    await makeDir("subdir");

    const r = await list({ path: at() });
    expect(r).toMatchObject({
      entries: [
        { name: ".hidden" },
        { name: "a.png", isDir: false, mimeType: "image/png" },
        { name: "subdir", isDir: true, size: 0, mimeType: "inode/directory" },
      ],
      truncated: false,
      nextPageToken: undefined,
    });
    expect(r.entries[1]!.size).toBeGreaterThan(0);
  });

  it.each([
    ["partial token", "1next", "f-0.txt", "1"],
    ["plus-signed token", "+01", "f-1.txt", "2"],
  ])("paginates a %s", async (_name, pageToken, entry, nextPageToken) => {
    await seed(["f-0.txt", "f-1.txt", "f-2.txt"]);

    const r = await list({ path: at(), maxEntries: 1, pageToken });
    expect(r.entries.map((e) => e.name)).toEqual([entry]);
    expect(r.nextPageToken).toBe(nextPageToken);
  });
});
