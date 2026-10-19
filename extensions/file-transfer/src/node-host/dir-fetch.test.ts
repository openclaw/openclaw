import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTarArchive } from "./dir-fetch-archive.js";
import { handleDirFetch } from "./dir-fetch.js";

let tmpRoot: string;

beforeEach(async () => {
  // realpath: see file-fetch.test.ts for the macOS symlinked-tmpdir reason.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-fetch-test-")));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// dir-fetch needs /usr/bin/tar, unavailable on Windows CI.
const HAS_TAR = process.platform !== "win32";

async function seed(files: Record<string, string | Buffer>) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(tmpRoot, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

async function fetchDirectory(input: Parameters<typeof handleDirFetch>[0]) {
  const result = await handleDirFetch(input);
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  }
  return result;
}

async function expectDirFetchError(input: Parameters<typeof handleDirFetch>[0], code: string) {
  const result = await handleDirFetch(input);
  expect(result).toMatchObject({ ok: false, code });
}

describe("handleDirFetch", () => {
  it("rejects empty / non-string path", async () => {
    await expectDirFetchError({ path: "" }, "INVALID_PATH");
  });
  it.runIf(process.platform !== "win32")(
    "binds tar to the canonical directory after changing its working directory",
    async () => {
      const first = path.join(tmpRoot, "first");
      const second = path.join(tmpRoot, "second");
      const link = path.join(tmpRoot, "current");
      await fs.mkdir(first);
      await fs.mkdir(second);
      await fs.symlink(second, link);

      const firstStats = await fs.stat(first, { bigint: true });
      await expect(
        createTarArchive(link, first, String(firstStats.dev), String(firstStats.ino), 1024 * 1024),
      ).resolves.toBe("CANONICAL_PATH_CHANGED");
    },
  );

  it.runIf(HAS_TAR)("rejects a same-path replacement before tar starts", async () => {
    const target = path.join(tmpRoot, "target");
    const moved = path.join(tmpRoot, "moved");
    await fs.mkdir(target);
    const targetStats = await fs.stat(target, { bigint: true });
    await fs.rename(target, moved);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "secret.txt"), "secret");

    await expect(
      createTarArchive(
        target,
        target,
        String(targetStats.dev),
        String(targetStats.ino),
        1024 * 1024,
      ),
    ).resolves.toBe("CANONICAL_PATH_CHANGED");
  });

  it.runIf(HAS_TAR)("preflights directory entries without returning a tarball", async () => {
    await seed({
      "a.txt": "alpha\n",
      ".ssh/id_rsa": "secret\n",
      "sub/b.txt": "beta\n",
      "c/z.txt": "first subtree\n",
      "c\u200d/a.txt": "second subtree\n",
    });
    await fs.symlink("missing-target", path.join(tmpRoot, "dangling-link"));

    const r = await fetchDirectory({ path: tmpRoot, preflightOnly: true });
    expect(r).toMatchObject({
      path: tmpRoot,
      tarBase64: "",
      tarBytes: 0,
      sha256: "",
      preflightOnly: true,
    });
    expect(r.entries).toEqual(
      ".ssh .ssh/id_rsa a.txt c c/z.txt c\u200d c\u200d/a.txt dangling-link sub sub/b.txt".split(
        " ",
      ),
    );
    expect(r.fileCount).toBe(r.entries?.length);
  });

  it.runIf(HAS_TAR && process.platform !== "win32")(
    "rejects a retargeted path before creating an archive",
    async () => {
      const first = path.join(tmpRoot, "first");
      const second = path.join(tmpRoot, "second");
      const link = path.join(tmpRoot, "current");
      await seed({ "first/approved.txt": "approved", "second/not-approved.txt": "not approved" });
      await fs.symlink(first, link);

      const preflight = await fetchDirectory({
        path: link,
        followSymlinks: true,
        preflightOnly: true,
      });
      await fs.unlink(link);
      await fs.symlink(second, link);

      const result = await handleDirFetch({
        path: link,
        followSymlinks: true,
        expectedCanonicalPath: preflight.path,
      });

      expect(result).toEqual({
        ok: false,
        code: "CANONICAL_PATH_CHANGED",
        message: "resolved path differs from the authorized target",
        canonicalPath: second,
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "returns an invalid-path error for a non-UTF-8 filename instead of a partial preflight",
    async () => {
      await fs.writeFile(path.join(tmpRoot, "valid.txt"), "valid sibling");
      const nested = path.join(tmpRoot, "nested");
      await fs.mkdir(nested);
      await fs.writeFile(
        Buffer.concat([Buffer.from(`${nested}/`), Buffer.from([0xff])]),
        "unrepresentable filename",
      );

      const result = await handleDirFetch({ path: tmpRoot, preflightOnly: true });

      expect(result).toEqual({
        ok: false,
        code: "INVALID_PATH",
        message: expect.stringContaining("directory entry name is not valid UTF-8"),
        canonicalPath: tmpRoot,
      });
    },
  );

  it.runIf(HAS_TAR)(
    "rejects a replacement at the same canonical pathname before creating an archive",
    async () => {
      const target = path.join(tmpRoot, "target");
      const moved = path.join(tmpRoot, "moved");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "approved.txt"), "approved");
      const preflight = await fetchDirectory({ path: target, preflightOnly: true });
      await fs.rename(target, moved);
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "secret.txt"), "secret");

      const result = await handleDirFetch({
        path: target,
        expectedCanonicalPath: preflight.path,
        expectedBinding: preflight.binding,
      });

      expect(result).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
    },
  );

  it.runIf(HAS_TAR)("returns a gzipped tar with byte count and sha256", async () => {
    await seed({
      "a.txt": "alpha\n",
      "b.txt": "beta\n",
      "sub/c.txt": "gamma\n",
      ".root-note": "hidden root\n",
      ".hidden/note.txt": "hidden member\n",
    });
    const r = await fetchDirectory({ path: tmpRoot });

    expect(r.tarBytes).toBeGreaterThan(0);
    expect(r.tarBase64.length).toBeGreaterThan(0);

    const buf = Buffer.from(r.tarBase64, "base64");
    expect(buf.byteLength).toBe(r.tarBytes);

    const expectedSha = crypto.createHash("sha256").update(buf).digest("hex");
    expect(r.sha256).toBe(expectedSha);

    expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    // file count covers the regular files we created (5); BSD tar may also
    // list directory entries, so be generous.
    expect(r.fileCount).toBeGreaterThanOrEqual(5);
    expect(r.entries).toEqual(
      expect.arrayContaining("a.txt b.txt sub sub/c.txt .root-note .hidden/note.txt".split(" ")),
    );
    expect(r.fileCount).toBe(r.entries?.length);
  });
  it.runIf(HAS_TAR)("returns TREE_TOO_LARGE for oversized preflight-only directories", async () => {
    const largePath = path.join(tmpRoot, "large.bin");
    await fs.writeFile(largePath, crypto.randomBytes(1024 * 1024));

    await expectDirFetchError(
      { path: tmpRoot, maxBytes: 64 * 1024, preflightOnly: true },
      "TREE_TOO_LARGE",
    );
  });

  it.runIf(HAS_TAR)(
    "returns TREE_TOO_LARGE when content exceeds the cap mid-stream",
    async () => {
      // Write enough random content to exceed a small maxBytes. Random bytes
      // don't compress, so gzip output is roughly the same size as input.
      const big = crypto.randomBytes(512 * 1024);
      await seed({ "big1.bin": big, "big2.bin": big, "big3.bin": big });

      // 64KB cap should trip either the du preflight or the streaming SIGTERM.
      await expectDirFetchError({ path: tmpRoot, maxBytes: 64 * 1024 }, "TREE_TOO_LARGE");
    },
    30_000,
  );
});
