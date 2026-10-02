import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "../../doctor-contract-api.js";

const migration = stateMigrations.find((entry) => entry.id === "discord-legacy-state");
if (!migration) {
  throw new Error("Discord Doctor migration is missing");
}

let stateWorkspace: TempWorkspace;

beforeEach(async () => {
  stateWorkspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-discord-state-migration-",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stateWorkspace.cleanup();
});

function migrationInput() {
  const stateDir = stateWorkspace.dir;
  return {
    config: {},
    env: { OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "credentials"),
    context: {
      openPluginStateKeyedStore: vi.fn(() => {
        throw new Error("Retired JSON must not open canonical stores");
      }),
    },
  } satisfies Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];
}

describe("Discord Doctor state migration", () => {
  it.each(["model-picker-preferences.json", "thread-bindings.json"])(
    "preserves %s discovered after preview and requires the bridge release",
    async (name) => {
      const input = migrationInput();
      expect(await migration.detectLegacyState(input)).toBeNull();
      const sourcePath = path.join(input.stateDir, "discord", name);
      const bytes = Buffer.from([0xff, 0x7b, 0x00, 0x0a]);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, bytes);

      const advice = expect.stringContaining(
        'Install OpenClaw 2026.9.5, run "openclaw doctor --fix", then upgrade to latest.',
      );
      const result = await migration.migrateLegacyState(input);
      expect(result).toEqual({ changes: [], warnings: [advice] });
      expect(result.warnings[0]).toContain(sourcePath);
      expect(await migration.detectLegacyState(input)).toEqual({ preview: [advice] });
      expect(await fs.readFile(sourcePath)).toEqual(bytes);
      expect(await fs.readdir(path.dirname(sourcePath))).toEqual([name]);
      expect(await fs.readdir(input.stateDir)).toEqual(["discord"]);
      expect(input.context.openPluginStateKeyedStore).not.toHaveBeenCalled();
    },
  );

  it("preserves dangling retired source links without following them", async () => {
    const input = migrationInput();
    const sourcePath = path.join(input.stateDir, "discord", "thread-bindings.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.symlink("missing-target", sourcePath);

    const result = await migration.migrateLegacyState(input);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining(sourcePath)]);
    expect(result.warningDisposition).toBeUndefined();
    expect(await fs.readlink(sourcePath)).toBe("missing-target");
    expect(await fs.readdir(input.stateDir)).toEqual(["discord"]);
  });

  it("ignores retained archives without creating canonical state", async () => {
    const input = migrationInput();
    const discordDir = path.join(input.stateDir, "discord");
    await fs.mkdir(discordDir, { recursive: true });
    const name = "thread-bindings.json.migrated";
    await fs.writeFile(path.join(discordDir, name), "retained archive");

    expect(await migration.detectLegacyState(input)).toBeNull();
    expect(await migration.migrateLegacyState(input)).toEqual({ changes: [], warnings: [] });
    expect(await fs.readdir(discordDir)).toEqual([name]);
    expect(await fs.readdir(input.stateDir)).toEqual(["discord"]);
  });

  it("does not report inaccessible retired state as absent", async () => {
    const input = migrationInput();
    const error = Object.assign(new Error("inspection denied"), { code: "EACCES" });
    vi.spyOn(fs, "lstat").mockRejectedValue(error);

    await expect(migration.detectLegacyState(input)).rejects.toBe(error);
    await expect(migration.migrateLegacyState(input)).rejects.toBe(error);
    expect(await fs.readdir(input.stateDir)).toEqual([]);
  });
});
