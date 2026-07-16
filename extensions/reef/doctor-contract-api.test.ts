import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import { base64url, generateIdentity, MemoryAuditStore } from "./protocol/index.js";
import { ReefChannelConfigSchema } from "./src/config-schema.js";
import {
  generateAndStoreKeys,
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_MAX_ENTRIES,
  REEF_AUDIT_NAMESPACE,
  REEF_KEYS_KEY,
  REEF_KEYS_MAX_ENTRIES,
  REEF_KEYS_NAMESPACE,
  reefAuditEntryKey,
  type ReefAuditStateRecord,
} from "./src/state.js";
import {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  resolveReefTrustStoreKey,
} from "./src/trust-store.js";
import type { ReefKeys } from "./src/types.js";

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

function createRuntime(env: NodeJS.ProcessEnv) {
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: options.env ?? env,
    });
  return runtime;
}

function reefKeys(): ReefKeys {
  return {
    ...generateIdentity(),
    auditKey: base64url(new Uint8Array(32).fill(1)),
    replayKey: base64url(new Uint8Array(32).fill(2)),
    keyEpoch: 1,
  };
}

function legacyConfig(): OpenClawConfig {
  const identity = generateIdentity();
  return {
    channels: {
      reef: {
        enabled: true,
        handle: "owner",
        relayUrl: "https://reefwire.ai",
        requestPolicy: "code-only",
        dmPolicy: "pairing",
        allowFrom: ["peer"],
        friends: {
          peer: {
            autonomy: "extended",
            ed25519PublicKey: identity.signing.publicKey,
            x25519PublicKey: identity.encryption.publicKey,
            keyEpoch: 2,
            safetyNumberChanged: false,
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("Reef doctor contract", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("detects and removes retired config fields", () => {
    const cfg = legacyConfig();
    expect(legacyConfigRules[0]?.match?.(cfg.channels?.reef, cfg)).toBe(true);

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([
      "Removed retired Reef dmPolicy field.",
      "Removed retired Reef allowFrom field.",
    ]);
    expect(result.config.channels?.reef).toEqual({
      enabled: true,
      handle: "owner",
      relayUrl: "https://reefwire.ai",
      requestPolicy: "code-only",
      friends: expect.any(Object),
    });
  });

  it("imports identity keys into SQLite before archiving keys.json", async () => {
    const legacyDir = path.join(stateDir, "data", "reef");
    const filePath = path.join(legacyDir, "keys.json");
    const keys = reefKeys();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(keys));
    const migration = migrationById("reef-keys-json-to-plugin-state");
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef identity keys -> plugin state (identity)"],
    });
    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Reef identity keys -> plugin state",
      expect.stringContaining("Archived Reef identity keys legacy source"),
    ]);
    const store = context.openPluginStateKeyedStore<ReefKeys>({
      namespace: REEF_KEYS_NAMESPACE,
      maxEntries: REEF_KEYS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(store.lookup(REEF_KEYS_KEY)).resolves.toEqual(keys);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
  });

  it("blocks identity regeneration after a failed keys.json import", async () => {
    const legacyDir = path.join(stateDir, "data", "reef");
    const filePath = path.join(legacyDir, "keys.json");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(filePath, "{broken");
    const migration = migrationById("reef-keys-json-to-plugin-state");
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };

    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([
      expect.stringContaining("Failed importing Reef identity keys"),
    ]);
    fs.rmSync(filePath);
    const missingSourceResult = await migration.migrateLegacyState(params);
    expect(missingSourceResult.warnings).toEqual([
      expect.stringContaining("migration is incomplete and keys.json is missing"),
    ]);
    await expect(generateAndStoreKeys(createRuntime(env))).rejects.toThrow(
      "migration is incomplete",
    );
  });

  it("imports and verifies the append-only audit chain", async () => {
    const legacyDir = path.join(stateDir, "data", "reef");
    const filePath = path.join(legacyDir, "audit.jsonl");
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
    await audit.appendEvent("one", { id: 1 }, 10);
    await audit.appendEvent("two", { id: 2 }, 11);
    const entries = await audit.entries();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const migration = migrationById("reef-audit-jsonl-to-plugin-state");
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated 2 Reef audit entries -> plugin state",
      expect.stringContaining("Archived Reef audit trail legacy source"),
    ]);
    const store = context.openPluginStateKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: REEF_AUDIT_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(store.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toEqual({
      kind: "head",
      hash: entries[1]!.entryHash,
      seq: 2,
    });
    await expect(store.lookup(reefAuditEntryKey(entries[0]!.entryHash))).resolves.toEqual({
      kind: "entry",
      entry: entries[0],
    });
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
  });

  it("imports registration state and rebuilds transient files empty", async () => {
    const legacyDir = path.join(stateDir, "data", "reef");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "identity.json"),
      JSON.stringify({ handle: "molty", relayUrl: "https://reefwire.ai" }),
    );
    fs.writeFileSync(
      path.join(legacyDir, "setup-session.json"),
      JSON.stringify({
        session: "setup-secret",
        relayUrl: "https://reefwire.ai",
        email: "molty@example.com",
      }),
    );
    for (const filename of ["replay.jsonl", "reviews.json", "delivered.json"]) {
      fs.writeFileSync(path.join(legacyDir, filename), "legacy");
    }
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    const registration = await migrationById(
      "reef-registration-json-to-plugin-state",
    ).migrateLegacyState(params);
    const transient = await migrationById(
      "reef-transient-files-to-plugin-state",
    ).migrateLegacyState(params);

    expect(registration.warnings).toEqual([]);
    expect(registration.changes).toHaveLength(4);
    expect(transient.warnings).toEqual([]);
    expect(transient.changes).toHaveLength(3);
    for (const filename of [
      "identity.json",
      "setup-session.json",
      "replay.jsonl",
      "reviews.json",
      "delivered.json",
    ]) {
      expect(fs.existsSync(path.join(legacyDir, filename))).toBe(false);
    }
  });

  it("imports config-backed trust into scoped plugin state without overwriting canonical rows", async () => {
    const cfg = legacyConfig();
    const migration = migrationById("reef-config-trust-to-plugin-state");
    const context = createDoctorContext(env);
    const params = { config: cfg, env, stateDir, oauthDir: path.join(stateDir, "oauth"), context };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef peer trust: config -> plugin state (1 peer(s), 0 invalid)"],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Migrated Reef peer trust -> plugin state (1 imported, 0 already present)"],
      warnings: [],
    });

    const canonical = ReefChannelConfigSchema.parse({
      handle: "owner",
      relayUrl: "https://reefwire.ai",
      requestPolicy: "code-only",
    });
    const store = context.openPluginStateKeyedStore<{
      revision: number;
      trust: { autonomy: string; approvedAt: number };
    }>({
      namespace: REEF_TRUST_STORE_NAMESPACE,
      maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const peerKey = resolveReefTrustStoreKey(canonical, "peer");
    await expect(store.lookup(peerKey)).resolves.toMatchObject({
      revision: 1,
      trust: { autonomy: "extended", approvedAt: 0 },
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await store.delete(peerKey);
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await expect(store.lookup(peerKey)).resolves.toBeUndefined();
  });

  it("migrates valid rows but retains the legacy map when another row is invalid", async () => {
    const cfg = legacyConfig();
    const reef = cfg.channels?.reef as Record<string, unknown>;
    reef.friends = {
      ...(reef.friends as Record<string, unknown>),
      broken: { autonomy: "extended" },
    };
    const migration = migrationById("reef-config-trust-to-plugin-state");
    const context = createDoctorContext(env);
    const params = { config: cfg, env, stateDir, oauthDir: path.join(stateDir, "oauth"), context };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef peer trust: config -> plugin state (1 peer(s), 1 invalid)"],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Migrated Reef peer trust -> plugin state (1 imported, 0 already present)"],
      warnings: ["Skipped 1 invalid Reef peer trust row(s); left legacy friends config in place"],
    });

    const normalized = normalizeCompatibilityConfig({ cfg });
    expect(normalized.config.channels?.reef).toHaveProperty("friends.broken");
    expect(normalized.config.channels?.reef).not.toHaveProperty("dmPolicy");
    expect(normalized.config.channels?.reef).not.toHaveProperty("allowFrom");
  });

  it("does not partially migrate when the trust namespace is full", async () => {
    const cfg = legacyConfig();
    const registerIfAbsent = vi.fn();
    const context = {
      openPluginStateKeyedStore() {
        return {
          entries: async () =>
            Array.from({ length: REEF_TRUST_STORE_MAX_ENTRIES }, (_, index) => ({
              key: `existing-${index}`,
              value: {},
              createdAt: 0,
            })),
          registerIfAbsent,
        } as never;
      },
    } as PluginDoctorStateMigrationContext;

    await expect(
      migrationById("reef-config-trust-to-plugin-state").migrateLegacyState({
        config: cfg,
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      }),
    ).resolves.toEqual({
      changes: [],
      warnings: [
        "Skipped Reef peer trust migration because plugin state has room for 0 of 1 trust row(s) and 0 of 1 import marker(s); left legacy friends config in place",
      ],
    });
    expect(registerIfAbsent).not.toHaveBeenCalled();
  });
});
