import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createRebindableDirectoryAlias,
  withRealpathSymlinkRebindRace,
} from "../test-utils/symlink-rebind-race.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { applyPatch, createMemoryPatchSandbox } from "./apply-patch.test-support.js";
import { resolveSandboxFileMutationQueueKey } from "./sandbox/file-mutation-identity.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";
import { isTrustedToolInputError } from "./tool-input-error.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function makeDir(workspace = false) {
  // The tracker canonicalizes the system temp root (macOS /var is a symlink).
  return tempDirs.make("openclaw-patch-", workspace ? process.cwd() : undefined);
}

async function makeFile(content: string, name = "source.txt", dir = makeDir()) {
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return { dir, file };
}

function buildAddFilePatch(targetPath: string, content = "escaped"): string {
  return `*** Begin Patch\n*** Add File: ${targetPath}\n+${content}\n*** End Patch`;
}

function buildDeletePatch(target: string): string {
  return `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch`;
}

function buildUpdatePatch(target: string, hunk: string, moveTo?: string): string {
  const move = moveTo === undefined ? "" : `*** Move to: ${moveTo}\n`;
  return `*** Begin Patch\n*** Update File: ${target}\n${move}@@\n${hunk}\n*** End Patch`;
}

it("fences apply_patch after a file read when permissions change", async () => {
  const { dir, file: target } = await makeFile("original\n", "permission.txt");
  const generation = new AbortController();
  const readFile = fs.readFile.bind(fs);
  const read = vi
    .spyOn(fs, "readFile")
    .mockImplementation(async (...args: Parameters<typeof readFile>) => {
      const value = await readFile(...args);
      if (args[0] === target) {
        generation.abort(new Error("Permission change"));
      }
      return value;
    });
  try {
    const tool = createApplyPatchTool({ cwd: dir, workspaceOnly: false });
    await expect(
      tool.execute(
        "permission-patch",
        { input: buildUpdatePatch("permission.txt", "-original\n+replacement") },
        generation.signal,
      ),
    ).rejects.toThrow("Permission change");
  } finally {
    read.mockRestore();
  }
  expect(await fs.readFile(target, "utf8")).toBe("original\n");
});

async function expectMissingPath(operation: Promise<unknown>) {
  await expect(operation).rejects.toMatchObject({ code: "ENOENT" });
}

describe("applyPatch", () => {
  it.each([
    { name: "empty", input: "", message: "Provide a patch input." },
    { name: "syntax", input: "bad patch", message: "The first line of the patch" },
    {
      name: "missing anchor",
      input: buildUpdatePatch("source.txt", "-absent\n+after"),
      message: "Failed to find expected lines",
    },
    {
      name: "ambiguous anchor",
      input: buildUpdatePatch("source.txt", "-target\n+after"),
      message: "Found 2 occurrences",
    },
  ])("classifies $name failures as trusted tool input errors", async ({ input, message }) => {
    const content = "target\ntarget\n";
    const { dir, file } = await makeFile(content);
    const error = await createApplyPatchTool({ cwd: dir })
      .execute("invalid-patch", { input })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", expect.stringContaining(message));
    expect(isTrustedToolInputError(error)).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe(content);
  });

  const priceUpdatePatch = buildUpdatePatch("source.txt", "-price: 5\n+price: 7");

  it.each([true, false])("rejects invalid UTF-8 (workspaceOnly=%s)", async (workspaceOnly) => {
    const dir = makeDir();
    const filePath = path.join(dir, "source.txt");
    const original = Buffer.concat([Buffer.from("heading\nprice: 5\n"), Buffer.from([0xff, 0xfe])]);
    await fs.writeFile(filePath, original);

    await expect(applyPatch(priceUpdatePatch, { cwd: dir, workspaceOnly })).rejects.toThrow(
      /not valid UTF-8/,
    );
    await expect(fs.readFile(filePath)).resolves.toEqual(original);
  });

  it("preserves a valid UTF-8 BOM in sandbox updates", async () => {
    const memory = createMemoryPatchSandbox({
      "source.txt": Buffer.from("\uFEFFheading\nprice: 5\n", "utf8"),
    });

    await applyPatch(priceUpdatePatch, memory.options);

    expect(memory.files.get("/sandbox/source.txt")).toBe("\uFEFFheading\nprice: 7\n");
  });

  it.each([true, false])(
    "refuses add over existing contents (workspaceOnly=%s)",
    async (workspaceOnly) => {
      const { dir, file: target } = await makeFile(
        "IMPORTANT USER DATA\nsecond line\n",
        "notes.txt",
        makeDir(true),
      );
      const tool = createApplyPatchTool({ cwd: dir, workspaceOnly });
      const patch = buildAddFilePatch("notes.txt", "replacement");

      await expect(tool.execute("call-add-existing", { input: patch }, undefined)).rejects.toThrow(
        /Cannot create notes\.txt: the file already exists/,
      );
      expect(await fs.readFile(target, "utf8")).toBe("IMPORTANT USER DATA\nsecond line\n");
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses existing symlinks in both host modes without changing their targets",
    async () => {
      for (const workspaceOnly of [true, false]) {
        const dir = makeDir(true);
        const target = path.join(dir, "target.txt");
        const link = path.join(dir, "notes.txt");
        await fs.writeFile(target, "keep me\n", "utf8");
        await fs.symlink("target.txt", link);
        const patch = buildAddFilePatch("notes.txt", "replacement");

        await expect(applyPatch(patch, { cwd: dir, workspaceOnly })).rejects.toThrow(
          workspaceOnly ? /symlink/i : /Cannot create notes\.txt: the file already exists/,
        );
        await expect(fs.readFile(target, "utf8")).resolves.toBe("keep me\n");
        await expect(fs.readlink(link)).resolves.toBe("target.txt");
      }
    },
  );

  it.each(["add", "move"] as const)(
    "refuses %s over a competing mid-patch write",
    async (operation) => {
      const moving = operation === "move";
      const memory = createMemoryPatchSandbox(moving ? { "source.txt": "foo\nbar\n" } : {});
      const target = moving ? "dest.txt" : "notes.txt";
      memory.mkdirp.mockImplementation(async () => {
        memory.files.set(`/sandbox/${target}`, "written by another writer\n");
      });
      const patch = moving
        ? buildUpdatePatch("source.txt", " foo\n-bar\n+baz", target)
        : buildAddFilePatch(target, "replacement");
      await expect(applyPatch(patch, memory.options)).rejects.toThrow(
        `Cannot create ${target}: the file already exists`,
      );
      expect(memory.files.get(`/sandbox/${target}`)).toBe("written by another writer\n");
      if (moving) {
        expect(memory.files.get("/sandbox/source.txt")).toBe("foo\nbar\n");
      } else {
        expect(memory.writeFile.mock.calls).toHaveLength(0);
      }
    },
  );

  it("allows an add after deleting the same path", async () => {
    const memory = createMemoryPatchSandbox({ "notes.txt": "old\n" });
    const patch =
      "*** Begin Patch\n*** Delete File: notes.txt\n*** Add File: notes.txt\n+new\n*** End Patch";

    const result = await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/notes.txt")).toBe("new\n");
    expect(result.summary.added).toEqual(["notes.txt"]);
  });

  it("fails closed on sandbox adds when atomic create is unavailable", async () => {
    const memory = createMemoryPatchSandbox({}, { supportsExclusiveCreate: false });
    const patch = buildAddFilePatch("notes.txt", "new");

    await expect(applyPatch(patch, memory.options)).rejects.toThrow(
      /does not support atomic file creation/,
    );
    expect(memory.files.has("/sandbox/notes.txt")).toBe(false);
  });

  it("updates and moves a file", async () => {
    const memory = createMemoryPatchSandbox({ "source.txt": "foo\nbar\n" });
    const patch = buildUpdatePatch("source.txt", " foo\n-bar\n+baz", "dest.txt");

    const result = await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/dest.txt")).toBe("foo\nbaz\n");
    expect(memory.files.has("/sandbox/source.txt")).toBe(false);
    expect(result.summary.modified).toEqual(["dest.txt"]);
  });

  it.each(["./source.txt", "/sandbox/./source.txt", "/sandbox//source.txt"])(
    "updates in place when legacy bridge move target %s names the source file",
    async (movePath) => {
      const memory = createMemoryPatchSandbox({ "source.txt": "foo\nbar\n" });
      // The public bridge contract permits resolved container paths with dot
      // segments. Its filesystem still treats these spellings as one file.
      memory.bridge.resolvePath = ({ filePath }) => ({
        relativePath: filePath,
        containerPath: path.posix.isAbsolute(filePath) ? filePath : `/sandbox/${filePath}`,
      });
      const patch = buildUpdatePatch("source.txt", " foo\n-bar\n+baz", movePath);

      const result = await applyPatch(patch, memory.options);

      expect(memory.files.get("/sandbox/source.txt")).toBe("foo\nbaz\n");
      expect(memory.files.size).toBe(1);
      expect(memory.createFileExclusive).not.toHaveBeenCalled();
      expect(memory.remove).not.toHaveBeenCalled();
      expect(result.summary.modified).toEqual(["source.txt"]);
    },
  );

  it.each([
    { containerRoot: "C:\\work", movePath: "C:\\work\\.\\source.txt" },
    { containerRoot: "C:\\work", movePath: "c:\\WORK\\SOURCE.txt" },
    { containerRoot: "\\\\server\\share", movePath: "\\\\SERVER\\share\\.\\source.txt" },
  ])(
    "updates and no-ops native Windows legacy same-file moves to $movePath",
    async ({ containerRoot, movePath }) => {
      const memory = createMemoryPatchSandbox({ "source.txt": "before\n" }, { containerRoot });
      memory.bridge.resolvePath = ({ filePath }) => ({
        relativePath: path.win32.isAbsolute(filePath)
          ? path.win32.relative(containerRoot, filePath)
          : filePath,
        containerPath: path.win32.isAbsolute(filePath) ? filePath : `${containerRoot}\\${filePath}`,
      });
      const move = (before: string, after: string) =>
        buildUpdatePatch("source.txt", `-${before}\n+${after}`, movePath);
      await expect(applyPatch(move("before", "after"), memory.options)).resolves.toMatchObject({
        summary: { modified: ["source.txt"] },
      });
      await expect(applyPatch(move("after", "after"), memory.options)).resolves.toMatchObject({
        noOp: true,
      });
      expect([...memory.files.values()]).toEqual(["after\n"]);
      expect(memory.writeFile).toHaveBeenCalledTimes(1);
      expect(memory.createFileExclusive).not.toHaveBeenCalled();
      expect(memory.remove).not.toHaveBeenCalled();
    },
  );

  it.each([
    { first: "C:\\work\\source.txt", second: "\\\\?\\c:\\WORK\\.\\source.txt", same: true },
    {
      first: "\\\\server\\share\\source.txt",
      second: "\\\\?\\UNC\\SERVER\\share\\.\\source.txt",
      same: true,
    },
    { first: "/workspace/a\\b", second: "/workspace/a/b", same: false },
    { first: "/workspace/C:\\name", second: "/workspace/C:/name", same: false },
  ])("compares legacy queue identity for $first and $second", async ({ first, second, same }) => {
    const { bridge } = createMemoryPatchSandbox();
    bridge.resolvePath = ({ filePath }) => ({ containerPath: filePath, relativePath: filePath });
    const key = (filePath: string) =>
      resolveSandboxFileMutationQueueKey({ bridge, root: "/queue", filePath });
    expect((await key(first)) === (await key(second))).toBe(same);
  });

  it("normalizes supported punctuation while matching update hunks", async () => {
    const cases = [
      ["a\u2010\u2011\u2012\u2013\u2014\u2015\u2212b", "a-------b"],
      ["a\u2018\u2019\u201A\u201Bb", "a''''b"],
      ["a\u201C\u201D\u201E\u201Fb", 'a""""b'],
      [
        "a\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000b",
        "a             b",
      ],
    ] as const;

    for (const [sourceLine, patchLine] of cases) {
      const memory = createMemoryPatchSandbox({ "source.txt": `${sourceLine}\n` });
      const patch = buildUpdatePatch("source.txt", `-${patchLine}\n+updated`);

      await applyPatch(patch, memory.options);

      expect(memory.files.get("/sandbox/source.txt")).toBe("updated\n");
    }
  });

  it("rejects path traversal outside cwd by default", async () => {
    const dir = makeDir();
    const escapedPath = path.join(makeDir(), "escaped.txt");
    const relativeEscape = path.relative(dir, escapedPath);

    await expect(applyPatch(buildAddFilePatch(relativeEscape), { cwd: dir })).rejects.toThrow(
      /Path escapes sandbox root/,
    );
    await expectMissingPath(fs.readFile(escapedPath, "utf8"));
  });

  it("rejects broken final symlink targets outside cwd by default", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeDir(true);
    const outsideDir = tempDirs.make("outside-broken-link-", path.dirname(dir));
    const outsideFile = path.join(outsideDir, "owned.txt");
    const linkPath = path.join(dir, "jump");
    await fs.symlink(outsideFile, linkPath);

    const patch = buildAddFilePatch("jump", "pwned");

    await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/Symlink escapes sandbox root/);
    await expectMissingPath(fs.readFile(outsideFile, "utf8"));
  });

  it("rejects symlinks within cwd by default", async () => {
    // File symlinks require SeCreateSymbolicLinkPrivilege on Windows.
    if (process.platform === "win32") {
      return;
    }
    const dir = makeDir();
    const target = path.join(dir, "target.txt");
    const linkPath = path.join(dir, "link.txt");
    await fs.writeFile(target, "initial\n", "utf8");
    await fs.symlink(target, linkPath);

    const patch = buildUpdatePatch("link.txt", "-initial\n+updated");

    await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
      // fs-safe 0.5.2 reports the symlink rejection through the boundary-read
      // validation path ("unsafe path") instead of a symlink-specific message.
      /path is not a regular file under root|symlink open blocked|unsafe path/i,
    );
    await expect(fs.readFile(target, "utf8")).resolves.toBe("initial\n");
  });

  it("rejects delete path traversal via symlink directories by default", async () => {
    const dir = makeDir();
    const outsideDir = tempDirs.make("outside-dir-", path.dirname(dir));
    const outsideFile = path.join(outsideDir, "victim.txt");
    await fs.writeFile(outsideFile, "victim\n", "utf8");

    const linkDir = path.join(dir, "linkdir");
    // Use 'junction' on Windows — junctions target directories without
    // requiring SeCreateSymbolicLinkPrivilege.
    await fs.symlink(outsideDir, linkDir, process.platform === "win32" ? "junction" : undefined);

    const patch = buildDeletePatch("linkdir/victim.txt");

    await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/Symlink escapes sandbox root/);
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("victim\n");
  });

  it("allows path traversal when workspaceOnly is explicitly disabled", async () => {
    const dir = makeDir();
    const escapedPath = path.join(makeDir(), "escaped.txt");
    const relativeEscape = path.relative(dir, escapedPath);

    const patch = buildAddFilePatch(relativeEscape);

    const result = await applyPatch(patch, { cwd: dir, workspaceOnly: false });
    expect(result.summary.added.length).toBe(1);
    await expect(fs.readFile(escapedPath, "utf8")).resolves.toBe("escaped\n");
  });

  it("allows deleting a symlink itself even if it points outside cwd", async () => {
    const dir = makeDir();
    const outsideDir = tempDirs.make("openclaw-patch-outside-", path.dirname(dir));
    const outsideTarget = path.join(outsideDir, "target.txt");
    await fs.writeFile(outsideTarget, "keep\n", "utf8");

    const linkDir = path.join(dir, "link");
    // Use 'junction' on Windows — junctions target directories without
    // requiring SeCreateSymbolicLinkPrivilege.
    await fs.symlink(outsideDir, linkDir, process.platform === "win32" ? "junction" : undefined);

    const patch = buildDeletePatch("link");

    const result = await applyPatch(patch, { cwd: dir });
    expect(result.summary.deleted).toEqual(["link"]);
    await expectMissingPath(fs.lstat(linkDir));
    await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("keep\n");
  });

  it("rejects move targets whose parent path is a symlink outside cwd", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeDir();
    const outsideDir = tempDirs.make("openclaw-patch-outside-", path.dirname(dir));
    const sourcePath = path.join(dir, "source.txt");
    const outsideTarget = path.join(outsideDir, "moved.txt");
    const linkDir = path.join(dir, "link");
    await fs.writeFile(sourcePath, "before\n", "utf8");
    await fs.symlink(outsideDir, linkDir);

    const patch = buildUpdatePatch("source.txt", "-before\n+after", "link/moved.txt");

    await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/symlink escapes sandbox root/i);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("before\n");
    await expectMissingPath(fs.readFile(outsideTarget, "utf8"));
  });

  it.runIf(process.platform !== "win32").each(["remove", "mkdir"] as const)(
    "blocks an outside mutation after directory rebinding before %s",
    async (operation) => {
      const dir = makeDir();
      const inside = path.join(dir, "inside");
      const outside = makeDir();
      const slot = path.join(dir, "slot");
      await fs.mkdir(inside, { recursive: true });
      const outsideTarget = path.join(outside, "target.txt");
      if (operation === "remove") {
        await fs.writeFile(path.join(inside, "target.txt"), "inside\n", "utf8");
        await fs.writeFile(outsideTarget, "outside\n", "utf8");
      }
      await createRebindableDirectoryAlias({ aliasPath: slot, targetPath: inside });
      const patch =
        operation === "remove"
          ? buildDeletePatch("slot/target.txt")
          : buildAddFilePatch("slot/nested/deep/file.txt", "safe");
      const checkedPath =
        operation === "remove" ? ["slot"] : ["slot", "nested", "deep", "file.txt"];
      await withRealpathSymlinkRebindRace({
        realpathApi: operation === "remove" ? "native-sync" : undefined,
        shouldFlip: (input) => input.endsWith(path.join(...checkedPath)),
        symlinkPath: slot,
        symlinkTarget: outside,
        timing: "before-realpath",
        run: async () => {
          const pending = applyPatch(patch, { cwd: dir });
          if (operation === "remove") {
            await expect(pending).rejects.toThrow(
              /symlink escapes sandbox root|under root|not found/i,
            );
          } else {
            await expect(pending).rejects.toMatchObject({ name: "FsSafeError", code: "symlink" });
          }
        },
      });
      if (operation === "remove") {
        await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside\n");
      } else {
        await expectMissingPath(fs.stat(path.join(outside, "nested")));
      }
    },
  );

  it.each(["legacy", "empty", "miss", "mapped"] as const)(
    "honors %s path mappings before patch mutation",
    async (mode) => {
      const root = makeDir();
      const mapping = { hostRoot: root, containerRoot: "C:\\NativeWorkspace" };
      const mappings = mode === "legacy" ? undefined : mode === "empty" ? [] : [mapping];
      const runtimeRoot = mode === "miss" ? "C:\\Other" : mapping.containerRoot;
      const bridge = createSandboxFsBridgeFromResolver((filePath) => {
        const relativePath = path.win32.isAbsolute(filePath)
          ? path.win32.relative(runtimeRoot, filePath)
          : filePath;
        return {
          hostPath: path.resolve(root, relativePath),
          relativePath,
          containerPath: path.win32.join(runtimeRoot, relativePath),
        };
      }, mappings);
      const create = vi.spyOn(bridge, "createFileExclusive");
      const tool = createApplyPatchTool({
        cwd: root,
        sandbox: { root, bridge, workspaceMounts: mappings },
      });
      if (mode === "empty" || mode === "miss") {
        await expect(
          tool.execute("denied", { input: buildAddFilePatch("new.txt") }),
        ).rejects.toThrow("Path escapes sandbox root");
        expect(create).not.toHaveBeenCalled();
        expect(await fs.readdir(root)).toEqual([]);
        return;
      }
      await tool.execute("admitted", { input: buildAddFilePatch("new.txt") });
      expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("escaped\n");
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "C:\\NativeWorkspace\\new.txt" }),
      );
      await expect(
        tool.execute("outside", { input: buildAddFilePatch("../outside.txt") }),
      ).rejects.toThrow(/Path escapes sandbox root/);
    },
  );
});

describe("applyPatch through directory aliases", () => {
  it.runIf(process.platform !== "win32").each([
    { name: "direct root", aliasedRoot: false, selfMove: false },
    { name: "canonical input under an aliased root", aliasedRoot: true, selfMove: false },
    { name: "same-file move", aliasedRoot: false, selfMove: true },
  ])(
    "updates and removes contained directory aliases through $name",
    async ({ aliasedRoot, selfMove }) => {
      const dir = makeDir();
      const realDir = path.join(dir, "real");
      await fs.mkdir(realDir, { recursive: true });
      await fs.writeFile(path.join(realDir, "note.txt"), "initial\n", "utf8");
      await fs.symlink(realDir, path.join(dir, "alias"), "dir");
      const cwd = aliasedRoot ? path.join(dir, "workspace-alias") : dir;
      if (aliasedRoot) {
        await fs.symlink(dir, cwd, "dir");
      }
      const target = aliasedRoot ? path.join(dir, "alias", "note.txt") : "alias/note.txt";

      const patch = buildUpdatePatch(
        selfMove ? "real/note.txt" : target,
        "-initial\n+updated",
        selfMove ? "alias/note.txt" : undefined,
      );

      await applyPatch(patch, { cwd });
      await expect(fs.readFile(path.join(realDir, "note.txt"), "utf8")).resolves.toBe("updated\n");
      await applyPatch(`*** Begin Patch\n*** Delete File: ${target}\n*** End Patch`, { cwd });
      await expect(fs.readdir(realDir)).resolves.toEqual([]);
      expect((await fs.lstat(path.join(dir, "alias"))).isSymbolicLink()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32").each(["add", "move"] as const)(
    "rejects %s destinations through contained directory aliases",
    async (operation) => {
      const dir = makeDir();
      const realDir = path.join(dir, "real");
      await fs.mkdir(realDir);
      await fs.symlink(realDir, path.join(dir, "alias"), "dir");
      await fs.writeFile(path.join(dir, "source.txt"), "original\n");
      const input =
        operation === "add"
          ? buildAddFilePatch("alias/new.txt", "new")
          : buildUpdatePatch("source.txt", "-original\n+new", "alias/new.txt");

      await expect(applyPatch(input, { cwd: dir })).rejects.toMatchObject({
        name: "FsSafeError",
        code: "symlink",
      });

      await expect(fs.readdir(realDir)).resolves.toEqual([]);
      await expect(fs.readFile(path.join(dir, "source.txt"), "utf8")).resolves.toBe("original\n");
    },
  );

  it("creates, updates, and deletes files in a literal tilde directory", async () => {
    const dir = makeDir();
    await applyPatch(buildAddFilePatch("./~/note.txt", "initial"), { cwd: dir });
    await applyPatch(buildUpdatePatch("./~/note.txt", "-initial\n+updated"), { cwd: dir });

    await expect(fs.readFile(path.join(dir, "~", "note.txt"), "utf8")).resolves.toBe("updated\n");
    await applyPatch(buildDeletePatch("./~/note.txt"), { cwd: dir });
    await expect(fs.readdir(path.join(dir, "~"))).resolves.toEqual([]);
  });
});

describe("apply_patch unrestricted host writes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createHostFile(content: string) {
    const tempDir = tempDirs.make("openclaw-patch-host-write-");
    const filePath = path.join(tempDir, "important.txt");
    await fs.writeFile(filePath, content);
    return filePath;
  }

  function failWrites(filePath: string, originalByteLength: number, phase: "prefix" | "extension") {
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags as never, mode as never);
      if (String(target) === filePath && flags === "r+") {
        const realWrite = handle.write.bind(handle);
        let failed = false;
        handle.write = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          if (phase === "prefix" && !failed && position < originalByteLength) {
            failed = true;
            await realWrite(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          }
          const result = await realWrite(buffer, offset, length, position);
          if (phase === "extension" && position >= originalByteLength) {
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          }
          return result;
        }) as typeof handle.write;
      }
      return handle;
    });
  }

  function hostUpdate(filePath: string) {
    return applyPatch(buildUpdatePatch(filePath, "-original\n+replacement"), {
      cwd: path.dirname(filePath),
      workspaceOnly: false,
    });
  }

  it.each(["prefix", "extension"] as const)(
    "rolls back a host update after a %s write failure",
    async (phase) => {
      const originalContent =
        phase === "prefix" ? `original\n${"important content\n".repeat(64)}` : "original\n";
      const filePath = await createHostFile(originalContent);
      failWrites(filePath, Buffer.byteLength(originalContent), phase);
      await expect(hostUpdate(filePath)).rejects.toThrow("disk full");

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
      await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(["important.txt"]);
    },
  );

  it.runIf(process.platform !== "win32")("applies host update hunks in place", async () => {
    const filePath = await createHostFile("original\n");
    await fs.chmod(filePath, 0o640);
    const before = await fs.stat(filePath);

    const result = await hostUpdate(filePath);

    expect(result.summary.modified).toEqual(["important.txt"]);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement\n");
    const after = await fs.stat(filePath);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o640);
  });
});

describe("apply_patch mutation authority", () => {
  afterEach(() => {
    __setFsSafeTestHooksForTest();
  });

  it.each(["create", "remove"] as const)(
    "rechecks patch authority after %s preparation",
    async (operation) => {
      const root = await fs.realpath(tempDirs.make("openclaw-patch-authority-"));
      const existing = path.join(root, "existing.txt");
      await fs.writeFile(existing, "original\n");
      const target = operation === "create" ? path.join(root, "nested", "new.txt") : existing;
      let current = true;
      let prepared = false;
      const revoke = async () => {
        await Promise.resolve();
        current = false;
        prepared = true;
      };
      __setFsSafeTestHooksForTest({
        beforePinnedWriteParentAdmission: async (targetPath) => {
          if (operation === "create" && targetPath === target) {
            await revoke();
          }
        },
        beforeRootFallbackMutation: async (kind, targetPath) => {
          if (kind === operation && targetPath === target) {
            await revoke();
          }
        },
      });

      const tool = createApplyPatchTool({ cwd: root });
      const input =
        operation === "create"
          ? buildAddFilePatch("nested/new.txt", "new")
          : buildDeletePatch("existing.txt");
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:patch-authority",
          receiptAuthority: () => current,
        },
        () => tool.execute("patch-authority", { input }),
      );

      await expect(pending).rejects.toThrow("authority is no longer active");
      expect(prepared).toBe(true);
      await expect(fs.readFile(existing, "utf8")).resolves.toBe("original\n");
      await expect(fs.readdir(root)).resolves.toEqual(["existing.txt"]);
    },
  );
});
