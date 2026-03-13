import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  withModelsTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

installModelsConfigTestHooks();

describe("models-config Windows rename retry", () => {
  it("retries fs.rename when it fails with EPERM (Windows file locking)", async () => {
    await withModelsTempHome(async () => {
      let renameCallCount = 0;
      const originalRename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        renameCallCount += 1;
        if (renameCallCount <= 2) {
          const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        return originalRename(...args);
      });

      try {
        await ensureOpenClawModelsJson(structuredClone(CUSTOM_PROXY_MODELS_CONFIG));
      } finally {
        renameSpy.mockRestore();
      }

      // Should have retried: 2 failures + 1 success = 3 calls
      expect(renameCallCount).toBe(3);

      // File should still be written correctly
      const parsed = await readGeneratedModelsJson<{
        providers: { "custom-proxy"?: { models?: Array<{ name?: string }> } };
      }>();
      expect(parsed.providers["custom-proxy"]).toBeDefined();
    });
  });

  it("cleans up temp file and throws after exhausting retries", async () => {
    await withModelsTempHome(async () => {
      const originalRename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        // Check if this is a models.json rename (not other internal renames)
        const dest = String(args[1]);
        if (dest.endsWith("models.json")) {
          const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        return originalRename(...args);
      });

      try {
        await expect(
          ensureOpenClawModelsJson(structuredClone(CUSTOM_PROXY_MODELS_CONFIG)),
        ).rejects.toThrow("EPERM");
      } finally {
        renameSpy.mockRestore();
      }
    });
  });
});
