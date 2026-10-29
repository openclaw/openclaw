import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { writeTemporaryBundleMcpJson } from "./bundle-mcp-runtime.js";

describe("writeTemporaryBundleMcpJson", () => {
  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-cli-mcp-test-" });
  let base: string;

  beforeEach(async () => {
    base = await tempRoot.setup();
    vi.spyOn(os, "tmpdir").mockReturnValue(base);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tempRoot.cleanup();
  });

  it("removes a partially written config and preserves the write error", async () => {
    const error = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (target) => {
      await writeFile(target, '{"Authorization":"Bearer synthetic-secret', "utf-8");
      throw error;
    });

    await expect(
      writeTemporaryBundleMcpJson(
        "openclaw-cli-mcp-",
        { mcpServers: { openclaw: { headers: { Authorization: "Bearer synthetic-secret" } } } },
        "mcp.json",
        false,
      ),
    ).rejects.toBe(error);
    await expect(fs.readdir(base)).resolves.toEqual([]);
  });

  it("removes the directory when the atomic writer rejects a filename", async () => {
    await expect(
      writeTemporaryBundleMcpJson("openclaw-gemini-mcp-", {}, `${"x".repeat(300)}.json`),
    ).rejects.toThrow();
    await expect(fs.readdir(base)).resolves.toEqual([]);
  });
});
