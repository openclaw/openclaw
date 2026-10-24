import crypto from "node:crypto";
import fs from "node:fs/promises";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { assert, describe, expect, it, vi } from "vitest";
import { createTarArchive } from "./dir-fetch-archive.js";
import { handleDirFetch } from "./dir-fetch.js";
import { useFiles } from "./node-host.test-support.js";

const {
  at,
  dir: makeDir,
  file: makeFile,
  seed,
  replacement,
} = useFiles("dir-fetch-test-", vi.restoreAllMocks);

// dir-fetch needs /usr/bin/tar, unavailable on Windows CI.
const HAS_TAR = process.platform !== "win32";

async function fetchDirectory(input: Parameters<typeof handleDirFetch>[0]) {
  const result = await handleDirFetch(input);
  assert(result.ok, JSON.stringify(result));
  return result;
}

async function expectDirFetchError(input: Parameters<typeof handleDirFetch>[0], code: string) {
  const result = await handleDirFetch(input);
  expect(result).toMatchObject({ ok: false, code });
}

describe("handleDirFetch", () => {
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

  it.runIf(HAS_TAR).each(["symlink", "inode"] as const)(
    "rejects %s replacement after preflight",
    async (kind) => {
      const fixture = await replacement(kind, true);
      const params = { path: fixture.target, followSymlinks: true };
      const preflight = await fetchDirectory({ ...params, preflightOnly: true });
      await fixture.swap();
      const result = await handleDirFetch({
        ...params,
        expectedCanonicalPath: preflight.path,
        ...(kind === "inode" ? { expectedBinding: preflight.binding } : {}),
      });
      expect(result).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
      if (kind === "symlink") {
        expect(result).toEqual({
          ok: false,
          code: "CANONICAL_PATH_CHANGED",
          message: "resolved path differs from the authorized target",
          canonicalPath: fixture.canonical,
        });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects non-UTF-8 names without a partial preflight",
    async () => {
      await makeFile("valid.txt", "valid sibling");
      const nested = await makeDir("nested");
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
    await makeFile("large.bin", crypto.randomBytes(1024 * 1024));
    await expectDirFetchError({ path: at(), maxBytes: 64 * 1024, preflightOnly }, "TREE_TOO_LARGE");
  }
  it.runIf(HAS_TAR)("caps archive bytes during preflight", () => expectArchiveCap(true));
  it.runIf(HAS_TAR)("caps archive bytes mid-stream", () => expectArchiveCap(false), 30_000);
});

function commandResult(
  overrides: Partial<Awaited<ReturnType<typeof processRuntime.runCommandBuffered>>> = {},
) {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
    ...overrides,
  };
}

it("rejects preflight trees above the entry cap without starting tar", async () => {
  const command = vi.spyOn(processRuntime, "runCommandBuffered");
  await Promise.all(Array.from({ length: 5001 }, (_, i) => fs.writeFile(at(`file-${i}.txt`), "")));
  await expect(handleDirFetch({ path: at(), preflightOnly: true })).resolves.toMatchObject({
    ok: false,
    code: "TREE_TOO_LARGE",
    message: "directory tree exceeds 5000 entries during preflight",
  });
  expect(command).not.toHaveBeenCalled();
});

it("reclassifies a directory removed during archive preflight", async () => {
  await makeFile("ok.txt");
  const command = vi
    .spyOn(processRuntime, "runCommandBuffered")
    .mockImplementationOnce(async () => {
      await fs.rm(at(), { recursive: true, force: true });
      return commandResult({ code: 1 });
    });
  await expect(handleDirFetch({ path: at(), preflightOnly: true })).resolves.toMatchObject({
    ok: false,
    code: "NOT_FOUND",
    message: expect.stringContaining("stat failed:"),
    canonicalPath: at(),
  });
  expect(command).toHaveBeenCalledOnce();
});

it.each([
  ["invalid archive", "exit", 0, "READ_ERROR"],
  ["output cap", "output-limit", null, "TREE_TOO_LARGE"],
  ["timeout", "timeout", null, "READ_ERROR"],
  ["changed path", "exit", 78, "CANONICAL_PATH_CHANGED"],
  ["launch error", "error", null, "READ_ERROR"],
] as const)("classifies %s", async (label, termination, exitCode, code) => {
  await makeFile("ok.txt");
  const command = vi.spyOn(processRuntime, "runCommandBuffered");
  if (label === "launch error") {
    command.mockRejectedValueOnce(new Error("spawn failed"));
  } else {
    command.mockResolvedValueOnce(
      commandResult({
        termination,
        code: exitCode,
        stdout: Buffer.from("archive"),
        outputLimitStream: "stdout",
      }),
    );
  }
  await expect(
    handleDirFetch({ path: at(), maxBytes: 1024, preflightOnly: label === "launch error" }),
  ).resolves.toMatchObject({
    ok: false,
    code,
    canonicalPath: at(),
  });
  expect(command).toHaveBeenCalledOnce();
});
