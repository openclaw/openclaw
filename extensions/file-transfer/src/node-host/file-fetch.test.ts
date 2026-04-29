import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FILE_FETCH_DEFAULT_MAX_BYTES,
  FILE_FETCH_HARD_MAX_BYTES,
  handleFileFetch,
} from "./file-fetch.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "file-fetch-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("handleFileFetch — input validation", () => {
  it("returns INVALID_PATH for empty / non-string path", async () => {
    expect(await handleFileFetch({ path: "" })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
    expect(await handleFileFetch({ path: undefined })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
    expect(await handleFileFetch({ path: 42 as unknown })).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });

  it("rejects relative paths", async () => {
    const r = await handleFileFetch({ path: "relative/file.txt" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_PATH" });
    expect(r.ok ? "" : r.message).toMatch(/absolute/);
  });

  it("rejects paths with NUL bytes", async () => {
    const r = await handleFileFetch({ path: "/tmp/foo\0bar" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_PATH" });
    expect(r.ok ? "" : r.message).toMatch(/NUL/);
  });
});

describe("handleFileFetch — fs errors", () => {
  it("returns NOT_FOUND for a missing file", async () => {
    const target = path.join(tmpRoot, "missing.txt");
    expect(await handleFileFetch({ path: target })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("returns IS_DIRECTORY when the path resolves to a directory", async () => {
    const r = await handleFileFetch({ path: tmpRoot });
    expect(r).toMatchObject({ ok: false, code: "IS_DIRECTORY" });
    // canonical path is reported back so the caller can re-check policy
    expect(r.ok ? null : r.canonicalPath).toBeTruthy();
  });
});

describe("handleFileFetch — happy path", () => {
  it("reads a small file and returns size + sha256 + base64", async () => {
    const target = path.join(tmpRoot, "hello.txt");
    const contents = "hello world\n";
    await fs.writeFile(target, contents);

    const r = await handleFileFetch({ path: target });
    if (!r.ok) {
      throw new Error(`expected ok, got ${r.code}: ${r.message}`);
    }

    expect(r.size).toBe(contents.length);
    expect(Buffer.from(r.base64, "base64").toString("utf-8")).toBe(contents);
    const expectedSha = crypto.createHash("sha256").update(contents).digest("hex");
    expect(r.sha256).toBe(expectedSha);
    // canonicalized path may differ from input on macOS (/tmp -> /private/tmp)
    expect(path.basename(r.path)).toBe("hello.txt");
  });

  it("returns a sensible mime type for known extensions", async () => {
    const target = path.join(tmpRoot, "readme.md");
    await fs.writeFile(target, "# heading\n");

    const r = await handleFileFetch({ path: target });
    if (!r.ok) {
      throw new Error("expected ok");
    }
    // libmagic ("file" cli) typically reports text/plain or text/markdown for
    // a one-line markdown file; the extension fallback yields text/markdown.
    // Accept either.
    expect(r.mimeType).toMatch(/^text\/(plain|markdown)$/);
  });
});

describe("handleFileFetch — size enforcement", () => {
  it("returns FILE_TOO_LARGE when stat size exceeds the cap", async () => {
    const target = path.join(tmpRoot, "big.bin");
    const data = Buffer.alloc(2048, 0xab);
    await fs.writeFile(target, data);

    const r = await handleFileFetch({ path: target, maxBytes: 1024 });
    expect(r).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
  });

  it("clamps maxBytes to the hard ceiling", async () => {
    expect(FILE_FETCH_HARD_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(FILE_FETCH_DEFAULT_MAX_BYTES).toBeLessThanOrEqual(FILE_FETCH_HARD_MAX_BYTES);

    // A request asking for a maxBytes well above the hard ceiling should
    // still be honored for a small file (no error).
    const target = path.join(tmpRoot, "tiny.bin");
    await fs.writeFile(target, Buffer.from([0x01, 0x02, 0x03]));
    const r = await handleFileFetch({ path: target, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(r.ok).toBe(true);
  });

  it("uses default cap when maxBytes is not finite or non-positive", async () => {
    const target = path.join(tmpRoot, "small.bin");
    await fs.writeFile(target, Buffer.from([0xff]));
    expect(await handleFileFetch({ path: target, maxBytes: -1 })).toMatchObject({ ok: true });
    expect(await handleFileFetch({ path: target, maxBytes: Number.NaN })).toMatchObject({
      ok: true,
    });
    expect(await handleFileFetch({ path: target, maxBytes: "8" as unknown })).toMatchObject({
      ok: true,
    });
  });
});

describe("handleFileFetch — symlink canonicalization", () => {
  it("returns the canonical (realpath) target path, not the symlink path", async () => {
    const real = path.join(tmpRoot, "real.txt");
    const link = path.join(tmpRoot, "link.txt");
    await fs.writeFile(real, "data");
    await fs.symlink(real, link);

    const r = await handleFileFetch({ path: link });
    if (!r.ok) {
      throw new Error(`expected ok, got ${r.code}`);
    }
    // Both inputs canonicalize through the OS; just compare basenames + that
    // canonical resolution happened (path doesn't end with the symlink name).
    expect(path.basename(r.path)).toBe("real.txt");
  });
});
