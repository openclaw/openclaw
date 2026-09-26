import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertLegacyReefKeysMigrated } from "./legacy-key-guard.js";

describe("Reef legacy key guard", () => {
  const tempDirs: string[] = [];

  function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-keys-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks identity generation while a legacy keys file awaits Doctor", async () => {
    const stateRoot = tempDir();
    const legacyDir = path.join(stateRoot, ".openclaw", "data", "reef");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keys.json"), "{}");

    await expect(assertLegacyReefKeysMigrated(undefined, {}, stateRoot)).rejects.toThrow(
      "Legacy Reef identity keys must be imported",
    );
  });

  it("blocks when the legacy keys path exists but is not a regular file", async () => {
    const stateRoot = tempDir();
    fs.mkdirSync(path.join(stateRoot, ".openclaw", "data", "reef", "keys.json"), {
      recursive: true,
    });

    await expect(assertLegacyReefKeysMigrated(undefined, {}, stateRoot)).rejects.toThrow(
      "Legacy Reef identity keys must be imported",
    );
  });

  it("ignores default-home keys for an isolated active state", async () => {
    const homeDir = tempDir();
    const isolatedStateDir = tempDir();
    const legacyDir = path.join(homeDir, ".openclaw", "data", "reef");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keys.json"), "{}");

    await expect(
      assertLegacyReefKeysMigrated(undefined, { OPENCLAW_STATE_DIR: isolatedStateDir }, homeDir),
    ).resolves.toBeUndefined();
  });

  it("honors explicitly configured default-home keys for an isolated active state", async () => {
    const homeDir = tempDir();
    const isolatedStateDir = tempDir();
    const legacyDir = path.join(homeDir, ".openclaw", "data", "reef");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keys.json"), "{}");

    await expect(
      assertLegacyReefKeysMigrated(legacyDir, { OPENCLAW_STATE_DIR: isolatedStateDir }, homeDir),
    ).rejects.toThrow("Legacy Reef identity keys must be imported");
  });
});
