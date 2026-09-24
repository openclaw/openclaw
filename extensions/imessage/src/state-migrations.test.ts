import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "../doctor-contract-api.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const migration = stateMigrations.find((entry) => entry.id === "imessage-legacy-state");
if (!migration) {
  throw new Error("iMessage Doctor migration is missing");
}

function migrationInput(stateDir: string) {
  return {
    config: {},
    env: { OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "credentials"),
    context: {
      openPluginStateKeyedStore: vi.fn(() => {
        throw new Error("Retired state inspection must not open canonical stores");
      }),
    },
  } satisfies Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];
}

describe("iMessage retired state", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports no migration work when retired state is absent", async () => {
    const stateDir = tempDirs.make("openclaw-imessage-retired-");
    const input = migrationInput(stateDir);
    expect(await migration.detectLegacyState(input)).toBeNull();
    expect(await migration.migrateLegacyState(input)).toEqual({ changes: [], warnings: [] });
    expect(input.context.openPluginStateKeyedStore).not.toHaveBeenCalled();
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it.each(["reply-cache.jsonl", "sent-echoes.jsonl", "catchup/retired-account.json"])(
    "preserves %s and requires the bridge release",
    async (relativePath) => {
      const stateDir = tempDirs.make("openclaw-imessage-retired-");
      const sourcePath = path.join(stateDir, "imessage", relativePath);
      const bytes = Buffer.from([0xff, 0x7b, 0x00, 0x0a]);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, bytes);
      const input = migrationInput(stateDir);
      const advice = expect.stringContaining(
        'Install OpenClaw 2026.9.5, run "openclaw doctor --fix", then upgrade to latest.',
      );
      const detected = await migration.detectLegacyState(input);
      expect(detected).toEqual({ preview: [advice] });
      const result = await migration.migrateLegacyState(input);
      expect(result).toEqual({ changes: [], warnings: [advice] });
      expect(result.warnings[0]).toContain(sourcePath);
      expect(result.warnings[0]).toContain(
        "https://docs.openclaw.ai/install/updating#upgrading-very-old-versions",
      );
      expect(await fs.readFile(sourcePath)).toEqual(bytes);
      expect(await fs.readdir(path.dirname(sourcePath))).toEqual([path.basename(sourcePath)]);
      expect(await fs.readdir(stateDir)).toEqual(["imessage"]);
      expect(input.context.openPluginStateKeyedStore).not.toHaveBeenCalled();
    },
  );

  it("ignores unrelated files and migration archives", async () => {
    const stateDir = tempDirs.make("openclaw-imessage-retired-");
    for (const relativePath of [
      "unrelated.json",
      "reply-cache.jsonl.migrated",
      "sent-echoes.jsonl.migrated",
      "catchup/retired-account.json.migrated",
      "catchup/notes.txt",
    ]) {
      const filePath = path.join(stateDir, "imessage", relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "retained archive");
    }
    const input = migrationInput(stateDir);
    expect(await migration.detectLegacyState(input)).toBeNull();
    expect(await migration.migrateLegacyState(input)).toEqual({ changes: [], warnings: [] });
    expect(input.context.openPluginStateKeyedStore).not.toHaveBeenCalled();
  });

  it.each(["readdir", "lstat"] as const)(
    "does not certify missing state when %s is denied",
    async (operation) => {
      const input = migrationInput(tempDirs.make("openclaw-imessage-retired-"));
      const error = Object.assign(new Error("inspection denied"), { code: "EACCES" });
      vi.spyOn(fs, operation).mockRejectedValue(error);
      await expect(migration.detectLegacyState(input)).rejects.toBe(error);
      await expect(migration.migrateLegacyState(input)).rejects.toBe(error);
      expect(input.context.openPluginStateKeyedStore).not.toHaveBeenCalled();
    },
  );
});
