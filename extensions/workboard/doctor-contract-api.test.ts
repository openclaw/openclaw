import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import {
  createPluginStateKeyedStoreForTests as createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

let stateDir: string;
let env: NodeJS.ProcessEnv;
const migration = expectDefined(stateMigrations[0], "Workboard retirement detector");

beforeAll(() => {
  // openclaw-temp-dir: allow closes the database owner before removing the suite fixture.
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-retired-"));
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
});

afterAll(() => {
  resetPluginStateStoreForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function input(supportsCount: boolean) {
  const context: PluginDoctorStateMigrationContext = {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      const store = createPluginStateKeyedStore<T>("workboard", options);
      return { ...store, count: supportsCount ? store.count : undefined };
    },
  };
  return { config: {}, env, stateDir, oauthDir: path.join(stateDir, "oauth"), context };
}

describe.each([true, false])("Workboard retirement with count support %s", (supportsCount) => {
  it("leaves installations without legacy rows alone", async () => {
    await expect(migration.detectLegacyState(input(supportsCount))).resolves.toBeNull();
    await expect(migration.migrateLegacyState(input(supportsCount))).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it.each([
    ["workboard.cards", 2000],
    ["workboard.boards", 200],
    ["workboard.notify", 2000],
    ["workboard.attachments", 42_000],
  ])("preserves %s rows and names the recovery release", async (namespace, maxEntries) => {
    const store = createPluginStateKeyedStore<unknown>("workboard", { namespace, maxEntries, env });
    await store.register("retained", { version: 1, retained: namespace });
    const before = await store.entries();
    try {
      await expect(migration.detectLegacyState(input(supportsCount))).resolves.toEqual({
        preview: [expect.stringContaining("2026.9.7 and run openclaw doctor --fix")],
      });
      const result = await migration.migrateLegacyState(input(supportsCount));
      expect(result).toEqual({
        changes: [],
        warnings: [expect.stringContaining("2026.9.7 and run openclaw doctor --fix")],
      });
      expect(await store.entries()).toEqual(before);
    } finally {
      await store.delete("retained");
    }
  });
});
