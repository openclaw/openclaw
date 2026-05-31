import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("msteams", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}

describe("msteams doctor state migration", () => {
  let stateDir = "";
  let storePath = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-doctor-"));
    storePath = path.join(stateDir, "sessions");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await fs.mkdir(storePath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("imports legacy feedback learnings into plugin state", async () => {
    const sessionKey = "msteams:user1";
    const sourcePath = path.join(storePath, `${encodeSessionKey(sessionKey)}.learnings.json`);
    await fs.writeFile(sourcePath, JSON.stringify(["Be concise", "Use examples"]));

    const migration = stateMigrations[0];
    await expect(
      migration.detectLegacyState({
        config: { session: { store: storePath } },
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("1 file")],
    });

    const result = await migration.migrateLegacyState({
      config: { session: { store: storePath } },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Microsoft Teams feedback-learning entry"),
      expect.stringContaining("Archived Microsoft Teams feedback-learning legacy source"),
    ]);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await expect(fs.access(`${sourcePath}.migrated`)).resolves.toBeUndefined();
    await expect(
      createDoctorContext(env)
        .openPluginStateKeyedStore({
          namespace: "feedback-learnings",
          maxEntries: 10_000,
        })
        .lookup(encodeSessionKey(sessionKey)),
    ).resolves.toMatchObject({
      sessionKey,
      learnings: ["Be concise", "Use examples"],
    });
  });
});
