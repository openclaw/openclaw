import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleFileWrite } from "./file-write.js";
import { useFiles } from "./node-host.test-support.js";

const { at, dir: makeDir, file: makeFile } = useFiles("file-write-test-");

type WriteOptions = Parameters<typeof handleFileWrite>[0];
function write(target: string, content: string | Buffer, options: WriteOptions = {}) {
  return handleFileWrite({
    path: target,
    contentBase64: Buffer.from(content).toString("base64"),
    ...options,
  });
}
async function authorize(target: string, content: string | Buffer, options: WriteOptions = {}) {
  const preflight = await write(target, content, { ...options, preflightOnly: true });
  if (!preflight.ok) {
    throw new Error(`expected ok, got ${preflight.code}: ${preflight.message}`);
  }
  return {
    path: target,
    contentBase64: Buffer.from(content).toString("base64"),
    ...options,
    expectedCanonicalPath: preflight.path,
    expectedBinding: preflight.binding,
  };
}

function expectFailure(result: Awaited<ReturnType<typeof handleFileWrite>>, code: string) {
  expect(result).toMatchObject({ ok: false, code });
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
    expectFailure(await write(target, "x"), "INVALID_PATH");
  });

  it("requires contentBase64 but allows an empty encoded payload", async () => {
    const missing = await handleFileWrite({ path: at("missing.bin") });
    expectFailure(missing, "INVALID_BASE64");

    const target = at("empty.bin");
    const empty = await handleFileWrite({ path: target, contentBase64: "" });
    expectSuccessFields(empty, {
      size: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(await fs.readFile(target)).toHaveLength(0);
  });
  it("closes the published file when its final identity stat fails", async () => {
    const target = at("stat-failure.txt");
    const realOpen = fs.open.bind(fs);
    let observed: Awaited<ReturnType<typeof fs.open>> | undefined;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      const readOnly =
        flags === "r" ||
        (typeof flags === "number" && (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR)) === 0);
      if (String(file) === target && readOnly) {
        observed = handle;
        vi.spyOn(handle, "stat").mockRejectedValueOnce(
          Object.assign(new Error("identity observation failed"), { code: "EIO" }),
        );
      }
      return handle;
    });
    try {
      const result = await write(target, "published");
      expectSuccessFields(result, { path: target, size: 9 });
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
    const result = await write(target, "after", { overwrite });
    if (overwrite) {
      expectSuccessFields(result, { overwritten: true });
    } else {
      expectFailure(result, "EXISTS_NO_OVERWRITE");
    }
    expect(await fs.readFile(target, "utf-8")).toBe(overwrite ? "after" : "before");
  });
  it.each([false, true])("honors createParents=%s", async (createParents) => {
    const target = at("deep", "nested", "child.txt");
    const result = await write(target, "x", { createParents });
    if (createParents) {
      expect(result.ok).toBe(true);
      expect(await fs.readFile(target, "utf-8")).toBe("x");
    } else {
      expectFailure(result, "PARENT_NOT_FOUND");
    }
  });
  it.each([false, true])(
    "rejects final symlinks with followSymlinks=%s",
    async (followSymlinks) => {
      const real = await makeFile("real.txt", "untouched");
      const link = at("link.txt");
      await fs.symlink(real, link);
      const r = await write(link, "evil", {
        overwrite: true,
        ...(followSymlinks ? { followSymlinks: true } : {}),
      });
      expectFailure(r, followSymlinks ? "SYMLINK_TARGET_DENIED" : "SYMLINK_REDIRECT");
      if (!followSymlinks) {
        expect(r.ok ? null : r.canonicalPath).toBe(real);
      }
      expect(await fs.readFile(real, "utf-8")).toBe("untouched");
    },
  );

  it("refuses to write through a symlink in a parent directory by default", async () => {
    const realDir = await makeDir("real-dir");
    const sentinel = path.join(realDir, "sentinel.txt");
    await fs.writeFile(sentinel, "DO_NOT_TOUCH");

    const allowed = at("allowed");
    await fs.symlink(realDir, allowed);

    const r = await write(path.join(allowed, "new-file.txt"), "payload");
    expectFailure(r, "SYMLINK_REDIRECT");
    expect(r.ok ? null : r.canonicalPath).toBe(path.join(realDir, "new-file.txt"));
    await expectAccessMissing(path.join(realDir, "new-file.txt"));
    expect(await fs.readFile(sentinel, "utf-8")).toBe("DO_NOT_TOUCH");
  });

  it("checks symlinked parents before recursive mkdir", async () => {
    const realDir = await makeDir("real-dir");
    const allowed = at("allowed");
    await fs.symlink(realDir, allowed);

    const r = await write(path.join(allowed, "new", "child.txt"), "payload", {
      createParents: true,
    });

    expectFailure(r, "SYMLINK_REDIRECT");
    expect(r.ok ? null : r.canonicalPath).toBe(path.join(realDir, "new", "child.txt"));
    await expectAccessMissing(path.join(realDir, "new"));
  });

  it.each([
    { name: "without an expected hash", expectedSha256: undefined },
    { name: "with an incorrect hash", expectedSha256: "0".repeat(64) },
  ])(
    "preflights canonical write targets $name without creating files or parents",
    async ({ expectedSha256 }) => {
      const realDir = await makeDir("real-dir");
      const allowed = at("allowed");
      await fs.symlink(realDir, allowed);

      const r = await write(path.join(allowed, "new", "child.txt"), "payload", {
        createParents: true,
        followSymlinks: true,
        preflightOnly: true,
        expectedSha256,
      });

      if (expectedSha256) {
        expectFailure(r, "INTEGRITY_FAILURE");
      } else {
        expectSuccessFields(r, {
          path: path.join(realDir, "new", "child.txt"),
          size: "payload".length,
        });
      }
      await expectAccessMissing(path.join(realDir, "new"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a retargeted parent before writing bytes",
    async () => {
      const first = at("first");
      const second = at("second");
      const link = at("current");
      await fs.mkdir(first);
      await fs.mkdir(second);
      await fs.symlink(first, link);
      const requestedPath = path.join(link, "out.txt");

      const authorized = await authorize(requestedPath, "approved", { followSymlinks: true });
      await fs.unlink(link);
      await fs.symlink(second, link);

      const result = await write(requestedPath, "not approved", {
        followSymlinks: true,
        expectedCanonicalPath: authorized.expectedCanonicalPath,
      });

      expectFailure(result, "CANONICAL_PATH_CHANGED");
      await expectAccessMissing(path.join(first, "out.txt"));
      await expectAccessMissing(path.join(second, "out.txt"));
    },
  );

  it("rejects an existing-file replacement at the same canonical pathname", async () => {
    const target = at("target.txt");
    const moved = at("moved.txt");
    await fs.writeFile(target, "approved");
    const authorized = await authorize(target, "next", { overwrite: true });
    await fs.rename(target, moved);
    await fs.writeFile(target, "replacement");

    const result = await handleFileWrite(authorized);

    expectFailure(result, "CANONICAL_PATH_CHANGED");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(moved, "utf8")).resolves.toBe("approved");
  });

  it("checks hard links on the bound write handle after path validation", async () => {
    const target = at("target.txt");
    const alias = at("outside-alias.txt");
    await fs.writeFile(target, "before");
    const authorized = await authorize(target, "after", { overwrite: true, rejectHardlinks: true });
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === target && args[1] === "r+") {
        await fs.link(target, alias);
      }
      return handle;
    });
    try {
      const result = await handleFileWrite(authorized);
      expectFailure(result, "HARDLINK_TARGET_DENIED");
      await expect(fs.readFile(target, "utf8")).resolves.toBe("before");
      await expect(fs.readFile(alias, "utf8")).resolves.toBe("before");
    } finally {
      openSpy.mockRestore();
    }
  });

  it("preserves the preflight-bound inode and hardlinks", async () => {
    const content = "after";
    const target = at("target.txt");
    const alias = at("alias.txt");
    await fs.writeFile(target, "before");
    await fs.link(target, alias);
    const identity = await fs.stat(target, { bigint: true });
    const authorized = await authorize(target, content, { overwrite: true });

    const result = await handleFileWrite(authorized);

    expectSuccessFields(result, { path: target, size: Buffer.byteLength(content) });
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
      const parent = at("parent");
      const target = path.join(parent, "new.txt");
      await fs.mkdir(parent);
      const authorized = await authorize(target, "next");
      if (replaced) {
        await fs.rename(parent, at("moved"));
        await fs.mkdir(parent);
      }
      const result = await handleFileWrite(authorized);
      if (replaced) {
        expectFailure(result, "CANONICAL_PATH_CHANGED");
        await expectAccessMissing(target);
        await expectAccessMissing(at("moved", "new.txt"));
      } else {
        expectSuccessFields(result, { path: target, size: 4 });
        await expect(fs.readFile(target, "utf8")).resolves.toBe("next");
      }
    },
  );

  it("refuses to overwrite a directory", async () => {
    const target = await makeDir("is-a-dir");

    const r = await write(target, "x", { overwrite: true });
    expectFailure(r, "IS_DIRECTORY");
  });
  it("does NOT replace or delete an existing file when overwrite=true and expectedSha256 mismatches", async () => {
    const target = await makeFile("victim.txt", "ORIGINAL_CONTENT_DO_NOT_TOUCH");

    const r = await write(target, "attacker-content", {
      overwrite: true,
      expectedSha256: "0".repeat(64),
    });
    expectFailure(r, "INTEGRITY_FAILURE");
    // Critical: the original must survive. A bad caller hash must not
    // be a primitive for replacing-then-deleting an existing file.
    expect(await fs.readFile(target, "utf-8")).toBe("ORIGINAL_CONTENT_DO_NOT_TOUCH");
  });
  it("rejects malformed base64 that silently drops characters", async () => {
    const target = at("bad.bin");
    // "@" is not in the base64 alphabet — Buffer.from would silently drop
    // it and decode "AAA" instead of failing.
    const r = await handleFileWrite({
      path: target,
      contentBase64: "AAA@@@",
    });
    expectFailure(r, "INVALID_BASE64");
    await expectAccessMissing(target);
  });

  it("rejects whitespace and control characters before decoding", async () => {
    const bufferFrom = vi.spyOn(Buffer, "from");
    const target = at("whitespace.bin");
    const r = await handleFileWrite({
      path: target,
      contentBase64: " \n\t".repeat(1024 * 1024),
    });

    expectFailure(r, "INVALID_BASE64");
    expect(bufferFrom).not.toHaveBeenCalled();
    await expectAccessMissing(target);
  });
  it("rejects content larger than the 16MB cap", async () => {
    const target = at("big.bin");
    const big = Buffer.alloc(17 * 1024 * 1024, 0);
    const r = await handleFileWrite({
      path: target,
      contentBase64: big.toString("base64"),
    });
    expectFailure(r, "FILE_TOO_LARGE");
  });
  function failBoundWrites(
    filePath: string,
    shouldFail: (position: number) => { fail: boolean; partial?: boolean },
  ) {
    const realOpen = fs.open.bind(fs);
    return vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags as never, mode as never);
      if (String(target) === filePath && flags === "r+") {
        const realWrite = handle.write.bind(handle);
        handle.write = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          const decision = shouldFail(position);
          if (decision.fail) {
            if (decision.partial) {
              await realWrite(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
            }
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          }
          return realWrite(buffer, offset, length, position);
        }) as typeof handle.write;
      }
      return handle;
    });
  }

  it.each(["extension", "prefix"])("rolls back a failed %s write", async (stage) => {
    const target = at("victim.bin");
    const original = Buffer.alloc(stage === "extension" ? 4096 : 8192, 0x61);
    await fs.writeFile(target, original);
    const payload = Buffer.alloc(stage === "extension" ? 8192 : 4096, 0x62);
    const authorized = await authorize(target, payload, { overwrite: true });
    let failed = false;
    const spy = failBoundWrites(target, (position) => {
      if (stage === "extension") {
        return { fail: position >= original.length };
      }
      // Fail once after a partial prefix write; allow the rollback to write.
      if (failed || position >= payload.length) {
        return { fail: false };
      }
      failed = true;
      return { fail: true, partial: true };
    });
    await expect(handleFileWrite(authorized)).rejects.toMatchObject({ code: "ENOSPC" });
    spy.mockRestore();

    expect(await fs.readFile(target)).toEqual(original);
  });
});
