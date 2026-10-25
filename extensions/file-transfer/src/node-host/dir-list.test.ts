import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { assert, describe, expect, it, vi } from "vitest";
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

async function runWorker(command: string[], preload = "", code = 0) {
  const preloadPath = at("worker-preload.cjs");
  const drained = at("worker-drained");
  await fs.writeFile(
    preloadPath,
    `${preload}\nprocess.once("beforeExit", () => require("node:fs").writeFileSync(${JSON.stringify(drained)}, "settled"));`,
  );
  const result = await new Promise<{ code: string | number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        command[0]!,
        ["--require", preloadPath, ...command.slice(1)],
        (error, stdout, stderr) => {
          resolve({ code: error?.code ?? 0, stdout, stderr });
        },
      );
    },
  );
  expect(result.code, result.stderr).toBe(code);
  expect(await fs.readFile(drained, "utf8")).toBe("settled");
  return result.stdout;
}

async function list(input: Parameters<typeof handleDirList>[0]) {
  const result = await handleDirList(input);
  assert(result.ok);
  return result;
}

async function expectFailure(
  input: Parameters<typeof handleDirList>[0],
  code: string,
  canonicalPath?: string,
) {
  await expect(handleDirList(input)).resolves.toMatchObject({
    ok: false,
    code,
    ...(canonicalPath === undefined ? {} : { canonicalPath }),
  });
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
      const expectedBinding =
        kind === "malformed"
          ? null
          : kind === "write"
            ? { kind, anchorPath: at(), anchorDevice: binding.device, anchorInode: binding.inode }
            : { ...binding, [kind]: "different" };
      const readdir = vi.spyOn(fs, "readdir");

      await expectFailure(
        { path: at(), preflightOnly: true, expectedBinding },
        "CANONICAL_PATH_CHANGED",
        at(),
      );
      expect(readdir).not.toHaveBeenCalled();
    },
  );
  it("preserves path and directory errors before validating the binding", async () => {
    await expectFailure({ path: at("missing"), expectedBinding: null }, "NOT_FOUND");
    const file = await makeFile("file.txt", "keep");
    await expectFailure({ path: file, expectedBinding: null }, "IS_FILE", file);
    await expectFailure(
      { path: file, expectedCanonicalPath: at(), expectedBinding: null },
      "CANONICAL_PATH_CHANGED",
      file,
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

      await expect(handle({ path: at(), expectedBinding: null })).resolves.toMatchObject({
        ok: false,
        code: permissionCode,
        canonicalPath: at(),
      });
    },
  );
  it.runIf(process.platform === "linux")("keeps enumeration bound after retargeting", async () => {
    const approved = at("approved");
    const replacement = at("replacement");
    const current = at("current");
    await seed(["approved/approved.txt", "replacement/secret.txt"]);
    await fs.symlink(approved, current);
    const command = await listingCommand(current, approved);
    // Retarget after the real chdir, before the unchanged worker checks and
    // enumerates its bound directory. Polling /proc can miss the entire child.
    // beforeExit also distinguishes natural settlement from any forced-exit alias.
    const retargetAfterBinding = `(() => {
        const fs = require("node:fs");
        const chdir = process.chdir;
        process.chdir = (directory) => {
          chdir(directory);
          process.chdir = chdir;
          fs.unlinkSync(${JSON.stringify(current)});
          fs.symlinkSync(${JSON.stringify(replacement)}, ${JSON.stringify(current)});
        };
      })();`;
    const stdout = await runWorker(command, retargetAfterBinding);
    expect(await fs.readlink(current)).toBe(replacement);
    const result = JSON.parse(stdout) as { entries: Array<{ name: string }> };
    expect(result.entries.some((entry) => entry.name === "approved.txt")).toBe(true);
    expect(result.entries.some((entry) => entry.name === "secret.txt")).toBe(false);
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

      expect(await runWorker(command, "", 78)).toHaveLength(0);
    },
  );

  it("binds the canonical target before listing entries", async () => {
    await makeFile("private.txt", "secret");
    const stats = await fs.stat(at(), { bigint: true });
    const binding = { kind: "existing", device: String(stats.dev), inode: String(stats.ino) };

    expect(
      await handleDirList({
        path: at(),
        preflightOnly: true,
        expectedBinding: { ...binding, extra: "not part of the binding" },
      }),
    ).toEqual({
      ok: true,
      path: at(),
      entries: [],
      truncated: false,
      preflight: true,
      binding,
    });
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
