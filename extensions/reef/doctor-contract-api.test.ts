import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  const migration = stateMigrations.find((entry) => entry.id === `reef-${name}-to-plugin-state`);
  expect(migration).toBeDefined();
  return migration!;
}

function reefKeys(): ReefKeys {
  return {
    ...generateIdentity(),
    auditKey: base64url(new Uint8Array(32).fill(1)),
    replayKey: base64url(new Uint8Array(32).fill(2)),
    keyEpoch: 1,
  };
}

const review: ReviewRequest = {
  id: "replay-id",
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
const canonicalConfig = ReefChannelConfigSchema.parse({
  handle: "owner",
  relayUrl: "https://reefwire.ai",
  requestPolicy: "code-only",
});
const replayClaim = (id: string, peer = "alice", envelopeHash = id) => ({
  op: "claim",
  peer,
  id,
  envelopeHash,
});
const storeSpecs = {
  keys: [state.REEF_KEYS_NAMESPACE, state.REEF_KEYS_MAX_ENTRIES],
  identity: [state.REEF_KEYS_MIGRATION_NAMESPACE, state.REEF_KEYS_MIGRATION_MAX_ENTRIES],
  durable: [state.REEF_DURABLE_MIGRATION_NAMESPACE, state.REEF_DURABLE_MIGRATION_MAX_ENTRIES],
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
  const peer = {
    autonomy: "extended",
    ed25519PublicKey: identity.signing.publicKey,
    x25519PublicKey: identity.encryption.publicKey,
    keyEpoch: 2,
    safetyNumberChanged: false,
  };
  const reef = {
    ...canonicalConfig,
    dmPolicy: "pairing",
    allowFrom: ["peer"],
    friends: { peer, ...extraFriends },
  };
  return { channels: { reef } } as OpenClawConfig;
}

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

function migrationParams(config: OpenClawConfig = {}, migrationContext = context, dir = stateDir) {
  return {
    config,
    env,
    stateDir: dir,
    oauthDir: path.join(dir, "oauth"),
    context: migrationContext,
  };
}

function migrate(name: string, params = migrationParams(), refusedNamespace?: string) {
  return migrationById(name).migrateLegacyState(
    refusedNamespace ? { ...params, context: createDoctorContext(env, refusedNamespace) } : params,
  );
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
  return expectStored("identity", state.REEF_KEYS_MIGRATION_KEY, expected);
}

function expectStored(name: keyof typeof storeSpecs, key: string, expected: unknown) {
  return expect(openStore(name).lookup(key)).resolves.toEqual(expected);
}

async function migrateSuccessfully(name: string, params = migrationParams()) {
  const result = await migrate(name, params);
  expect(result.warnings).toEqual([]);
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

it.each([
  ["keys.json", "keys"],
  ["identity.json", "registration"],
  ["setup-session.json", "registration"],
  ["audit.jsonl", "audit"],
  ["replay.jsonl", "replay"],
  ["reviews.json", "reviews"],
  ["delivered.json", "delivered"],
] as const)("retains malformed UTF-8 in %s before importing", async (filename, target) => {
  // UTF-8 validation must precede JSON/record parsing for every source owner.
  const filePath = writeLegacy(filename, "");
  const bytes = Buffer.from([0xff]);
  fs.writeFileSync(filePath, bytes);
  const params = migrationParams();
  const warnings: string[] = [];
  for (const migration of stateMigrations) {
    if (await migration.detectLegacyState(params)) {
      const migrationResult = await migration.migrateLegacyState(params);
      if (migrationResult.warnings.length > 0) {
        expect(migrationResult.warningDisposition).toBe("recoverable");
        warnings.push(...migrationResult.warnings);
      }
    }
  }
  expect(warnings).toContainEqual(expect.stringContaining("valid UTF-8"));
  expect(fs.readFileSync(filePath)).toEqual(bytes);
  expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
  expect(await openStore(target).entries()).toEqual([]);
  await expectStored("durable", state.REEF_DURABLE_MIGRATION_KEY, { pending: true });
});

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

  expect(result.config.channels?.reef).toEqual({ handle: "canonical", email: "o@example.com" });
  expect(result.config.plugins?.entries?.reef).toEqual({});
});

it.each([false, true])(
  "imports a default-home identity only if configured=%s",
  async (configured) => {
    const keys = reefKeys();
    const homeKeysPath = writeLegacy("keys.json", keys);
    const legacyDir = path.dirname(homeKeysPath);
    const isolatedStateDir = path.join(stateDir, "isolated");
    env = { ...env, OPENCLAW_STATE_DIR: isolatedStateDir };
    context = createDoctorContext(env);
    const config = configured ? { channels: { reef: { stateDir: legacyDir } } } : {};
    const params = migrationParams(config, context, isolatedStateDir);
    const migration = migrationById("keys-json");
    if (configured) {
      expect(await migration.detectLegacyState(params)).not.toBeNull();
      await migrateSuccessfully("keys-json", params);
      await expectStored("keys", state.REEF_KEYS_KEY, keys);
    } else {
      await expect(migration.detectLegacyState(params)).resolves.toBeNull();
      await expect(migration.migrateLegacyState(params)).resolves.toEqual(unchanged);
      await expectStored("keys", state.REEF_KEYS_KEY, undefined);
    }
    expectArchive(homeKeysPath, configured);
  },
);

it("retains refused identity imports and keeps runtime blocked", async () => {
  const source = JSON.stringify(reefKeys());
  const filePath = writeLegacy("keys.json", source);
  const result = await migrate("keys-json", undefined, state.REEF_KEYS_NAMESPACE);

  expectWarnings(result, "Failed importing Reef identity keys");
  expectArchive(filePath, false, source);
  await expectBlocked("load");
});

it("blocks identity regeneration after a failed keys.json import", async () => {
  const filePath = writeLegacy("keys.json", "{broken");
  expectWarnings(await migrate("keys-json"), "Failed importing Reef identity keys");
  fs.rmSync(filePath);
  const missingSourceResult = await migrate("keys-json");
  expectWarnings(missingSourceResult, "migration is incomplete and keys.json is missing");
  expect(missingSourceResult.warningDisposition).toBeUndefined();
  await expectBlocked("generate");
});

it.each([
  ["file", false],
  ["config", false],
  ["file", true],
  ["config", true],
] as const)("binds legacy keys from %s, refused=%s", async (source, refused) => {
  const keys = reefKeys();
  writeLegacy("keys.json", keys);
  const binding = {
    ...identityBinding,
    relayUrl: "https://reefwire.ai/",
    email: "not-an-email",
  };
  const identityPath = source === "file" ? writeLegacy("identity.json", identityBinding) : "";
  const params = migrationParams(source === "config" ? { channels: { reef: binding } } : {});
  if (source === "config") {
    expect(await migrationById("registration-json").detectLegacyState(params)).not.toBeNull();
  }
  await migrateSuccessfully("keys-json", params);
  await expectIdentityMarker(pendingIdentity);
  if (source === "file") {
    await expectBlocked("load", incompleteMigration);
  }
  if (refused) {
    const result = await migrate("registration-json", params, state.REEF_REGISTRATION_NAMESPACE);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Failed importing Reef identity"),
    );
    if (source === "file") {
      expectArchive(identityPath, false, JSON.stringify(identityBinding));
    }
    await expectBlocked("load");
    return;
  }
  await migrateSuccessfully("registration-json", params);
  await expectStored("registration", state.REEF_REGISTRATION_IDENTITY_KEY, identityBinding);
  await expectIdentityMarker(undefined);
  if (source === "file") {
    await expectBlocked("load", incompleteMigration);
    await migrate("runtime-files", params);
    await expect(state.loadKeys(createRuntime(stateDir))).resolves.toEqual(keys);
  }
});

it("keeps identity migration blocked when config conflicts with the imported binding", async () => {
  writeLegacy("keys.json", reefKeys());
  writeLegacy("identity.json", identityBinding);
  const params = migrationParams({
    channels: { reef: { ...identityBinding, handle: "conflict" } },
  });

  await migrate("keys-json", params);
  const result = await migrate("registration-json", params);

  expectWarnings(result, "configured handle or relay differs", "identity migration is incomplete");
  await expectIdentityMarker(pendingIdentity);
});

it.each([
  ["fresh", undefined],
  ["refused entry", state.REEF_AUDIT_NAMESPACE],
  ["refused head", state.REEF_AUDIT_HEAD_NAMESPACE],
  ["malformed", undefined],
] as const)("imports and verifies the audit chain: %s", async (scenario, refusedNamespace) => {
  const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
  await audit.appendEvent("one", { id: 1 }, 10);
  await audit.appendEvent("two", { id: 2 }, 11);
  const entries = await audit.entries();
  const source = jsonLines(entries);
  const filePath = writeLegacy("audit.jsonl", source);
  const malformed = scenario === "malformed";
  if (malformed) {
    fs.writeFileSync(filePath, "{broken\n");
  }
  if (scenario !== "fresh") {
    const failed = await migrate("audit-jsonl", undefined, refusedNamespace);
    expectWarnings(failed, "Failed importing Reef audit trail");
    expectArchive(filePath, false, malformed ? "{broken\n" : source);
    await expectStored("auditMigration", state.REEF_AUDIT_MIGRATION_KEY, { pending: true });
    await expectBlocked("audit");
  }
  if (malformed) {
    fs.writeFileSync(filePath, source);
  }
  await migrateSuccessfully("audit-jsonl");
  expectArchive(filePath, true, source);
  await expectStored("auditMigration", state.REEF_AUDIT_MIGRATION_KEY, undefined);
  // Runtime readback verifies the head/hash/sequence and entry payloads below.
  await expectStored(
    "head",
    state.REEF_AUDIT_HEAD_KEY,
    expect.objectContaining({ oldestHash: entries[0]!.entryHash }),
  );
  await expectStored(
    "audit",
    state.reefAuditEntryKey(entries[0]!.entryHash),
    expect.objectContaining({ nextHash: entries[1]!.entryHash }),
  );
  await migrate("runtime-files");
  const stores = await state.openStores(createRuntime(stateDir), reefKeys());
  await expect(stores.audit.entries()).resolves.toEqual(entries);
});

it("finishes an interrupted migration of an empty audit trail", async () => {
  const filePath = writeLegacy("audit.jsonl", "");
  await migrateSuccessfully("audit-jsonl");
  expect(fs.existsSync(filePath)).toBe(false);

  const migrationStore = openStore<{ pending: true; expectedEntries: number }>("auditMigration");
  await migrationStore.register(state.REEF_AUDIT_MIGRATION_KEY, {
    pending: true,
    expectedEntries: 0,
  });

  await migrateSuccessfully("audit-jsonl");
  await expect(migrationStore.lookup(state.REEF_AUDIT_MIGRATION_KEY)).resolves.toBeUndefined();
});

it.each([
  [undefined, "", ""],
  [replay.REEF_REPLAY_NAMESPACE, "replay.jsonl", "Reef replay state"],
  [state.REEF_REVIEWS_NAMESPACE, "reviews.json", "Reef reviews"],
  [state.REEF_DELIVERED_NAMESPACE, "delivered.json", "Reef delivered markers"],
])("imports runtime state, refusing namespace=%s", async (namespace, refusedFile, label) => {
  const replayId = review.id;
  const secondReplayId = "second-id";
  const reviewRecord = namespace ? { review } : { review, approved: true };
  const sources = {
    "identity.json": JSON.stringify(identityBinding),
    "setup-session.json": JSON.stringify({
      session: "setup-secret",
      ...identityBinding,
      email: "molty@example.com",
    }),
    "replay.jsonl": jsonLines([
      replayClaim(replayId, "alice", "a".repeat(64)),
      { op: "consume", peer: "alice", id: replayId },
      replayClaim(secondReplayId, "bob", "d".repeat(64)),
    ]),
    "reviews.json": JSON.stringify({ [review.approvalDigest]: reviewRecord }),
    "delivered.json": JSON.stringify([replayId]),
  };
  for (const [name, source] of Object.entries(sources)) {
    writeLegacy(name, source);
  }
  if (!namespace) {
    await openStore<replay.ReefReplayRecord>("replay").register(
      replay.reefReplayStoreKey("alice", replayId),
      {
        peer: "alice",
        id: replayId,
        envelopeHash: "a".repeat(64),
        state: "consumed",
      },
    );
  }
  await migrateSuccessfully("registration-json");
  const result = await migrate("runtime-files", undefined, namespace);
  for (const [name, source] of Object.entries(sources)) {
    expectArchive(path.join(createLegacyDir(), name), name !== refusedFile, source);
  }
  if (namespace) {
    expect(result.warnings).toContainEqual(expect.stringContaining(`Failed importing ${label}`));
    expect(result.warningDisposition).toBeUndefined();
    expect(result.notices).toContainEqual(
      expect.stringContaining("left migration blocker in place"),
    );
    await expectBlocked("load");
    return;
  }
  expect(result.warnings).toEqual([]);
  await expectBlocked("generate", /has no stored keys/);
  await expectStored(
    "replay",
    replay.reefReplayStoreKey("alice", replayId),
    expect.objectContaining({ state: "consumed", envelopeHash: "a".repeat(64) }),
  );
  await expectStored(
    "replay",
    replay.reefReplayStoreKey("bob", secondReplayId),
    expect.objectContaining({ state: "available", envelopeHash: "d".repeat(64) }),
  );
  await expectStored("reviews", review.approvalDigest, reviewRecord);
  await expectStored("delivered", replayId, { id: replayId });
});

it("leaves oversized replay and delivered sources blocked and unarchived", async () => {
  const replayCount = replay.REEF_REPLAY_MAX_ENTRIES + 1;
  const deliveredCount = state.REEF_DELIVERED_MAX_ENTRIES + 1;
  const claims = Array.from({ length: replayCount }, (_, i) => replayClaim(`replay-${i}`));
  const delivered = Array.from({ length: deliveredCount }, (_, i) => `delivered-${i}`);
  const paths = [
    writeLegacy("replay.jsonl", jsonLines(claims)),
    writeLegacy("delivered.json", delivered),
  ];
  const result = await migrate("runtime-files");

  expectWarnings(
    result,
    `${replayCount} replay bindings exceed plugin-state capacity`,
    `${deliveredCount} delivered markers exceed plugin-state capacity`,
  );
  expect(result.warningDisposition).toBeUndefined();
  expect(result.notices).toContainEqual(
    expect.stringContaining("Reef durable state migration is incomplete"),
  );
  for (const filePath of paths) {
    expectArchive(filePath, false);
  }
});

it.each([0, 1])("imports valid trust rows with invalid rows=%s", async (invalid) => {
  const cfg = legacyConfig(invalid ? { broken: { autonomy: "extended" } } : {});
  const migration = migrationById("config-trust");
  const params = migrationParams(cfg);

  expect(await migration.detectLegacyState(params)).not.toBeNull();
  const result = await migrate("config-trust", params);
  expectWarnings(result, ...(invalid ? ["Skipped 1 invalid Reef peer trust row"] : []));
  if (invalid) {
    const normalized = normalizeCompatibilityConfig({ cfg });
    expect(normalized.config.channels?.reef).toHaveProperty("friends.broken");
    expect(normalized.config.channels?.reef).not.toHaveProperty("dmPolicy");
    expect(normalized.config.channels?.reef).not.toHaveProperty("allowFrom");
    return;
  }

  const store = openStore("trust");
  const peerKey = resolveReefTrustStoreKey(canonicalConfig, "peer");
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
          })),
        registerIfAbsent,
      } as never;
    },
  } as PluginDoctorStateMigrationContext;

  const result = await migrate("config-trust", migrationParams(legacyConfig(), fullContext));
  expectWarnings(
    result,
    "plugin state has room for 0 of 1 trust row(s) and 0 of 1 import marker(s)",
  );
  expect(registerIfAbsent).not.toHaveBeenCalled();
});
