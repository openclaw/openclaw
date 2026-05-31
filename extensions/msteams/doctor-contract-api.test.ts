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
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("imports legacy feedback learnings into plugin state", async () => {
    const agentStoreTemplate = path.join(stateDir, "agents", "{agentId}", "sessions");
    const mainStorePath = path.join(stateDir, "agents", "main", "sessions");
    const workStorePath = path.join(stateDir, "agents", "work", "sessions");
    const encodedSessionKey = "msteams:user1";
    const encodedSourcePath = path.join(
      mainStorePath,
      `${encodeSessionKey(encodedSessionKey)}.learnings.json`,
    );
    const sanitizedSourcePath = path.join(workStorePath, "msteams_user2.learnings.json");
    await fs.mkdir(mainStorePath, { recursive: true });
    await fs.mkdir(workStorePath, { recursive: true });
    await fs.writeFile(encodedSourcePath, JSON.stringify(["Be concise", "Use examples"]));
    await fs.writeFile(sanitizedSourcePath, JSON.stringify(["Prefer cards"]));

    const migration = stateMigrations[0];
    const context = createDoctorContext(env);
    await context
      .openPluginStateKeyedStore({
        namespace: "feedback-learnings",
        maxEntries: 10_000,
      })
      .register(encodeSessionKey(encodedSessionKey), {
        sessionKey: encodedSessionKey,
        learnings: ["Use examples", "New runtime note"],
        updatedAt: 1900,
      });

    await expect(
      migration.detectLegacyState({
        config: {
          session: { store: agentStoreTemplate },
          agents: { list: [{ id: "work" }] },
        },
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("2 files")],
    });

    const result = await migration.migrateLegacyState({
      config: {
        session: { store: agentStoreTemplate },
        agents: { list: [{ id: "work" }] },
      },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });

    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Microsoft Teams feedback-learning entry"),
      expect.stringContaining("Archived Microsoft Teams feedback-learning legacy source"),
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining("legacy filename cannot be mapped to a session key"),
    ]);
    await expect(fs.access(encodedSourcePath)).rejects.toThrow();
    await expect(fs.access(sanitizedSourcePath)).resolves.toBeUndefined();
    await expect(fs.access(`${encodedSourcePath}.migrated`)).resolves.toBeUndefined();

    const store = context.openPluginStateKeyedStore({
      namespace: "feedback-learnings",
      maxEntries: 10_000,
    });
    await expect(store.lookup(encodeSessionKey(encodedSessionKey))).resolves.toMatchObject({
      sessionKey: encodedSessionKey,
      learnings: ["Be concise", "Use examples", "New runtime note"],
    });
  });
});
