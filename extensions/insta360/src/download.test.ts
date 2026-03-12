import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFile } from "./download.js";

const mockFetch = vi.fn();

describe("downloadFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "insta360-dl-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("streams response body to file", async () => {
    const body = Readable.toWeb(Readable.from(Buffer.from("fake-image-data")));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body,
      headers: new Headers({ "content-length": "15" }),
    });

    const dest = path.join(tmpDir, "photo.jpg");
    const result = await downloadFile("http://192.168.42.1/DCIM/photo.jpg", dest);
    expect(result.bytesWritten).toBeGreaterThan(0);
    const content = await fs.readFile(dest, "utf8");
    expect(content).toBe("fake-image-data");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, body: null });
    const dest = path.join(tmpDir, "missing.jpg");
    await expect(downloadFile("http://192.168.42.1/DCIM/missing.jpg", dest)).rejects.toThrow("404");
  });
});
