import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withWorldIdCoreFileFetchCompat } from "./world-id.runtime.js";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("world id runtime", () => {
  it("does not make arbitrary file URLs readable through global fetch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agentkit-world-id-fetch-"));
    tempDirs.push(dir);
    const secretPath = path.join(dir, "secret.txt");
    await writeFile(secretPath, "secret");
    const nativeFetch = vi.fn(async () => new Response("native", { status: 418 }));
    globalThis.fetch = nativeFetch as unknown as typeof fetch;

    const response = await withWorldIdCoreFileFetchCompat(async () =>
      fetch(pathToFileURL(secretPath)),
    );

    expect(await response.text()).toBe("native");
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toBe(nativeFetch);
  });

  it("restores global fetch after failures", async () => {
    const nativeFetch = vi.fn(async () => new Response("native"));
    globalThis.fetch = nativeFetch as unknown as typeof fetch;

    await expect(
      withWorldIdCoreFileFetchCompat(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(globalThis.fetch).toBe(nativeFetch);
  });
});
