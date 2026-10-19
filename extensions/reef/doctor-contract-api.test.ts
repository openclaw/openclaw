import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig, stateMigrations } from "./doctor-contract-api.js";
import { base64url, generateIdentity, type ReviewRequest } from "./protocol/index.js";
import { MemoryAuditStore } from "./protocol/memory-stores.test-support.js";
import { ReefChannelConfigSchema } from "./src/config-schema.js";
import * as replay from "./src/replay-store.js";
import * as state from "./src/state.js";
import {
  cleanupStateTestDirectory,
  createRuntime,
  createStateTestDirectory,
  expectReefStateOperationError,
} from "./src/state.test-support.js";
import {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  resolveReefTrustStoreKey,
} from "./src/trust-store.js";
import type { ReefKeys } from "./src/types.js";

function createDoctorContext(
  env: NodeJS.ProcessEnv,
  refusedNamespace?: string,
): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      const store = createPluginStateKeyedStoreForTests<T>("reef", {
        ...options,
        env: options.env ?? env,
      });
      return options.namespace === refusedNamespace
        ? { ...store, registerIfAbsent: async () => false }
        : store;
    },
  };
}

function migrationById(name: string) {
  const id = `reef-${name}-to-plugin-state`;
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

function reefKeys(): ReefKeys {
  return {
    ...generateIdentity(),
    auditKey: base64url(new Uint8Array(32).fill(1)),
    replayKey: base64url(new Uint8Array(32).fill(2)),
    keyEpoch: 1,
  };
}

function reviewRequest(id = "review-id"): ReviewRequest {
  return {
    id,
    from: "alice#1",
    to: "bob#1",
    direction: "outbound",
    bodyHash: "b".repeat(64),
    approvalDigest: "c".repeat(64),
    verdict: {
      decision: "review",
      category: "ambiguous",
      reason: "Owner review.",
      model: "test-model",
      policyVersion: "v1",
    },
  };
}

const jsonLines = (entries: readonly unknown[]) =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const incompleteMigration =
  "Reef durable state migration is incomplete; repair the legacy state files and rerun openclaw doctor --fix";
const identityBinding = { handle: "molty", relayUrl: "https://reefwire.ai" };
const pendingIdentity = {
  pending: true,
  identityBindingRequired: true,
} satisfies state.ReefIdentityMigrationRecord;
const unchanged = { changes: [], warnings: [] };
const storeSpecs = {
  keys: [state.REEF_KEYS_NAMESPACE, state.REEF_KEYS_MAX_ENTRIES],
  identity: [state.REEF_KEYS_MIGRATION_NAMESPACE, state.REEF_KEYS_MIGRATION_MAX_ENTRIES],
  registration: [state.REEF_REGISTRATION_NAMESPACE, state.REEF_REGISTRATION_MAX_ENTRIES],
  audit: [state.REEF_AUDIT_NAMESPACE, state.REEF_AUDIT_STORE_MAX_ENTRIES],
  head: [state.REEF_AUDIT_HEAD_NAMESPACE, state.REEF_AUDIT_HEAD_MAX_ENTRIES],
  auditMigration: [state.REEF_AUDIT_MIGRATION_NAMESPACE, state.REEF_AUDIT_MIGRATION_MAX_ENTRIES],
  replay: [replay.REEF_REPLAY_NAMESPACE, replay.REEF_REPLAY_MAX_ENTRIES, replay.REEF_REPLAY_TTL_MS],
  reviews: [state.REEF_REVIEWS_NAMESPACE, state.REEF_REVIEWS_MAX_ENTRIES],
  delivered: [
    state.REEF_DELIVERED_NAMESPACE,
    state.REEF_DELIVERED_MAX_ENTRIES,
    state.REEF_DELIVERED_TTL_MS,
  ],
  trust: [REEF_TRUST_STORE_NAMESPACE, REEF_TRUST_STORE_MAX_ENTRIES],
} satisfies Record<string, [string, number, number?]>;

function legacyConfig(extraFriends: Record<string, unknown> = {}): OpenClawConfig {
  const identity = generateIdentity();
  return {
    channels: {
      reef: {
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
          ...extraFriends,
        },
      },
    },
  } as OpenClawConfig;
}

describe("Reef doctor contract", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;
  let context: PluginDoctorStateMigrationContext;

  beforeEach(() => {
    stateDir = createStateTestDirectory();
    vi.spyOn(os, "homedir").mockReturnValue(stateDir);
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    context = createDoctorContext(env);
  });

  afterEach(() => cleanupStateTestDirectory(stateDir));

  function migrationParams(config: OpenClawConfig = {}, migrationContext = context) {
    return {
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: migrationContext,
    };
  }

  function migrate(name: string, params = migrationParams()) {
    return migrationById(name).migrateLegacyState(params);
  }

  function expectBlocked(
    operation: "load" | "generate" | "audit",
    message: string | RegExp = /migration is incomplete/,
  ) {
    const runtime = createRuntime(stateDir);
    const result = {
      load: () => state.loadKeys(runtime),
      generate: () => state.generateAndStoreKeys(runtime),
      audit: () => state.openStores(runtime, reefKeys()),
    }[operation]();
    return expectReefStateOperationError(result, message);
  }

  function openStore<T>(name: keyof typeof storeSpecs) {
    const [namespace, maxEntries, defaultTtlMs]: [string, number, number?] = storeSpecs[name];
    return context.openPluginStateKeyedStore<T>({
      namespace,
      maxEntries,
      overflowPolicy: "reject-new",
      ...(defaultTtlMs === undefined ? {} : { defaultTtlMs }),
    });
  }

  function expectIdentityMarker(expected: state.ReefIdentityMigrationRecord | undefined) {
    const store = openStore<state.ReefIdentityMigrationRecord>("identity");
    return expect(store.lookup(state.REEF_KEYS_MIGRATION_KEY)).resolves.toEqual(expected);
  }

  function expectArchive(filePath: string, archived: boolean, source?: string) {
    const exists = [fs.existsSync(filePath), fs.existsSync(`${filePath}.migrated`)];
    expect(exists).toEqual([!archived, archived]);
    if (source !== undefined) {
      expect(fs.readFileSync(archived ? `${filePath}.migrated` : filePath, "utf8")).toBe(source);
    }
  }

  function expectWarnings(result: { warnings: string[] }, ...messages: string[]) {
    expect(result.warnings).toEqual(messages.map((message) => expect.stringContaining(message)));
  }

  function writeLegacy(filename: string, value: unknown) {
    const filePath = path.join(createLegacyDir(), filename);
    fs.writeFileSync(filePath, typeof value === "string" ? value : JSON.stringify(value));
    return filePath;
  }

  function bindingFixture(
    source: "file" | "config",
    binding: typeof identityBinding & { email?: string } = identityBinding,
  ) {
    const keys = reefKeys();
    writeLegacy("keys.json", keys);
    const identityPath = path.join(createLegacyDir(), "identity.json");
    if (source === "file") {
      writeLegacy("identity.json", identityBinding);
    }
    const params = migrationParams(source === "config" ? { channels: { reef: binding } } : {});
    return { keys, identityPath, params };
  }

  async function auditFixture() {
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
    await audit.appendEvent("one", { id: 1 }, 10);
    await audit.appendEvent("two", { id: 2 }, 11);
    const entries = await audit.entries();
    const source = jsonLines(entries);
    return { entries, source, filePath: writeLegacy("audit.jsonl", source) };
  }

  function isolatedIdentity() {
    const homeDir = path.join(stateDir, "home");
    const isolatedStateDir = path.join(stateDir, "isolated");
    const legacyDir = path.join(homeDir, ".openclaw", "data", "reef");
    const homeKeysPath = path.join(legacyDir, "keys.json");
    const keys = reefKeys();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(isolatedStateDir, { recursive: true });
    fs.writeFileSync(homeKeysPath, JSON.stringify(keys));
    vi.mocked(os.homedir).mockReturnValue(homeDir);
    const isolatedEnv = { ...env, OPENCLAW_STATE_DIR: isolatedStateDir };
    context = createDoctorContext(isolatedEnv);
    return {
      keys,
      homeKeysPath,
      legacyDir,
      params: {
        config: {},
        env: isolatedEnv,
        stateDir: isolatedStateDir,
        oauthDir: path.join(isolatedStateDir, "oauth"),
        context,
      },
    };
  }

  function createLegacyDir() {
    const dir = path.join(stateDir, ".openclaw", "data", "reef");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("keeps channels.reef authoritative over conflicting stray entry config", () => {
    const cfg = {
      channels: { reef: { handle: "canonical" } },
      plugins: { entries: { reef: { config: { handle: "stray", email: "o@example.com" } } } },
    } as never;

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([
      "Moved plugins.entries.reef.config.email to channels.reef.email.",
      "Removed plugins.entries.reef.config.handle; channels.reef.handle is authoritative.",
    ]);
    expect(result.config.channels?.reef).toEqual({ handle: "canonical", email: "o@example.com" });
    expect(result.config.plugins?.entries?.reef).toEqual({});
  });

  it("does not import the default home's Reef identity into an isolated state", async () => {
    const { homeKeysPath, params } = isolatedIdentity();
    const migration = migrationById("keys-json");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual(unchanged);
    expect(fs.existsSync(homeKeysPath)).toBe(true);
  });

  it("imports an explicitly configured default-home Reef identity into isolated state", async () => {
    const { keys, homeKeysPath, legacyDir, params: isolatedParams } = isolatedIdentity();
    const migration = migrationById("keys-json");
    const params = { ...isolatedParams, config: { channels: { reef: { stateDir: legacyDir } } } };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef identity keys -> plugin state (identity)"],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({ warnings: [] });
    await expect(openStore<ReefKeys>("keys").lookup(state.REEF_KEYS_KEY)).resolves.toEqual(keys);
    expectArchive(homeKeysPath, true);
  });

  it("retains refused identity imports and keeps runtime blocked", async () => {
    const source = JSON.stringify(reefKeys());
    const filePath = writeLegacy("keys.json", source);
    const result = await migrate(
      "keys-json",
      migrationParams({}, createDoctorContext(env, state.REEF_KEYS_NAMESPACE)),
    );

    expect(result.changes).toEqual([]);
    expectWarnings(result, "Failed importing Reef identity keys");
    expectArchive(filePath, false, source);
    await expectBlocked("load");
  });

  it("blocks identity regeneration after a failed keys.json import", async () => {
    const filePath = writeLegacy("keys.json", "{broken");
    const result = await migrate("keys-json");
    expectWarnings(result, "Failed importing Reef identity keys");
    fs.rmSync(filePath);
    const missingSourceResult = await migrate("keys-json");
    expectWarnings(missingSourceResult, "migration is incomplete and keys.json is missing");
    await expectBlocked("generate");
  });

  it.each(["file", "config"] as const)(
    "binds legacy keys from %s before unblocking runtime",
    async (source) => {
      const { keys, params } = bindingFixture(source, {
        ...identityBinding,
        relayUrl: "https://reefwire.ai/",
        email: "not-an-email",
      });
      if (source === "config") {
        await expect(migrationById("registration-json").detectLegacyState(params)).resolves.toEqual(
          {
            preview: ["- Reef configured identity binding -> plugin state"],
          },
        );
      }
      expect((await migrate("keys-json", params)).warnings).toEqual([]);
      await expectIdentityMarker(pendingIdentity);
      if (source === "file") {
        await expectBlocked("load", incompleteMigration);
      }
      const registration = await migrate("registration-json", params);
      expect(registration.warnings).toEqual([]);
      expect(registration.changes).toContain(
        source === "file"
          ? "Verified Reef identity keys and binding; cleared migration marker"
          : "Migrated Reef identity binding from config -> plugin state",
      );
      await expect(
        openStore<state.ReefIdentityBinding>("registration").lookup(
          state.REEF_REGISTRATION_IDENTITY_KEY,
        ),
      ).resolves.toEqual(identityBinding);
      await expectIdentityMarker(undefined);
      if (source === "file") {
        await expectBlocked("load", incompleteMigration);
        await migrate("runtime-files", params);
        await expect(state.loadKeys(createRuntime(stateDir))).resolves.toEqual(keys);
      }
    },
  );

  it("keeps identity migration blocked when config conflicts with the imported binding", async () => {
    writeLegacy("keys.json", reefKeys());
    writeLegacy("identity.json", { handle: "canonical", relayUrl: "https://reefwire.ai" });
    const params = migrationParams({
      channels: {
        reef: { handle: "conflict", relayUrl: "https://reefwire.ai" },
      },
    });

    await migrate("keys-json", params);
    const result = await migrate("registration-json", params);

    expectWarnings(
      result,
      "configured handle or relay differs",
      "identity migration is incomplete",
    );
    await expectIdentityMarker(pendingIdentity);
  });

  it.each(["file", "config"] as const)(
    "keeps identity binding migration blocked after a refused %s import",
    async (sourceKind) => {
      const { identityPath, params } = bindingFixture(sourceKind);
      await migrate("keys-json", params);
      const result = await migrate("registration-json", {
        ...params,
        context: createDoctorContext(env, state.REEF_REGISTRATION_NAMESPACE),
      });

      expect(result.changes).toEqual([]);
      expect(result.warnings).toContainEqual(
        expect.stringContaining("Failed importing Reef identity"),
      );
      if (sourceKind === "file") {
        expectArchive(identityPath, false, JSON.stringify(identityBinding));
      }
      await expectBlocked("load");
    },
  );

  it.each([state.REEF_AUDIT_NAMESPACE, state.REEF_AUDIT_HEAD_NAMESPACE])(
    "retains the audit source after a refused %s insert and resumes safely",
    async (refusedNamespace) => {
      const { filePath, entries, source } = await auditFixture();
      const migration = migrationById("audit-jsonl");

      const failed = await migration.migrateLegacyState(
        migrationParams({}, createDoctorContext(env, refusedNamespace)),
      );

      expect(failed.changes).toEqual([]);
      expectWarnings(failed, "Failed importing Reef audit trail");
      expectArchive(filePath, false, source);
      await expectBlocked("audit");

      const recovered = await migration.migrateLegacyState(migrationParams());
      expect(recovered.warnings).toEqual([]);
      expectArchive(filePath, true, source);
      await migrate("runtime-files");
      const stores = await state.openStores(createRuntime(stateDir), reefKeys());
      await expect(stores.audit.entries()).resolves.toEqual(entries);
    },
  );

  it("imports and verifies the append-only audit chain", async () => {
    const { filePath, entries } = await auditFixture();
    const result = await migrate("audit-jsonl");

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated 2 Reef audit entries -> plugin state",
      expect.stringContaining("Archived Reef audit trail legacy source"),
    ]);
    const store = openStore<state.ReefAuditStateRecord>("audit");
    const headStore = openStore<state.ReefAuditHeadRecord>("head");
    await expect(headStore.lookup(state.REEF_AUDIT_HEAD_KEY)).resolves.toEqual({
      kind: "head",
      hash: entries[1]!.entryHash,
      seq: 2,
      oldestHash: entries[0]!.entryHash,
    });
    await expect(store.lookup(state.reefAuditEntryKey(entries[0]!.entryHash))).resolves.toEqual({
      kind: "entry",
      entry: entries[0],
      nextHash: entries[1]!.entryHash,
    });
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
  });

  it("finishes an interrupted migration of an empty audit trail", async () => {
    const filePath = writeLegacy("audit.jsonl", "");
    const imported = await migrate("audit-jsonl");
    expect(imported.warnings).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);

    const migrationStore = openStore<{
      pending: true;
      expectedEntries: number;
    }>("auditMigration");
    await migrationStore.register(state.REEF_AUDIT_MIGRATION_KEY, {
      pending: true,
      expectedEntries: 0,
    });

    const recovered = await migrate("audit-jsonl");
    expect(recovered.warnings).toEqual([]);
    expect(recovered.changes).toContain(
      "Verified Reef audit trail; cleared completed migration marker",
    );
    await expect(migrationStore.lookup(state.REEF_AUDIT_MIGRATION_KEY)).resolves.toBeUndefined();
  });

  it("blocks runtime audit writes until a failed legacy import is repaired", async () => {
    const filePath = writeLegacy("audit.jsonl", "{broken\n");
    const failed = await migrate("audit-jsonl");
    expectWarnings(failed, "Failed importing Reef audit trail");
    const migrationStore = openStore<{ pending: true }>("auditMigration");
    await expect(migrationStore.lookup(state.REEF_AUDIT_MIGRATION_KEY)).resolves.toEqual({
      pending: true,
    });
    await expectBlocked("audit", incompleteMigration);

    const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
    await audit.appendEvent("repaired", { id: 1 }, 10);
    fs.writeFileSync(filePath, jsonLines(await audit.entries()));

    const repaired = await migrate("audit-jsonl");
    expect(repaired.warnings).toEqual([]);
    await expect(migrationStore.lookup(state.REEF_AUDIT_MIGRATION_KEY)).resolves.toBeUndefined();
    await migrate("runtime-files");
    await expect(state.openStores(createRuntime(stateDir), reefKeys())).resolves.toBeDefined();
  });

  it("imports registration and durable runtime state before archiving files", async () => {
    const legacyDir = createLegacyDir();
    writeLegacy("identity.json", identityBinding);
    writeLegacy("setup-session.json", {
      session: "setup-secret",
      relayUrl: "https://reefwire.ai",
      email: "molty@example.com",
    });
    const replayId = "01JZ0000000000000000000000";
    const secondReplayId = "01JZ0000000000000000000001";
    writeLegacy(
      "replay.jsonl",
      jsonLines([
        { op: "claim", peer: "alice", id: replayId, envelopeHash: "a".repeat(64) },
        { op: "consume", peer: "alice", id: replayId },
        { op: "claim", peer: "bob", id: secondReplayId, envelopeHash: "d".repeat(64) },
      ]),
    );
    const review = reviewRequest(replayId);
    writeLegacy("reviews.json", { [review.approvalDigest]: { review, approved: true } });
    writeLegacy("delivered.json", [replayId]);
    const partiallyImportedReplay = openStore<replay.ReefReplayRecord>("replay");
    await partiallyImportedReplay.register(replay.reefReplayStoreKey("alice", replayId), {
      peer: "alice",
      id: replayId,
      envelopeHash: "a".repeat(64),
      state: "consumed",
    });

    const registration = await migrate("registration-json");
    const runtimeState = await migrate("runtime-files");
    await expectBlocked("generate", /has no stored keys/);

    expect(registration.warnings).toEqual([]);
    expect(registration.changes).toHaveLength(4);
    expect(runtimeState.warnings).toEqual([]);
    expect(runtimeState.changes).toHaveLength(7);
    for (const filename of [
      "identity.json",
      "setup-session.json",
      "replay.jsonl",
      "reviews.json",
      "delivered.json",
    ]) {
      expectArchive(path.join(legacyDir, filename), true);
    }
    const replayStore = openStore<replay.ReefReplayRecord>("replay");
    await expect(
      Promise.all([
        replayStore.lookup(replay.reefReplayStoreKey("alice", replayId)),
        replayStore.lookup(replay.reefReplayStoreKey("bob", secondReplayId)),
        openStore<state.ReefReviewRecord>("reviews").lookup(review.approvalDigest),
        openStore<{ id: string }>("delivered").lookup(replayId),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ state: "consumed", envelopeHash: "a".repeat(64) }),
      expect.objectContaining({ state: "available", envelopeHash: "d".repeat(64) }),
      { review, approved: true },
      { id: replayId },
    ]);
  });

  it.each([
    ["replay.jsonl", replay.REEF_REPLAY_NAMESPACE, "Reef replay state"],
    ["reviews.json", state.REEF_REVIEWS_NAMESPACE, "Reef reviews"],
    ["delivered.json", state.REEF_DELIVERED_NAMESPACE, "Reef delivered markers"],
  ])("retains %s after a refused runtime insert", async (filename, namespace, label) => {
    const legacyDir = createLegacyDir();
    const review = reviewRequest();
    const sources = {
      "replay.jsonl": `${JSON.stringify({ op: "claim", peer: "alice", id: "replay-id", envelopeHash: "a".repeat(64) })}\n`,
      "reviews.json": JSON.stringify({ [review.approvalDigest]: { review } }),
      "delivered.json": JSON.stringify(["delivered-id"]),
    };
    for (const [name, source] of Object.entries(sources)) {
      fs.writeFileSync(path.join(legacyDir, name), source);
    }

    const result = await migrate(
      "runtime-files",
      migrationParams({}, createDoctorContext(env, namespace)),
    );

    expect(result.warnings).toContainEqual(expect.stringContaining(`Failed importing ${label}`));
    expect(result.warnings).toContainEqual(
      expect.stringContaining("left migration blocker in place"),
    );
    for (const [name, source] of Object.entries(sources)) {
      const filePath = path.join(legacyDir, name);
      expectArchive(filePath, name !== filename, source);
    }
    await expectBlocked("load");
  });

  it("leaves oversized replay and delivered sources blocked and unarchived", async () => {
    const replayPath = writeLegacy(
      "replay.jsonl",
      jsonLines(
        Array.from({ length: replay.REEF_REPLAY_MAX_ENTRIES + 1 }, (_, index) => ({
          op: "claim",
          peer: "alice",
          id: `replay-${index}`,
          envelopeHash: `replay-${index}`,
        })),
      ),
    );
    const deliveredPath = writeLegacy(
      "delivered.json",
      Array.from(
        { length: state.REEF_DELIVERED_MAX_ENTRIES + 1 },
        (_, index) => `delivered-${index}`,
      ),
    );
    const result = await migrate("runtime-files");

    expect(result.changes).toEqual([]);
    expectWarnings(
      result,
      `${replay.REEF_REPLAY_MAX_ENTRIES + 1} replay bindings exceed plugin-state capacity`,
      `${state.REEF_DELIVERED_MAX_ENTRIES + 1} delivered markers exceed plugin-state capacity`,
      "Reef durable state migration is incomplete",
    );
    for (const filePath of [replayPath, deliveredPath]) {
      expectArchive(filePath, false);
    }
  });

  it.each([0, 1])("imports valid trust rows with invalid rows=%s", async (invalid) => {
    const cfg = legacyConfig(invalid ? { broken: { autonomy: "extended" } } : {});
    const migration = migrationById("config-trust");
    const params = migrationParams(cfg);

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [`- Reef peer trust: config -> plugin state (1 peer(s), ${invalid} invalid)`],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Migrated Reef peer trust -> plugin state (1 imported, 0 already present)"],
      warnings: invalid
        ? ["Skipped 1 invalid Reef peer trust row(s); left legacy friends config in place"]
        : [],
    });
    if (invalid) {
      const normalized = normalizeCompatibilityConfig({ cfg });
      expect(normalized.config.channels?.reef).toHaveProperty("friends.broken");
      expect(normalized.config.channels?.reef).not.toHaveProperty("dmPolicy");
      expect(normalized.config.channels?.reef).not.toHaveProperty("allowFrom");
      return;
    }

    const canonical = ReefChannelConfigSchema.parse({
      handle: "owner",
      relayUrl: "https://reefwire.ai",
      requestPolicy: "code-only",
    });
    const store = openStore<{
      revision: number;
      trust: { autonomy: string; approvedAt: number };
    }>("trust");
    const peerKey = resolveReefTrustStoreKey(canonical, "peer");
    await expect(store.lookup(peerKey)).resolves.toMatchObject({
      revision: 1,
      trust: { autonomy: "extended", approvedAt: 0 },
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual(unchanged);
    await store.delete(peerKey);
    await expect(migration.migrateLegacyState(params)).resolves.toEqual(unchanged);
    await expect(store.lookup(peerKey)).resolves.toBeUndefined();
  });

  it("does not partially migrate when the trust namespace is full", async () => {
    const registerIfAbsent = vi.fn();
    const fullContext = {
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

    const result = await migrate("config-trust", migrationParams(legacyConfig(), fullContext));
    expect(result).toEqual({
      changes: [],
      warnings: [
        "Skipped Reef peer trust migration because plugin state has room for 0 of 1 trust row(s) and 0 of 1 import marker(s); left legacy friends config in place",
      ],
    });
    expect(registerIfAbsent).not.toHaveBeenCalled();
  });
});
