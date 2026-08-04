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
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { MemoryAuditStore } from "./protocol/index.js";
import {
  countStoredReefAuditWindow,
  streamLegacyReefAuditWindow,
} from "./src/legacy-audit-import.js";
import {
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_STORE_MAX_ENTRIES,
  REEF_REPLAY_MAX_ENTRIES,
  REEF_REPLAY_NAMESPACE,
  REEF_REPLAY_TTL_MS,
  reefAuditEntryKey,
  reefReplayStoreKey,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
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

describe("Reef doctor journal capacity", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
  });

  it("migrates aggregate replay state beyond 64 MiB when every record fits the value limit", async () => {
    await withTempDir("openclaw-reef-doctor-replay-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
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

  it("migrates aggregate audit state beyond 64 MiB within the canonical window", async () => {
    await withTempDir("openclaw-reef-doctor-audit-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const auditPath = path.join(legacyDir, "audit.jsonl");
      fs.mkdirSync(legacyDir, { recursive: true });
      // 2,000 valid chain entries with ~40 KiB event bodies exceed the former
      // 64 MiB aggregate budget while every record stays under the 65,536-byte
      // plugin-state value limit and the 30,000-entry audit window.
      const entryCount = 2_000;
      const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
      const body = { payload: "c".repeat(40 * 1024) };
      for (let index = 0; index < entryCount; index += 1) {
        await audit.appendEvent("one", body, 10 + index);
      }
      const entries = await audit.entries();
      fs.writeFileSync(auditPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const context = createDoctorContext(env);
      const params = {
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      };

      const result = await migrationById("reef-audit-jsonl-to-plugin-state").migrateLegacyState(
        params,
      );

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([
        `Migrated ${entryCount} Reef audit entries -> plugin state`,
        expect.stringContaining("Archived Reef audit trail legacy source"),
      ]);
      const headStore = context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
        namespace: REEF_AUDIT_HEAD_NAMESPACE,
        maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toMatchObject({
        hash: entries.at(-1)!.entryHash,
        seq: entryCount,
        oldestHash: entries[0]!.entryHash,
      });
      const store = context.openPluginStateKeyedStore<ReefAuditStateRecord>({
        namespace: REEF_AUDIT_NAMESPACE,
        maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      await expect(
        store.lookup(reefAuditEntryKey(entries.at(-1)!.entryHash)),
      ).resolves.toMatchObject({ kind: "entry", entry: entries.at(-1)! });
    });
  });

  it("streams near-limit audit entries with bounded memory and window retention", async () => {
    await withTempDir("openclaw-reef-doctor-audit-near-limit-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const auditPath = path.join(legacyDir, "audit.jsonl");
      fs.mkdirSync(legacyDir, { recursive: true });
      // 2,500 valid chain entries with ~60 KiB event bodies exceed the former
      // 64 MiB aggregate budget and the streaming window, while every record
      // stays under the 65,536-byte plugin-state value limit.
      const windowSize = 2_000;
      const entryCount = 2_500;
      const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
      const body = { payload: "c".repeat(60 * 1024) };
      for (let index = 0; index < entryCount; index += 1) {
        await audit.appendEvent("one", body, 10 + index);
      }
      const entries = await audit.entries();
      fs.writeFileSync(auditPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const context = createDoctorContext(env);
      const store = context.openPluginStateKeyedStore<ReefAuditStateRecord>({
        namespace: REEF_AUDIT_NAMESPACE,
        maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const headStore = context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
        namespace: REEF_AUDIT_HEAD_NAMESPACE,
        maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });

      const imported = await streamLegacyReefAuditWindow(
        auditPath,
        entryCount,
        store,
        headStore,
        windowSize,
      );

      expect(imported.persistedCount).toBe(windowSize);
      expect(imported.oldestHash).toBe(entries[entryCount - windowSize]!.entryHash);
      await expect(countStoredReefAuditWindow(store, headStore, windowSize)).resolves.toBe(
        windowSize,
      );
      await expect(store.lookup(reefAuditEntryKey(entries[0]!.entryHash))).resolves.toBeUndefined();
      await expect(
        store.lookup(reefAuditEntryKey(entries.at(-1)!.entryHash)),
      ).resolves.toMatchObject({ kind: "entry", entry: entries.at(-1)! });
      await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toMatchObject({
        hash: entries.at(-1)!.entryHash,
        seq: entryCount,
        oldestHash: entries[entryCount - windowSize]!.entryHash,
      });
    });
  });
});
