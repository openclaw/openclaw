// Signal installer download proof tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/setup-tools", () => ({
  CONFIG_DIR: ".openclaw",
  extractArchive: vi.fn(),
  resolveBrewExecutable: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  withTempDownloadPath: vi.fn(),
}));

const { downloadToFile } = await import("./install-signal-cli.js");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadToFile content-length parsing", () => {
  it("rejects malformed content-length through the real guarded fetch path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-download-"));
    const destination = path.join(tmpDir, "signal-cli.tgz");
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls += 1;
        return new Response("archive", {
          status: 200,
          headers: { "content-length": "0x10" },
        });
      }) as unknown as typeof fetch,
    );

    try {
      await expect(
        downloadToFile("https://example.com/signal-cli.tgz", destination, 5, 8),
      ).rejects.toThrow("invalid content-length header: 0x10");
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fetchCalls).toBe(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
