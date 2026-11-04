import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { FILE_CREATE_CHUNK_BYTES } from "../shared/file-create-protocol.js";
import { FILE_FETCH_CHUNK_BYTES } from "../shared/file-fetch-protocol.js";
import { handleDirFetch } from "./dir-fetch.js";
import { createCanonicalDirListCommand } from "./dir-list-worker-command.js";
import { handleDirList } from "./dir-list.js";
import { handleFileCreate } from "./file-create.js";
import { handleFileFetch } from "./file-fetch.js";
import * as fileWrite from "./file-write-path.js";
import { handleFileWrite } from "./file-write.js";
import { duplexPeer, observeFileOpen, useFiles } from "./node-host.test-support.js";

const { at, dir: mkdir, file: put, replacement, seed } = useFiles("file-io-", vi.restoreAllMocks);

type WriteOptions = Parameters<typeof handleFileWrite>[0];
function write(target: string, content: string | Buffer, options: WriteOptions = {}) {
  return handleFileWrite(writeParams(target, content, options));
}
const writeParams = (target: string, content: string | Buffer, options: WriteOptions) => ({
  path: target,
  contentBase64: Buffer.from(content).toString("base64"),
  ...options,
});
async function bindWrite(target: string, content: string | Buffer, options: WriteOptions = {}) {
  const preflight = await write(target, content, { ...options, preflightOnly: true });
  assert(preflight.ok);
  return {
    ...writeParams(target, content, options),
    expectedCanonicalPath: preflight.path,
    expectedBinding: preflight.binding,
  };
}

async function expectFailure(result: Promise<unknown>, code: string, fields = {}) {
  await expect(result).resolves.toMatchObject({ ok: false, code, ...fields });
}

function expectOk(result: unknown, fields: Record<string, unknown> = {}) {
  expect(result).toMatchObject({ ok: true, ...fields });
}

async function expectAccessMissing(target: string) {
  await expect(fs.access(target)).rejects.toHaveProperty("code", "ENOENT");
}

it.each([
  ["write", "leaf", false, "SYMLINK_REDIRECT"],
  ["write", "leaf", true, "SYMLINK_TARGET_DENIED"],
  ["write", "parent", false, "SYMLINK_REDIRECT"],
  ["create", "leaf", false, undefined],
  ["create", "leaf", true, undefined],
  ["create", "parent", false, undefined],
] as const)(
  "rejects %s through a %s symlink (follow=%s)",
  async (command, kind, followSymlinks, code) => {
    const real = await put("real/file", "untouched");
    const link = at("alias");
    await fs.symlink(kind === "parent" ? path.dirname(real) : real, link);
    const target = kind === "parent" ? path.join(link, "new", "child") : link;
    const params = {
      ...writeParams(target, "payload", {}),
      ...metadata(target, Buffer.from("payload")),
      overwrite: true,
      createParents: true,
      followSymlinks,
    };
    const peer = receiver();
    const result =
      command === "write"
        ? await handleFileWrite(params)
        : await handleFileCreate({ ...params, preflightOnly: true }, peer.io);
    expect(result).toMatchObject({ ok: false, ...(code ? { code } : {}) });
    if (code === "SYMLINK_REDIRECT") {
      expect(result).toMatchObject({
        canonicalPath: kind === "parent" ? at("real/new/child") : real,
      });
    }
    if (command === "create") {
      expect(peer.onMessage).not.toHaveBeenCalled();
    }
    if (kind === "parent") {
      await expectAccessMissing(at("real/new"));
    }
    expect(await fs.readFile(real, "utf8")).toBe("untouched");
  },
);

const fileCommands = { write: handleFileWrite, fetch: handleFileFetch };
it.each(
  (
    [
      ["write", "symlink"],
      ["fetch", "symlink"],
      ["write", "inode"],
      ["fetch", "inode"],
    ] as const
  ).filter(([, kind]) => kind !== "symlink" || process.platform !== "win32"),
)("rejects a changed %s %s binding", async (command, kind) => {
  const { target, canonical, original, swap } = await replacement(kind);
  const params = writeParams(target, "unapproved write", { overwrite: true, followSymlinks: true });
  const preflight = await fileCommands[command]({ ...params, preflightOnly: true });
  assert(preflight.ok);
  await swap();
  await expectFailure(
    fileCommands[command]({
      ...params,
      expectedCanonicalPath: preflight.path,
      ...(kind === "inode" ? { expectedBinding: preflight.binding } : {}),
    }),
    "CANONICAL_PATH_CHANGED",
    kind === "symlink" ? { canonicalPath: canonical } : {},
  );
  expect(await fs.readFile(original, "utf8")).toBe("approved");
  expect(await fs.readFile(canonical, "utf8")).toBe("not approved");
});

describe("handleFileWrite", () => {
  it.each(["", "relative.txt", "/tmp/foo\0bar"])("rejects invalid path %j", async (target) => {
    await expectFailure(write(target, "x"), "INVALID_PATH");
  });

  it("requires contentBase64 but allows an empty encoded payload", async () => {
    await expectFailure(handleFileWrite({ path: at("missing.bin") }), "INVALID_BASE64");

    const target = at("deep", "nested", "empty.bin");
    expectOk(await write(target, "", { createParents: true }), {
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
      expectOk(await write(target, "published"), { path: target, size: 9 });
      assert(observed, "expected a real handle for the published file");
      await expect(observed.stat()).rejects.toMatchObject({ code: "EBADF" });
      await expect(fs.readFile(target, "utf8")).resolves.toBe("published");
    } finally {
      openSpy.mockRestore();
      await observed?.close();
    }
  });
  it.each([false, true])("honors overwrite=%s", async (overwrite) => {
    const target = await put("exists.txt", "before");
    const result = write(target, "after", { overwrite });
    if (overwrite) {
      expectOk(await result, { overwritten: true });
    } else {
      await expectFailure(result, "EXISTS_NO_OVERWRITE");
    }
    expect(await fs.readFile(target, "utf-8")).toBe(overwrite ? "after" : "before");
  });
  it("requires createParents for a missing parent", async () => {
    await expectFailure(write(at("deep", "child.txt"), "x"), "PARENT_NOT_FOUND");
  });
  it("preflights a canonical write without creating parents", async () => {
    const realDir = await mkdir("real-dir");
    const allowed = at("allowed");
    await fs.symlink(realDir, allowed);

    const result = write(path.join(allowed, "new", "child.txt"), "payload", {
      createParents: true,
      followSymlinks: true,
      preflightOnly: true,
    });

    expectOk(await result, { path: path.join(realDir, "new", "child.txt"), size: 7 });
    await expectAccessMissing(path.join(realDir, "new"));
  });

  it("checks hard links on the bound write handle after path validation", async () => {
    const target = await put("target.txt", "before");
    const alias = at("outside-alias.txt");
    const authorized = await bindWrite(target, "after", {
      overwrite: true,
      rejectHardlinks: true,
    });
    observeFileOpen(async (_handle, file, flags) => {
      if (file === target && flags === "r+") {
        await fs.link(target, alias);
      }
    });
    await expectFailure(handleFileWrite(authorized), "HARDLINK_TARGET_DENIED");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("before");
    await expect(fs.readFile(alias, "utf8")).resolves.toBe("before");
  });

  it("preserves the preflight-bound inode and hardlinks", async () => {
    const content = "after";
    const target = await put("target.txt", "before");
    const alias = at("alias.txt");
    await fs.link(target, alias);
    const identity = await fs.stat(target, { bigint: true });
    const authorized = await bindWrite(target, content, { overwrite: true });

    expectOk(await handleFileWrite(authorized), {
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
      const parent = await mkdir("parent");
      const target = path.join(parent, "new.txt");
      const authorized = await bindWrite(target, "next");
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
        expectOk(await result, { path: target, size: 4 });
        await expect(fs.readFile(target, "utf8")).resolves.toBe("next");
      }
    },
  );

  it("refuses to overwrite a directory", async () => {
    await expectFailure(write(await mkdir("is-a-dir"), "x", { overwrite: true }), "IS_DIRECTORY");
  });
  it("preserves content on hash mismatch", async () => {
    const target = await put("victim.txt", "ORIGINAL_CONTENT_DO_NOT_TOUCH");
    await expectFailure(
      write(target, "attacker-content", { overwrite: true, expectedSha256: "0".repeat(64) }),
      "INTEGRITY_FAILURE",
    );
    expect(await fs.readFile(target, "utf-8")).toBe("ORIGINAL_CONTENT_DO_NOT_TOUCH");
  });
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
    const target = await put("victim.bin", original);
    const payload = Buffer.alloc(stage === "extension" ? 8192 : 4096, 0x62);
    const authorized = await bindWrite(target, payload, { overwrite: true });
    let failed = false;
    observeFileOpen((handle, file, flags) => {
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

    expect(await fs.readFile(target)).toEqual(original);
  });
});

describe("handleFileFetch", () => {
  it.each([
    ["relative/file.txt", /absolute/],
    ["/tmp/foo\0bar", /NUL/],
  ])("rejects invalid path %j", async (requestedPath, message) => {
    await expectFailure(handleFileFetch({ path: requestedPath }), "INVALID_PATH", {
      message: expect.stringMatching(message),
    });
  });
  it("returns IS_DIRECTORY when the path resolves to a directory", async () => {
    await expectFailure(handleFileFetch({ path: at() }), "IS_DIRECTORY", { canonicalPath: at() });
  });
  it.each([
    ["empty.png", "", "image/png"],
    ["LICENSE", "Permission is hereby granted\n", "text/plain"],
    ["opaque", Buffer.from([0x00, 0x01, 0x02, 0xff]), "application/octet-stream"],
  ])("fetches %s with detected MIME and exact bytes", async (name, content, mimeType) => {
    const peer = duplexPeer();
    const result = await handleFileFetch({ path: await put(name, content) }, peer.io);
    assert(result.ok);
    expect(result).not.toHaveProperty("transport");
    expect(peer.send).not.toHaveBeenCalled();
    expect(peer.onMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mimeType,
      size: Buffer.byteLength(content),
      base64: Buffer.from(content).toString("base64"),
    });
    if (name === "empty.png") {
      expect(result.sha256).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    }
  });
  it.each([
    ["hard", [Number.MAX_SAFE_INTEGER], 16 * 1024 * 1024],
    ["default", [-1, Number.NaN, "8"], 8 * 1024 * 1024],
  ] as const)("enforces the %s byte limit", async (_kind, budgets, limit) => {
    const target = await put("oversized.bin", "");
    await fs.truncate(target, limit + 1);
    for (const maxBytes of budgets) {
      await expectFailure(handleFileFetch({ path: target, maxBytes }), "FILE_TOO_LARGE", {
        message: expect.stringContaining(`limit ${limit}`),
      });
    }
  });
  it("refuses to follow a symlink by default (SYMLINK_REDIRECT)", async () => {
    const real = await put("real.txt", "data");
    const link = at("link.txt");
    await fs.symlink(real, link);

    await expectFailure(handleFileFetch({ path: link }), "SYMLINK_REDIRECT", {
      canonicalPath: real,
    });
  });
});
async function binaryFixture(bytes = Buffer.from("output")) {
  const target = await put("output.bin", bytes);
  const params = { path: target, transport: "binary", maxBytes: bytes.length };
  const preflight = await handleFileFetch({ ...params, preflightOnly: true });
  assert(preflight.ok, JSON.stringify(preflight));
  const peer = duplexPeer();
  const chunks: Buffer[] = [];
  peer.send.mockImplementation(async (message) => {
    expect(message.byteLength).toBeLessThanOrEqual(FILE_FETCH_CHUNK_BYTES);
    chunks.push(Buffer.from(message));
    await peer.receive(Buffer.from("ack"));
  });
  const { binding: expectedBinding, path: expectedCanonicalPath } = preflight;
  const send = (control: string) => peer.receive(Buffer.from(control));
  const start = () =>
    handleFileFetch({ ...params, expectedBinding, expectedCanonicalPath }, peer.io);
  return { ...peer, target, bytes, preflight, chunks, send, start };
}

it("preflights without a stream and sends bounded chunks from the authorized handle after START", async () => {
  const value = await binaryFixture(Buffer.alloc(17 * 1024 * 1024, 0x5a));
  expect(value.preflight).toMatchObject({ preflightOnly: true, base64: "", sha256: "" });
  const pending = value.start();
  await value.ready;
  expect(value.chunks).toHaveLength(0);
  await fs.rename(value.target, `${value.target}.old`);
  await fs.writeFile(value.target, "other");
  await value.send("start");
  expect(await pending).toMatchObject({
    ok: true,
    transport: "binary",
    base64: "",
    size: value.bytes.length,
    sha256: crypto.createHash("sha256").update(value.bytes).digest("hex"),
  });
  expect(Buffer.concat(value.chunks).equals(value.bytes)).toBe(true);
  await expect(value.send("ack")).rejects.toThrow("No receiver");
});

it.each(["unary growth", "binary growth", "binary cancellation"] as const)(
  "bounds reads and closes handles after %s",
  async (mode) => {
    const binary = mode !== "unary growth",
      grow = mode !== "binary cancellation";
    const limit = binary ? FILE_FETCH_CHUNK_BYTES : 8;
    const value = await binaryFixture(Buffer.alloc(limit));
    const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
    let bytesRead = 0,
      grown = false;
    observeFileOpen((handle, file) => {
      handles.push(handle);
      if (String(file) !== value.target) {
        return;
      }
      const read = handle.read.bind(handle);
      handle.read = (async (...args: Parameters<typeof read>) => {
        if (grow && !grown) {
          grown = true;
          await fs.appendFile(value.target, Buffer.alloc(1024));
        }
        const result = await read(...args);
        bytesRead += result.bytesRead;
        return result;
      }) as typeof handle.read;
    });
    const outcome = binary
      ? value.start()
      : handleFileFetch({ path: value.target, maxBytes: limit });
    if (binary) {
      await value.ready;
      if (grow) {
        await value.send("start");
      } else {
        value.controller.abort(new Error("revoked"));
      }
    }
    await expectFailure(outcome, grow ? "FILE_TOO_LARGE" : "READ_ERROR");
    expect(grown).toBe(grow);
    expect(bytesRead).toBe(grow ? limit + 1 : 0);
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    }
    if (binary) {
      await expect(value.send("start")).rejects.toThrow("No receiver");
      expect(Buffer.concat(value.chunks)).toHaveLength(grow ? limit : 0);
      if (!grow) {
        expect(value.chunks).toHaveLength(0);
      }
    }
  },
);

it.each([undefined, -1, Number.MAX_SAFE_INTEGER + 1])("invalid budget: %s", async (maxBytes) => {
  await expectFailure(
    handleFileFetch({ path: "/unused", transport: "binary", maxBytes }),
    "INVALID_PARAMS",
  );
});

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

describe("handleDirList", () => {
  it("rejects a missing directory path", async () => {
    expect(await handleDirList({ path: undefined })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });
  it.each(["valid", "malformed", "write", "device", "inode"] as const)(
    "preflights a %s directory binding",
    async (kind) => {
      await put("private.txt", "secret");
      const stats = await fs.stat(at(), { bigint: true });
      const binding = { kind: "existing", device: String(stats.dev), inode: String(stats.ino) };
      const expectedBinding =
        kind === "valid"
          ? { ...binding, extra: "ignored" }
          : kind === "malformed"
            ? null
            : kind === "write"
              ? { kind, anchorPath: at(), anchorDevice: binding.device, anchorInode: binding.inode }
              : { ...binding, [kind]: "different" };
      const result = await handleDirList({ path: at(), preflightOnly: true, expectedBinding });
      if (kind === "valid") {
        expectOk(result, { path: at(), entries: [], truncated: false, preflight: true, binding });
      } else {
        expect(result).toMatchObject({
          ok: false,
          code: "CANONICAL_PATH_CHANGED",
          canonicalPath: at(),
        });
      }
    },
  );
  it("preserves path and directory errors before validating the binding", async () => {
    await expectFailure(handleDirList({ path: at("missing"), expectedBinding: null }), "NOT_FOUND");
    const file = await put("file.txt", "keep");
    await expectFailure(handleDirList({ path: file, expectedBinding: null }), "IS_FILE", {
      canonicalPath: file,
    });
    await expectFailure(
      handleDirList({ path: file, expectedCanonicalPath: at(), expectedBinding: null }),
      "CANONICAL_PATH_CHANGED",
      { canonicalPath: file },
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
  it.runIf(process.platform === "linux").each(["before", "after"] as const)(
    "binds enumeration across replacement %s chdir",
    async (stage) => {
      const fixture = await replacement(stage === "before" ? "inode" : "symlink", true);
      await seed(["first/item/approved.txt", "second/item/secret.txt"]);
      const command = await listingCommand(fixture.target, at("first/item"));
      let preload = "";
      if (stage === "before") {
        await fixture.swap();
      } else {
        // Retarget immediately after real chdir, before the worker validates cwd.
        preload = `(() => {
        const fs = require("node:fs");
        const chdir = process.chdir;
        process.chdir = (directory) => {
          chdir(directory);
          process.chdir = chdir;
          fs.unlinkSync(${JSON.stringify(at("current"))});
          fs.symlinkSync(${JSON.stringify(at("second"))}, ${JSON.stringify(at("current"))});
        };
      })();`;
      }
      const stdout = await runWorker(command, preload, stage === "before" ? 78 : 0);
      if (stage === "before") {
        expect(stdout).toHaveLength(0);
      } else {
        expect(await fs.readlink(at("current"))).toBe(at("second"));
        const result = JSON.parse(stdout) as { entries: Array<{ name: string }> };
        expect(result.entries.map((entry) => entry.name)).toEqual(["approved.txt"]);
      }
    },
  );

  it("lists files and subdirs with metadata, sorted by name", async () => {
    await seed([".hidden", "a.png"]);
    await mkdir("subdir");

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

const digest = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const metadata = (target: string, data: Buffer = Buffer.from("x")) => ({
  path: target,
  sizeBytes: data.length,
  expectedSha256: digest(data),
});

function receiver() {
  const peer = duplexPeer();
  peer.send.mockImplementation(async (message) => {
    expect(Buffer.from(message).toString()).toBe("ack");
  });
  return peer;
}

async function upload(data = Buffer.from("data"), target = at("file")) {
  const params = { ...metadata(target, data), createParents: true, followSymlinks: false };
  const preflightPeer = receiver();
  const preflight = await handleFileCreate({ ...params, preflightOnly: true }, preflightPeer.io);
  assert(preflight.ok && preflight.binding.kind === "write");
  expect(preflightPeer.onMessage).not.toHaveBeenCalled();
  const bound = {
    ...params,
    expectedCanonicalPath: preflight.path,
    expectedBinding: preflight.binding,
  };
  const peer = receiver();
  return { target, data, peer, start: () => handleFileCreate(bound, peer.io) };
}

describe("file.create duplex command", () => {
  it("accepts the next chunk before the previous ACK settles", async () => {
    const { data, target, peer, start } = await upload(
      Buffer.alloc(2 * FILE_CREATE_CHUNK_BYTES, 0x6a),
      at("inputs/large.bin"),
    );
    expect(await fs.readdir(at())).toEqual([]);
    const outcome = start();
    await Promise.race([peer.ready, outcome]);
    peer.send.mockImplementationOnce(async (message) => {
      expect(Buffer.from(message).toString()).toBe("ack");
      await peer.receive(data.subarray(FILE_CREATE_CHUNK_BYTES));
    });
    await peer.receive(data.subarray(0, FILE_CREATE_CHUNK_BYTES));
    await peer.receive(Buffer.alloc(0));
    expect(await outcome).toMatchObject({
      ok: true,
      status: "created",
      path: target,
      size: data.length,
      sha256: digest(data),
    });
    expect(peer.send).toHaveBeenCalledTimes(2);
    expect(digest(await fs.readFile(target))).toBe(digest(data));
  });

  it("does not attribute an upload digest to an existing file", async () => {
    const target = await put("edited", "user edit");
    const { data, peer, start } = await upload(Buffer.from("upload"), target);
    const outcome = start();
    await Promise.race([peer.ready, outcome]);
    await peer.receive(data);
    await peer.receive(Buffer.alloc(0));
    const result = await outcome;
    expect(result).toMatchObject({ ok: true, status: "exists", path: target });
    expect(result).not.toHaveProperty("sha256");
    expect(await fs.readFile(target, "utf8")).toBe("user edit");
  });

  it.each([false, true])("rejects parent replacement duringReceive=%s", async (duringReceive) => {
    const parent = await mkdir("parent");
    const { data, peer, start } = await upload(Buffer.from("data"), path.join(parent, "file"));
    const receiving = duringReceive ? start().catch((error: unknown) => error) : undefined;
    if (duringReceive) {
      await peer.ready;
      await peer.receive(data);
    }
    await fs.rename(parent, `${parent}-old`);
    await fs.mkdir(parent);
    if (duringReceive) {
      await peer.receive(Buffer.alloc(0));
    }
    const result = await (receiving ?? start());
    expect(result).not.toMatchObject({ ok: true });
    if (!duringReceive) {
      expect(result).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
      expect(peer.onMessage).not.toHaveBeenCalled();
    }
    expect(await fs.readdir(parent)).toEqual([]);
    expect(await fs.readdir(`${parent}-old`)).toEqual([]);
  });

  it.each(["cancel", "digest", "size", "chunk"])(
    "leaves no published file after %s failure",
    async (failure) => {
      const { data, peer, start } = await upload();
      const outcome = start();
      const rejected = expect(outcome).rejects.toThrow();
      await peer.ready;
      if (failure === "cancel") {
        await peer.receive(data.subarray(0, 1));
        peer.controller.abort(new Error("source revoked"));
      } else if (failure === "chunk") {
        await peer.receive(Buffer.alloc(FILE_CREATE_CHUNK_BYTES + 1));
      } else {
        await peer.receive(failure === "size" ? data.subarray(0, 1) : Buffer.from("nope"));
        await peer.receive(Buffer.alloc(0));
      }
      await rejected;
      expect(await fs.readdir(at())).toEqual([]);
    },
  );

  it("cleans an unpublished fs-safe stage when cancelled during file writing", async () => {
    const { data, peer, start } = await upload(Buffer.alloc(2 * FILE_CREATE_CHUNK_BYTES, 0x42));
    const original = fileWrite.openBoundWriteRoot;
    vi.spyOn(fileWrite, "openBoundWriteRoot").mockImplementationOnce(async (input) => {
      const result = await original(input);
      if (result.ok) {
        const create = result.anchorRoot.create.bind(result.anchorRoot);
        vi.spyOn(result.anchorRoot, "create").mockImplementation(
          async (relativePath, chunks, options) => {
            async function* abortAfterChunk() {
              for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
                yield chunk;
                peer.controller.abort(new Error("cancel publication"));
              }
            }
            await create(relativePath, abortAfterChunk(), options);
          },
        );
      }
      return result;
    });
    const outcome = start();
    const rejected = expect(outcome).rejects.toThrow("cancel publication");
    await peer.ready;
    await peer.receive(data.subarray(0, FILE_CREATE_CHUNK_BYTES));
    await peer.receive(data.subarray(FILE_CREATE_CHUNK_BYTES));
    await peer.receive(Buffer.alloc(0));
    await rejected;
    expect(await fs.readdir(at())).toEqual([]);
  });

  it("rejects missing binding and oversized metadata without subscribing", async () => {
    const peer = receiver();
    const params = metadata(at("file"));
    expect(await handleFileCreate(params, peer.io)).toMatchObject({
      ok: false,
      code: "CANONICAL_PATH_CHANGED",
    });
    expect(await handleFileCreate({ ...params, maxBytes: 0 }, peer.io)).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(peer.onMessage).not.toHaveBeenCalled();
  });
});
