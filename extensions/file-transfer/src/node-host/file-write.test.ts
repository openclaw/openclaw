import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { handleFileWrite } from "./file-write.js";
import { observeFileOpen, useFiles } from "./node-host.test-support.js";

const { at, dir: makeDir, file: makeFile, replacement } = useFiles("file-write-test-");

type WriteOptions = Parameters<typeof handleFileWrite>[0];
function write(target: string, content: string | Buffer, options: WriteOptions = {}) {
  return handleFileWrite(writeParams(target, content, options));
}
const writeParams = (target: string, content: string | Buffer, options: WriteOptions) => ({
  path: target,
  contentBase64: Buffer.from(content).toString("base64"),
  ...options,
});
async function authorize(target: string, content: string | Buffer, options: WriteOptions = {}) {
  const preflight = await write(target, content, { ...options, preflightOnly: true });
  assert(preflight.ok);
  return {
    ...writeParams(target, content, options),
    expectedCanonicalPath: preflight.path,
    expectedBinding: preflight.binding,
  };
}

async function expectFailure(
  result: ReturnType<typeof handleFileWrite>,
  code: string,
  fields = {},
) {
  await expect(result).resolves.toMatchObject({ ok: false, code, ...fields });
}

function expectSuccessFields(
  result: Awaited<ReturnType<typeof handleFileWrite>>,
  fields: Record<string, unknown>,
) {
  expect(result).toMatchObject({ ok: true, ...fields });
}

async function expectAccessMissing(target: string) {
  await expect(fs.access(target)).rejects.toHaveProperty("code", "ENOENT");
}

describe("handleFileWrite", () => {
  it.each(["", "relative.txt", "/tmp/foo\0bar"])("rejects invalid path %j", async (target) => {
    await expectFailure(write(target, "x"), "INVALID_PATH");
  });

  it("requires contentBase64 but allows an empty encoded payload", async () => {
    await expectFailure(handleFileWrite({ path: at("missing.bin") }), "INVALID_BASE64");

    const target = at("deep", "nested", "empty.bin");
    expectSuccessFields(await write(target, "", { createParents: true }), {
      size: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(await fs.readFile(target)).toHaveLength(0);
  });
  it("closes the published handle after a failed identity stat", async () => {
    const target = at("stat-failure.txt");
    let observed: Awaited<ReturnType<typeof fs.open>> | undefined;
    const openSpy = observeFileOpen((handle, file, flags) => {
      const readOnly =
        flags === "r" ||
        (typeof flags === "number" && (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR)) === 0);
      if (String(file) === target && readOnly) {
        observed = handle;
        vi.spyOn(handle, "stat").mockRejectedValueOnce(
          Object.assign(new Error("identity observation failed"), { code: "EIO" }),
        );
      }
    });
    try {
      expectSuccessFields(await write(target, "published"), { path: target, size: 9 });
      if (!observed) {
        throw new Error("expected a real handle for the published file");
      }
      await expect(observed.stat()).rejects.toMatchObject({ code: "EBADF" });
      await expect(fs.readFile(target, "utf8")).resolves.toBe("published");
    } finally {
      openSpy.mockRestore();
      await observed?.close();
    }
  });
  it.each([false, true])("honors overwrite=%s", async (overwrite) => {
    const target = await makeFile("exists.txt", "before");
    const result = write(target, "after", { overwrite });
    if (overwrite) {
      expectSuccessFields(await result, { overwritten: true });
    } else {
      await expectFailure(result, "EXISTS_NO_OVERWRITE");
    }
    expect(await fs.readFile(target, "utf-8")).toBe(overwrite ? "after" : "before");
  });
  it("requires createParents for a missing parent", async () => {
    await expectFailure(write(at("deep", "child.txt"), "x"), "PARENT_NOT_FOUND");
  });
  it.each([false, true])("rejects final symlinks: follow=%s", async (followSymlinks) => {
    const real = await makeFile("real.txt", "untouched");
    const link = at("link.txt");
    await fs.symlink(real, link);
    await expectFailure(
      write(link, "evil", { overwrite: true, ...(followSymlinks ? { followSymlinks } : {}) }),
      followSymlinks ? "SYMLINK_TARGET_DENIED" : "SYMLINK_REDIRECT",
      followSymlinks ? {} : { canonicalPath: real },
    );
    expect(await fs.readFile(real, "utf-8")).toBe("untouched");
  });

  it.each(["new-file.txt", "new/child.txt"])("rejects a symlinked parent of %s", async (name) => {
    const realDir = await makeDir("real-dir");
    const sentinel = await makeFile("real-dir/sentinel.txt", "DO_NOT_TOUCH");
    const allowed = at("allowed");
    await fs.symlink(realDir, allowed);
    await expectFailure(
      write(path.join(allowed, name), "payload", { createParents: name.includes("/") }),
      "SYMLINK_REDIRECT",
      { canonicalPath: path.join(realDir, name) },
    );
    await expectAccessMissing(path.join(realDir, name.split("/")[0]!));
    expect(await fs.readFile(sentinel, "utf-8")).toBe("DO_NOT_TOUCH");
  });

  it("preflights a canonical write without creating parents", async () => {
    const realDir = await makeDir("real-dir");
    const allowed = at("allowed");
    await fs.symlink(realDir, allowed);

    const result = write(path.join(allowed, "new", "child.txt"), "payload", {
      createParents: true,
      followSymlinks: true,
      preflightOnly: true,
    });

    expectSuccessFields(await result, { path: path.join(realDir, "new", "child.txt"), size: 7 });
    await expectAccessMissing(path.join(realDir, "new"));
  });

  it.runIf(process.platform !== "win32")("rejects a retargeted parent before writing", async () => {
    const first = await makeDir("first");
    const second = await makeDir("second");
    const link = at("current");
    await fs.symlink(first, link);
    const target = path.join(link, "out.txt");
    const authorized = await authorize(target, "approved", { followSymlinks: true });
    await fs.unlink(link);
    await fs.symlink(second, link);
    await expectFailure(
      write(target, "not approved", {
        followSymlinks: true,
        expectedCanonicalPath: authorized.expectedCanonicalPath,
      }),
      "CANONICAL_PATH_CHANGED",
    );
    await expectAccessMissing(path.join(first, "out.txt"));
    await expectAccessMissing(path.join(second, "out.txt"));
  });

  it("rejects an existing-file replacement at the same canonical pathname", async () => {
    const { target, original, swap } = await replacement("inode");
    const authorized = await authorize(target, "next", { overwrite: true });
    await swap();
    await expectFailure(handleFileWrite(authorized), "CANONICAL_PATH_CHANGED");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("not approved");
    await expect(fs.readFile(original, "utf8")).resolves.toBe("approved");
  });

  it("checks hard links on the bound write handle after path validation", async () => {
    const target = await makeFile("target.txt", "before");
    const alias = at("outside-alias.txt");
    const authorized = await authorize(target, "after", { overwrite: true, rejectHardlinks: true });
    const openSpy = observeFileOpen(async (_handle, file, flags) => {
      if (file === target && flags === "r+") {
        await fs.link(target, alias);
      }
    });
    try {
      await expectFailure(handleFileWrite(authorized), "HARDLINK_TARGET_DENIED");
      await expect(fs.readFile(target, "utf8")).resolves.toBe("before");
      await expect(fs.readFile(alias, "utf8")).resolves.toBe("before");
    } finally {
      openSpy.mockRestore();
    }
  });

  it("preserves the preflight-bound inode and hardlinks", async () => {
    const content = "after";
    const target = await makeFile("target.txt", "before");
    const alias = at("alias.txt");
    await fs.link(target, alias);
    const identity = await fs.stat(target, { bigint: true });
    const authorized = await authorize(target, content, { overwrite: true });

    expectSuccessFields(await handleFileWrite(authorized), {
      path: target,
      size: Buffer.byteLength(content),
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe(content);
    await expect(fs.readFile(alias, "utf8")).resolves.toBe(content);
    await expect(fs.stat(target, { bigint: true })).resolves.toMatchObject({
      dev: identity.dev,
      ino: identity.ino,
    });
  });

  it.each([false, true])(
    "checks parent identity before creation: replaced=%s",
    async (replaced) => {
      const parent = await makeDir("parent");
      const target = path.join(parent, "new.txt");
      const authorized = await authorize(target, "next");
      if (replaced) {
        await fs.rename(parent, at("moved"));
        await fs.mkdir(parent);
      }
      const result = handleFileWrite(authorized);
      if (replaced) {
        await expectFailure(result, "CANONICAL_PATH_CHANGED");
        await expectAccessMissing(target);
        await expectAccessMissing(at("moved", "new.txt"));
      } else {
        expectSuccessFields(await result, { path: target, size: 4 });
        await expect(fs.readFile(target, "utf8")).resolves.toBe("next");
      }
    },
  );

  it("refuses to overwrite a directory", async () => {
    await expectFailure(write(await makeDir("is-a-dir"), "x", { overwrite: true }), "IS_DIRECTORY");
  });
  it.each([false, true])(
    "preserves content on hash mismatch: preflight=%s",
    async (preflightOnly) => {
      const target = await makeFile("victim.txt", "ORIGINAL_CONTENT_DO_NOT_TOUCH");

      await expectFailure(
        write(target, "attacker-content", {
          overwrite: true,
          preflightOnly,
          expectedSha256: "0".repeat(64),
        }),
        "INTEGRITY_FAILURE",
      );
      expect(await fs.readFile(target, "utf-8")).toBe("ORIGINAL_CONTENT_DO_NOT_TOUCH");
    },
  );
  it.each([
    ["malformed", "AAA@@@"],
    ["whitespace", " \n\t".repeat(1024 * 1024)],
  ])("rejects %s base64 before decoding", async (_label, contentBase64) => {
    const bufferFrom = vi.spyOn(Buffer, "from");
    const target = at("bad.bin");
    await expectFailure(handleFileWrite({ path: target, contentBase64 }), "INVALID_BASE64");
    expect(bufferFrom).not.toHaveBeenCalled();
    await expectAccessMissing(target);
  });
  it("rejects content larger than the 16MB cap", async () => {
    await expectFailure(write(at("big.bin"), Buffer.alloc(17 * 1024 * 1024)), "FILE_TOO_LARGE");
  });
  it.each(["extension", "prefix"])("rolls back a failed %s write", async (stage) => {
    const original = Buffer.alloc(stage === "extension" ? 4096 : 8192, 0x61);
    const target = await makeFile("victim.bin", original);
    const payload = Buffer.alloc(stage === "extension" ? 8192 : 4096, 0x62);
    const authorized = await authorize(target, payload, { overwrite: true });
    let failed = false;
    const spy = observeFileOpen((handle, file, flags) => {
      if (String(file) !== target || flags !== "r+") {
        return;
      }
      const writeChunk = handle.write.bind(handle);
      handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        // The prefix failure is one-shot so rollback can restore the original.
        const fail =
          stage === "extension"
            ? position >= original.length
            : !failed && position < payload.length;
        if (fail) {
          failed = true;
          if (stage === "prefix") {
            await writeChunk(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
          }
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        return writeChunk(buffer, offset, length, position);
      }) as typeof handle.write;
    });
    await expect(handleFileWrite(authorized)).rejects.toMatchObject({ code: "ENOSPC" });
    spy.mockRestore();

    expect(await fs.readFile(target)).toEqual(original);
  });
});
