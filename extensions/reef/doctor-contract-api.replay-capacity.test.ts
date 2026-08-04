import fs from "node:fs";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  REEF_REPLAY_MAX_ENTRIES,
  REEF_REPLAY_NAMESPACE,
  REEF_REPLAY_TTL_MS,
  reefReplayStoreKey,
  type ReefReplayRecord,
} from "./src/state.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("reef", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

describe("Reef doctor replay capacity", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-doctor-replay-"));
    vi.spyOn(os, "homedir").mockReturnValue(stateDir);
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("migrates aggregate replay state beyond 64 MiB when every record fits the value limit", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    const replayPath = path.join(legacyDir, "replay.jsonl");
    fs.mkdirSync(legacyDir, { recursive: true });
    // 2,000 claims, each with a ~40 KiB envelope hash, exceed the former
    // 64 MiB aggregate budget while every record stays under the 65,536-byte
    // plugin-state value limit and the 3,000-entry replay capacity.
    const recordCount = 2_000;
    const envelopeHash = "c".repeat(40 * 1024);
    const lines = Array.from({ length: recordCount }, (_, index) =>
      JSON.stringify({
        op: "claim",
        peer: "alice",
        id: `01JZ000000000000000000000${String(index).padStart(4, "0")}`,
        envelopeHash,
      }),
    );
    fs.writeFileSync(replayPath, `${lines.join("\n")}\n`);
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    const result = await migrationById("reef-runtime-files-to-plugin-state").migrateLegacyState(
      params,
    );

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      `Migrated ${recordCount} Reef replay bindings -> plugin state`,
      expect.stringContaining("Archived Reef replay state legacy source"),
      expect.stringContaining("Verified all Reef durable state; cleared migration barrier"),
    ]);
    expect(fs.existsSync(`${replayPath}.migrated`)).toBe(true);
    const replayStore = context.openPluginStateKeyedStore<ReefReplayRecord>({
      namespace: REEF_REPLAY_NAMESPACE,
      maxEntries: REEF_REPLAY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_REPLAY_TTL_MS,
    });
    await expect(
      replayStore.lookup(reefReplayStoreKey("alice", "01JZ0000000000000000000000001")),
    ).resolves.toMatchObject({
      peer: "alice",
      envelopeHash,
      state: "available",
    });
  });
});
