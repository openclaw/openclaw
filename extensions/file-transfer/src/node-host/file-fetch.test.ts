import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { handleFileFetch } from "./file-fetch.js";
import { useFiles } from "./node-host.test-support.js";

const { at, file: makeFile } = useFiles("file-fetch-test-", vi.restoreAllMocks);
type FetchResult = Awaited<ReturnType<typeof handleFileFetch>>;
function expectFailureCode(
  result: FetchResult,
  code: string,
): asserts result is Extract<FetchResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}
function expectSuccess(result: FetchResult): asserts result is Extract<FetchResult, { ok: true }> {
  expect(result.ok).toBe(true);
}
async function fetchFile(name: string, content: string | Buffer) {
  const result = await handleFileFetch({ path: await makeFile(name, content) });
  expectSuccess(result);
  return result;
}
describe("handleFileFetch", () => {
  it("rejects relative paths", async () => {
    const r = await handleFileFetch({ path: "relative/file.txt" });
    expectFailureCode(r, "INVALID_PATH");
    expect(r.message).toMatch(/absolute/);
  });

  it("rejects paths with NUL bytes", async () => {
    const r = await handleFileFetch({ path: "/tmp/foo\0bar" });
    expectFailureCode(r, "INVALID_PATH");
    expect(r.message).toMatch(/NUL/);
  });
  it("returns IS_DIRECTORY when the path resolves to a directory", async () => {
    const r = await handleFileFetch({ path: at() });
    expectFailureCode(r, "IS_DIRECTORY");
    expect(r.canonicalPath).toBe(at());
  });
  it("fetches an empty image-named file with extension-derived MIME", async () => {
    expect(await fetchFile("empty.png", "")).toMatchObject({
      size: 0,
      mimeType: "image/png",
      base64: "",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });
  it.runIf(process.platform !== "win32")(
    "rejects a retargeted path before reading file bytes",
    async () => {
      const first = at("first.txt");
      const second = at("second.txt");
      const link = at("current.txt");
      await fs.writeFile(first, "approved");
      await fs.writeFile(second, "not approved");
      await fs.symlink(first, link);

      const preflight = await handleFileFetch({
        path: link,
        followSymlinks: true,
        preflightOnly: true,
      });
      expectSuccess(preflight);
      await fs.unlink(link);
      await fs.symlink(second, link);

      const result = await handleFileFetch({
        path: link,
        followSymlinks: true,
        expectedCanonicalPath: preflight.path,
      });

      expectFailureCode(result, "CANONICAL_PATH_CHANGED");
      expect(result.canonicalPath).toBe(second);
    },
  );

  it("rejects a replacement at the same canonical pathname before reading bytes", async () => {
    const target = at("target.txt");
    const moved = at("moved.txt");
    await fs.writeFile(target, "approved");
    const readFileSpy = vi.spyOn(fs, "readFile");
    const preflight = await handleFileFetch({ path: target, preflightOnly: true });
    expectSuccess(preflight);
    expect(preflight).toMatchObject({ base64: "", sha256: "", preflightOnly: true });
    expect(readFileSpy).not.toHaveBeenCalled();
    await fs.rename(target, moved);
    await fs.writeFile(target, "not approved");

    const result = await handleFileFetch({
      path: target,
      expectedCanonicalPath: preflight.path,
      expectedBinding: preflight.binding,
    });

    expectFailureCode(result, "CANONICAL_PATH_CHANGED");
    expect(await fs.readFile(target, "utf8")).toBe("not approved");
  });

  it("detects extensionless plain text as text/plain", async () => {
    const contents = "Permission is hereby granted\n";
    const r = await fetchFile("LICENSE", contents);
    expect(r.mimeType).toBe("text/plain");
    expect(Buffer.from(r.base64, "base64").toString("utf-8")).toBe(contents);
  });

  it("does not classify extensionless binary content as text/plain", async () => {
    const r = await fetchFile("opaque", Buffer.from([0x00, 0x01, 0x02, 0xff]));
    expect(r.mimeType).toBe("application/octet-stream");
  });
  it("bounds bytes consumed when a file grows after the size check", async () => {
    const target = await makeFile("growing.txt", "small");
    const realOpen = fs.open.bind(fs);
    let bytesRead = 0;
    let grown = false;
    const grow = async () => {
      if (!grown) {
        grown = true;
        await fs.appendFile(target, Buffer.alloc(1024));
      }
    };
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      if (String(file) === target) {
        const read = handle.read.bind(handle);
        const readFile = handle.readFile.bind(handle);
        // Keep real filesystem reads; append only after the handler has checked size.
        handle.read = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          await grow();
          const result = await read(buffer, offset, length, position);
          bytesRead += result.bytesRead;
          return result;
        }) as typeof handle.read;
        handle.readFile = (async (...args: Parameters<typeof handle.readFile>) => {
          await grow();
          const result = await readFile(...args);
          bytesRead += Buffer.byteLength(result);
          return result;
        }) as typeof handle.readFile;
      }
      return handle;
    });

    expectFailureCode(await handleFileFetch({ path: target, maxBytes: 8 }), "FILE_TOO_LARGE");
    expect(grown).toBe(true);
    expect(bytesRead).toBeGreaterThan(8);
    expect(bytesRead).toBeLessThanOrEqual(9);
  });

  it("clamps maxBytes to the hard ceiling", async () => {
    const target = await makeFile("oversized.bin", "");
    await fs.truncate(target, 16 * 1024 * 1024 + 1);

    const r = await handleFileFetch({ path: target, maxBytes: Number.MAX_SAFE_INTEGER });
    expectFailureCode(r, "FILE_TOO_LARGE");
    expect(r.message).toContain("limit 16777216");
  });

  it("uses default cap when maxBytes is not finite or non-positive", async () => {
    const target = await makeFile("above-default.bin", "");
    await fs.truncate(target, 8 * 1024 * 1024 + 1);

    for (const maxBytes of [-1, Number.NaN, "8"] as unknown[]) {
      const r = await handleFileFetch({ path: target, maxBytes });
      expectFailureCode(r, "FILE_TOO_LARGE");
      expect(r.message).toContain("limit 8388608");
    }
  });
  it("refuses to follow a symlink by default (SYMLINK_REDIRECT)", async () => {
    const real = at("real.txt");
    const link = at("link.txt");
    await fs.writeFile(real, "data");
    await fs.symlink(real, link);

    const r = await handleFileFetch({ path: link });
    expectFailureCode(r, "SYMLINK_REDIRECT");
    expect(r.canonicalPath).toBe(real);
  });
});
