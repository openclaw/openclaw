import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTemporaryBundleMcpJson } from "./bundle-mcp-runtime.js";

const LEAK_PREFIX = "openclaw-cli-mcp-leak-test-";
const SENTINEL = "sentinel-header-credential-xyz";

async function listLeakedDirs(prefix = LEAK_PREFIX): Promise<string[]> {
  try {
    const entries = await fs.readdir(os.tmpdir());
    return entries.filter((entry) => entry.startsWith(prefix));
  } catch {
    return [];
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const name of await listLeakedDirs()) {
    await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
});

describe("writeTemporaryBundleMcpJson cleanup on write failure", () => {
  it("removes the temp directory when the non-atomic write fails before flushing", async () => {
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { code: "ENOSPC" }),
    );

    await expect(
      writeTemporaryBundleMcpJson(
        LEAK_PREFIX,
        { mcpServers: { openclaw: { headers: { Authorization: `Bearer ${SENTINEL}` } } } },
        "mcp.json",
        false,
      ),
    ).rejects.toMatchObject({ code: "ENOSPC" });

    const leaked = await listLeakedDirs();
    expect(leaked).toEqual([]);
  });

  it("removes the temp directory when the non-atomic write fails mid-write", async () => {
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
      if (typeof target === "string" && target.includes(LEAK_PREFIX)) {
        if (typeof data === "string") {
          await realWriteFile(target, data.slice(0, -2), "utf-8");
        }
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return realWriteFile(target, data, options);
    });

    await expect(
      writeTemporaryBundleMcpJson(
        LEAK_PREFIX,
        { mcpServers: { openclaw: { headers: { Authorization: `Bearer ${SENTINEL}` } } } },
        "mcp.json",
        false,
      ),
    ).rejects.toMatchObject({ code: "ENOSPC" });

    const leaked = await listLeakedDirs();
    expect(leaked).toEqual([]);
  });
});
