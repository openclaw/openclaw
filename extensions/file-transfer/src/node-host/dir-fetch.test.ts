import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTarArchive } from "./dir-fetch-archive.js";
import { handleDirFetch } from "./dir-fetch.js";
import { useFiles } from "./node-host.test-support.js";

const { at, dir: makeDir, file: makeFile, seed } = useFiles("dir-fetch-test-");

// dir-fetch needs /usr/bin/tar, unavailable on Windows CI.
const HAS_TAR = process.platform !== "win32";

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
  it.runIf(HAS_TAR).each(["alias", "inode"])("rejects changed tar %s binding", async (kind) => {
    const target = await makeDir("target");
    const stats = await fs.stat(target, { bigint: true });
    let requested = target;
    if (kind === "alias") {
      requested = at("current");
      await fs.symlink(await makeDir("second"), requested);
    } else {
      await fs.rename(target, at("moved"));
      await makeDir("target");
      await makeFile("target/secret.txt", "secret");
    }
    await expect(
      createTarArchive(requested, target, String(stats.dev), String(stats.ino), 1024 * 1024),
    ).resolves.toBe("CANONICAL_PATH_CHANGED");
  });

  it.runIf(HAS_TAR)("preflights directory entries without returning a tarball", async () => {
    await seed(["a.txt", ".ssh/id_rsa", "sub/b.txt", "c/z.txt", "c\u200d/a.txt"]);
    await fs.symlink("missing-target", at("dangling-link"));

    const r = await fetchDirectory({ path: at(), preflightOnly: true });
    expect(r).toMatchObject({
      path: at(),
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
      const first = at("first");
      const second = at("second");
      const link = at("current");
      await seed(["first/approved.txt", "second/not-approved.txt"]);
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
      await makeFile("valid.txt", "valid sibling");
      const nested = await makeDir("nested");
      await fs.writeFile(
        Buffer.concat([Buffer.from(`${nested}/`), Buffer.from([0xff])]),
        "unrepresentable filename",
      );

      const result = await handleDirFetch({ path: at(), preflightOnly: true });

      expect(result).toEqual({
        ok: false,
        code: "INVALID_PATH",
        message: expect.stringContaining("directory entry name is not valid UTF-8"),
        canonicalPath: at(),
      });
    },
  );

  it.runIf(HAS_TAR)(
    "rejects a replacement at the same canonical pathname before creating an archive",
    async () => {
      const target = await makeDir("target");
      const moved = at("moved");
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
    await seed(["a.txt", "b.txt", "sub/c.txt", ".root-note", ".hidden/note.txt"]);
    const r = await fetchDirectory({ path: at() });

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
    await makeFile("large.bin", crypto.randomBytes(1024 * 1024));

    await expectDirFetchError(
      { path: at(), maxBytes: 64 * 1024, preflightOnly: true },
      "TREE_TOO_LARGE",
    );
  });

  it.runIf(HAS_TAR)(
    "returns TREE_TOO_LARGE when content exceeds the cap mid-stream",
    async () => {
      // Write enough random content to exceed a small maxBytes. Random bytes
      // don't compress, so gzip output is roughly the same size as input.
      const big = crypto.randomBytes(512 * 1024);
      await seed(["big1.bin", "big2.bin", "big3.bin"], big);

      // 64KB cap should trip either the du preflight or the streaming SIGTERM.
      await expectDirFetchError({ path: at(), maxBytes: 64 * 1024 }, "TREE_TOO_LARGE");
    },
    30_000,
  );
});
