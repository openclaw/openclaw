import crypto from "node:crypto";
import fs from "node:fs/promises";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { assert, expect, it, vi } from "vitest";
import { createTarArchive } from "./dir-fetch-archive.js";
import { handleDirFetch } from "./dir-fetch.js";
import { useFiles } from "./node-host.test-support.js";

const { at, dir, file, seed, replacement } = useFiles("dir-fetch-test-", vi.restoreAllMocks);

// dir-fetch needs /usr/bin/tar, unavailable on Windows CI.
const HAS_TAR = process.platform !== "win32";

type FetchParams = Parameters<typeof handleDirFetch>[0];
async function expectDirFetchError(code: string, input: FetchParams = {}, fields = {}) {
  expect(await handleDirFetch({ path: at(), ...input })).toMatchObject({
    ok: false,
    code,
    ...fields,
  });
}

it.runIf(HAS_TAR)("preflights directory entries without returning a tarball", async () => {
  await seed(["a.txt", ".ssh/id_rsa", "sub/b.txt", "c/z.txt", "c\u200d/a.txt"]);
  await fs.symlink("missing-target", at("dangling-link"));

  const r = await handleDirFetch({ path: at(), preflightOnly: true });
  assert(r.ok, JSON.stringify(r));
  expect(r).toMatchObject({
    path: at(),
    tarBase64: "",
    tarBytes: 0,
    sha256: "",
    preflightOnly: true,
    fileCount: 10,
  });
  expect(r.entries).toEqual(
    ".ssh .ssh/id_rsa a.txt c c/z.txt c\u200d c\u200d/a.txt dangling-link sub sub/b.txt".split(" "),
  );
});

it.runIf(HAS_TAR).each(["symlink", "inode"] as const)(
  "rejects changed %s bindings",
  async (kind) => {
    const fixture = await replacement(kind, true);
    const params = { path: fixture.target, followSymlinks: true };
    const canonical = await fs.realpath(fixture.target);
    const { dev, ino } = await fs.stat(canonical, { bigint: true });
    const preflight = await handleDirFetch({ ...params, preflightOnly: true });
    assert(preflight.ok, JSON.stringify(preflight));
    await fixture.swap();
    await expect(
      createTarArchive(fixture.target, canonical, String(dev), String(ino), 1024 * 1024),
    ).resolves.toBe("CANONICAL_PATH_CHANGED");
    await expectDirFetchError(
      "CANONICAL_PATH_CHANGED",
      {
        ...params,
        expectedCanonicalPath: preflight.path,
        ...(kind === "inode" ? { expectedBinding: preflight.binding } : {}),
      },
      kind === "symlink" ? { canonicalPath: fixture.canonical } : {},
    );
  },
);
it.runIf(process.platform === "linux")(
  "rejects non-UTF-8 names without a partial preflight",
  async () => {
    await file("valid.txt", "valid sibling");
    const nested = await dir("nested");
    await fs.writeFile(
      Buffer.concat([Buffer.from(`${nested}/`), Buffer.from([0xff])]),
      "unrepresentable filename",
    );

    expect(await handleDirFetch({ path: at(), preflightOnly: true })).toEqual({
      ok: false,
      code: "INVALID_PATH",
      message: expect.stringContaining("directory entry name is not valid UTF-8"),
      canonicalPath: at(),
    });
  },
);

async function expectArchiveCap(preflightOnly: boolean) {
  await file("large.bin", crypto.randomBytes(1024 * 1024));
  await expectDirFetchError("TREE_TOO_LARGE", { maxBytes: 64 * 1024, preflightOnly });
}
it.runIf(HAS_TAR)("caps archive bytes during preflight", () => expectArchiveCap(true));
it.runIf(HAS_TAR)("caps archive bytes mid-stream", () => expectArchiveCap(false), 30_000);

it("rejects preflight trees above the entry cap without starting tar", async () => {
  const command = vi.spyOn(processRuntime, "runCommandBuffered");
  await Promise.all(Array.from({ length: 5001 }, (_, i) => fs.writeFile(at(`file-${i}.txt`), "")));
  await expectDirFetchError("TREE_TOO_LARGE", { preflightOnly: true });
  expect(command).not.toHaveBeenCalled();
});

it.each([
  ["invalid archive", "exit", 0, "READ_ERROR"],
  ["output cap", "output-limit", null, "TREE_TOO_LARGE"],
  ["timeout", "timeout", null, "READ_ERROR"],
  ["changed path", "exit", 78, "CANONICAL_PATH_CHANGED"],
  ["launch error", "error", null, "READ_ERROR"],
  ["removed directory", "exit", 1, "NOT_FOUND"],
] as const)("classifies %s", async (label, termination, exitCode, code) => {
  await file("ok.txt");
  vi.spyOn(processRuntime, "runCommandBuffered").mockImplementationOnce(async () => {
    if (label === "launch error") {
      throw new Error("spawn failed");
    }
    if (label === "removed directory") {
      await fs.rm(at(), { recursive: true, force: true });
    }
    return {
      termination,
      code: exitCode,
      stdout: Buffer.from("archive"),
      stderr: Buffer.alloc(0),
      signal: null,
      killed: false,
      outputLimitStream: "stdout",
    };
  });
  const preflightOnly = label === "launch error" || label === "removed directory";
  const fields = code === "NOT_FOUND" ? { message: expect.stringContaining("stat failed:") } : {};
  await expectDirFetchError(
    code,
    { maxBytes: 1024, preflightOnly },
    { canonicalPath: at(), ...fields },
  );
});
