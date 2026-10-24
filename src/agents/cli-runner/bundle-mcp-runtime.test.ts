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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tempRoot.cleanup();
  });

  it("removes the temporary directory when the credential write fails", async () => {
    vi.spyOn(os, "tmpdir").mockReturnValue(base);
    const error = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(error);

    await expect(
      writeTemporaryBundleMcpJson(
        "openclaw-cli-mcp-",
        {
          mcpServers: {
            openclaw: { headers: { Authorization: "Bearer synthetic-secret" } },
          },
        },
        "mcp.json",
        false,
      ),
    ).rejects.toBe(error);

    await expect(fs.readdir(base)).resolves.toEqual([]);
  });
});
