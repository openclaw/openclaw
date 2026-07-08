// Verifies models.json writes and repairs use private file permissions.
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafePython } from "@openclaw/fs-safe/config";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  ensureModelsFileModeForModelsJson,
  writeModelsFileAtomicForModelsJson,
} from "./models-config.js";

const tempDirs = new Set<string>();

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  cleanupTempDirs(tempDirs);
});

describe("models-config file mode", () => {
  it("writes models.json with mode 0600", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir(tempDirs, "models-json-mode-");
    const modelsPath = path.join(dir, "models.json");
    await writeModelsFileAtomicForModelsJson(modelsPath, '{"providers":{}}\n');
    const stat = await fs.stat(modelsPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("repairs models.json mode to 0600 on no-content-change paths", async () => {
    // No-op content updates should still harden existing file permissions.
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir(tempDirs, "models-json-mode-");
    const modelsPath = path.join(dir, "models.json");
    await writeModelsFileAtomicForModelsJson(modelsPath, '{"providers":{}}\n');
    await fs.chmod(modelsPath, 0o644);

    await ensureModelsFileModeForModelsJson(modelsPath);

    const stat = await fs.stat(modelsPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("retries when fs-safe detects a replaced generated catalog directory", async () => {
    configureFsSafePython({ mode: "off" });
    const dir = makeTempDir(tempDirs, "models-json-write-boundary-");
    const catalogPath = path.join(dir, "plugins", "zai", "catalog.json");
    const contents = '{"providers":{"zai":{"models":[{"id":"glm-5.1"}]}}}\n';
    let replacementCount = 0;

    __setFsSafeTestHooksForTest({
      afterPinnedWriteFallbackRename: async (targetPath) => {
        const isTargetCatalog =
          path.basename(targetPath) === "catalog.json" &&
          path.basename(path.dirname(targetPath)) === "zai";
        if (!isTargetCatalog || replacementCount > 0) {
          return;
        }
        replacementCount += 1;
        const catalogDir = path.dirname(targetPath);
        await fs.rename(catalogDir, `${catalogDir}.replaced`);
        await fs.mkdir(catalogDir, { recursive: true, mode: 0o700 });
      },
    });

    await writeModelsFileAtomicForModelsJson(catalogPath, contents);

    expect(replacementCount).toBe(1);
    await expect(fs.readFile(catalogPath, "utf8")).resolves.toBe(contents);
  });
});
