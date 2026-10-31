import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import * as temp from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stateMigrations } from "../../doctor-contract-api.js";

const migration = stateMigrations.find((entry) => entry.id === "discord-retired-state");
if (!migration) {
  throw new Error("Discord retired-state declaration is missing");
}

const advice = expect.stringContaining(
  "Install OpenClaw 2026.9.5. Run openclaw doctor --fix before upgrading to latest.",
);
let stateWorkspace: temp.TempWorkspace;
let input: Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];

beforeEach(async () => {
  const rootDir = temp.resolvePreferredOpenClawTmpDir();
  stateWorkspace = await temp.tempWorkspace({ rootDir, prefix: "discord-state-" });
  const stateDir = stateWorkspace.dir;
  input = {
    config: {},
    env: { OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "credentials"),
    context: {
      openPluginStateKeyedStore: vi.fn(() => {
        throw new Error("Retired JSON must not open canonical stores");
      }),
    },
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stateWorkspace.cleanup();
});

it.each([
  ["model-picker-preferences.json", false, true],
  ["thread-bindings.json", false, true],
  ["thread-bindings.json", true, true],
  ["thread-bindings.json.migrated", false, false],
] as const)(
  "preserves %s (symlink=%s), requiring the bridge only for retired sources (%s)",
  async (name, symlink, retired) => {
    expect(await migration.detectLegacyState(input)).toBeNull();
    const sourcePath = path.join(input.stateDir, "discord", name);
    const bytes = Buffer.from([0xff, 0x7b, 0x00, 0x0a]);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await (symlink ? fs.symlink("missing-target", sourcePath) : fs.writeFile(sourcePath, bytes));

    const warnings = retired ? [advice] : [];
    const result = await migration.migrateLegacyState(input);
    expect(result).toEqual({ changes: [], warnings });
    expect(result.warnings).toEqual(retired ? [expect.stringContaining(sourcePath)] : []);
    expect(result.warningDisposition).toBeUndefined();
    const preview = retired ? { preview: warnings } : null;
    expect(await migration.detectLegacyState(input)).toEqual(preview);
    expect(await (symlink ? fs.readlink(sourcePath) : fs.readFile(sourcePath))).toEqual(
      symlink ? "missing-target" : bytes,
    );
    expect(await fs.readdir(path.dirname(sourcePath))).toEqual([name]);
    expect(await fs.readdir(input.stateDir)).toEqual(["discord"]);
    expect(input.context.openPluginStateKeyedStore).not.toHaveBeenCalled();
  },
);

it("does not report inaccessible retired state as absent", async () => {
  const error = Object.assign(new Error("inspection denied"), { code: "EACCES" });
  vi.spyOn(fs, "lstat").mockRejectedValue(error);

  await expect(migration.detectLegacyState(input)).rejects.toBe(error);
  await expect(migration.migrateLegacyState(input)).rejects.toBe(error);
  expect(await fs.readdir(input.stateDir)).toEqual([]);
});
