import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "openclaw/plugin-sdk/account-resolution";
import type { ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { verifyChain, type AuditEntry } from "./protocol/index.js";
import { ReefChannelConfigSchema, normalizeReefTarget } from "./src/config-schema.js";
import { ReefPeerTrustSchema, type ReefPeerTrust } from "./src/friend-types.js";
import {
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_MAX_ENTRIES,
  REEF_AUDIT_NAMESPACE,
  REEF_KEYS_KEY,
  REEF_KEYS_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_KEY,
  REEF_KEYS_MIGRATION_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_NAMESPACE,
  REEF_KEYS_NAMESPACE,
  REEF_REGISTRATION_IDENTITY_KEY,
  REEF_REGISTRATION_MAX_ENTRIES,
  REEF_REGISTRATION_NAMESPACE,
  REEF_REGISTRATION_SESSION_KEY,
  parseReefIdentityBinding,
  parseReefKeys,
  parseReefSetupSession,
  reefAuditEntryKey,
  type ReefIdentityBinding,
  type ReefSetupSession,
  type ReefAuditStateRecord,
} from "./src/state.js";
import {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  resolveReefTrustStoreKey,
} from "./src/trust-store.js";
import type { ReefKeys } from "./src/types.js";

const RETIRED_REEF_CONFIG_KEYS = ["friends", "dmPolicy", "allowFrom"] as const;
const REEF_CONFIG_IMPORT_NAMESPACE = "peer-state-config-imports";
const LegacyReefFriendSchema = ReefPeerTrustSchema.omit({ approvedAt: true });
const REEF_TRANSIENT_LEGACY_FILENAMES = ["replay.jsonl", "reviews.json", "delivered.json"];

type ReefPeerStateSnapshot = {
  revision: number;
  trust: ReefPeerTrust;
};

type ReefConfigImportMarker = {
  version: 1;
  importedAt: number;
};

type ReefLegacyRegistrationSource =
  | {
      filename: "identity.json";
      key: typeof REEF_REGISTRATION_IDENTITY_KEY;
      parse: typeof parseReefIdentityBinding;
      label: string;
    }
  | {
      filename: "setup-session.json";
      key: typeof REEF_REGISTRATION_SESSION_KEY;
      parse: typeof parseReefSetupSession;
      label: string;
    };

const REEF_LEGACY_REGISTRATION_SOURCES: ReefLegacyRegistrationSource[] = [
  {
    filename: "identity.json",
    key: REEF_REGISTRATION_IDENTITY_KEY,
    parse: parseReefIdentityBinding,
    label: "Reef identity binding",
  },
  {
    filename: "setup-session.json",
    key: REEF_REGISTRATION_SESSION_KEY,
    parse: parseReefSetupSession,
    label: "Reef setup session",
  },
];

function resolveLegacyReefStateDir(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): string {
  const reef = params.config.channels?.reef;
  const configured = isRecord(reef) && typeof reef.stateDir === "string" ? reef.stateDir : null;
  return configured
    ? resolveUserPath(configured, params.env)
    : path.join(params.stateDir, "data", "reef");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readLegacyReefAudit(filePath: string): Promise<AuditEntry[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const entries = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
  if (!verifyChain(entries)) {
    throw new Error("invalid Reef audit chain");
  }
  return entries;
}

function parseStoredAuditHead(value: ReefAuditStateRecord | undefined): {
  hash: string;
  seq: number;
} | null {
  if (value === undefined) {
    return null;
  }
  if (
    value.kind !== "head" ||
    typeof value.hash !== "string" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0
  ) {
    throw new Error("invalid Reef audit head");
  }
  return { hash: value.hash, seq: value.seq };
}

async function readStoredReefAudit(
  store: PluginStateKeyedStore<ReefAuditStateRecord>,
): Promise<AuditEntry[]> {
  const head = parseStoredAuditHead(await store.lookup(REEF_AUDIT_HEAD_KEY));
  if (!head) {
    return [];
  }
  const reversed: AuditEntry[] = [];
  let hash = head.hash;
  for (let seq = head.seq; seq > 0; seq--) {
    const record = await store.lookup(reefAuditEntryKey(hash));
    if (
      !record ||
      record.kind !== "entry" ||
      record.entry.entryHash !== hash ||
      record.entry.event.seq !== seq
    ) {
      throw new Error("invalid Reef audit chain state");
    }
    reversed.push(record.entry);
    hash = record.entry.prevHash;
  }
  const entries = reversed.reverse();
  if (hash !== "" || !verifyChain(entries, { head: head.hash, length: head.seq })) {
    throw new Error("invalid Reef audit chain state");
  }
  return entries;
}

function hasRetiredReefPolicyConfig(value: unknown): boolean {
  return isRecord(value) && ["dmPolicy", "allowFrom"].some((key) => Object.hasOwn(value, key));
}

function inspectLegacyReefFriends(cfg: OpenClawConfig) {
  const reef = cfg.channels?.reef;
  if (!isRecord(reef) || !Object.hasOwn(reef, "friends")) {
    return null;
  }
  const rawFriends = isRecord(reef.friends) ? reef.friends : null;
  const canonicalCandidate = { ...reef };
  for (const key of RETIRED_REEF_CONFIG_KEYS) {
    delete canonicalCandidate[key];
  }
  const parsedConfig = ReefChannelConfigSchema.safeParse(canonicalCandidate);
  const config = parsedConfig.success && parsedConfig.data.handle ? parsedConfig.data : null;
  const friends = new Map<string, z.infer<typeof LegacyReefFriendSchema>>();
  let rejected = rawFriends ? 0 : 1;
  for (const [peer, value] of Object.entries(rawFriends ?? {})) {
    const parsedFriend = LegacyReefFriendSchema.safeParse(value);
    if (normalizeReefTarget(peer) !== peer || !parsedFriend.success) {
      rejected++;
      continue;
    }
    friends.set(peer, parsedFriend.data);
  }
  return { config, friends, rejected, total: rawFriends ? Object.keys(rawFriends).length : 0 };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "reef"],
    message:
      'channels.reef dmPolicy/allowFrom are legacy; run "openclaw doctor --fix" to remove them. Peer trust is SQLite-backed.',
    match: hasRetiredReefPolicyConfig,
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const reef = cfg.channels?.reef;
  if (!isRecord(reef) || !hasRetiredReefPolicyConfig(reef)) {
    return { config: cfg, changes: [] };
  }
  const next = structuredClone(cfg);
  const nextReef = next.channels?.reef;
  if (!isRecord(nextReef)) {
    return { config: cfg, changes: [] };
  }
  const changes: string[] = [];
  for (const key of ["dmPolicy", "allowFrom"] as const) {
    if (Object.hasOwn(nextReef, key)) {
      delete nextReef[key];
      changes.push(`Removed retired Reef ${key} field.`);
    }
  }
  return {
    config: next,
    changes,
  };
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "reef-keys-json-to-plugin-state",
    label: "Reef identity keys",
    async detectLegacyState(params) {
      const filePath = path.join(resolveLegacyReefStateDir(params), "keys.json");
      const migrationStore = params.context.openPluginStateKeyedStore<{ pending: true }>({
        namespace: REEF_KEYS_MIGRATION_NAMESPACE,
        maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const sourceExists = await fileExists(filePath);
      const pending = await migrationStore.lookup(REEF_KEYS_MIGRATION_KEY);
      return sourceExists || pending
        ? {
            preview: [
              sourceExists
                ? "- Reef identity keys -> plugin state (identity)"
                : "- Verify Reef identity-key migration marker",
            ],
          }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = path.join(resolveLegacyReefStateDir(params), "keys.json");
      const migrationStore = params.context.openPluginStateKeyedStore<{ pending: true }>({
        namespace: REEF_KEYS_MIGRATION_NAMESPACE,
        maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const store = params.context.openPluginStateKeyedStore<ReefKeys>({
        namespace: REEF_KEYS_NAMESPACE,
        maxEntries: REEF_KEYS_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      if (!(await fileExists(filePath))) {
        try {
          parseReefKeys(await store.lookup(REEF_KEYS_KEY));
          await migrationStore.delete(REEF_KEYS_MIGRATION_KEY);
          changes.push("Verified Reef identity keys; cleared completed migration marker");
        } catch {
          warnings.push(
            "Reef identity key migration is incomplete and keys.json is missing; left migration blocker in place",
          );
        }
        return { changes, warnings };
      }
      await migrationStore.register(REEF_KEYS_MIGRATION_KEY, { pending: true });
      let keys: ReefKeys;
      try {
        keys = parseReefKeys(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { changes, warnings };
        }
        warnings.push(
          `Failed importing Reef identity keys: ${String(error)}; left source in place`,
        );
        return { changes, warnings };
      }
      const existing = await store.lookup(REEF_KEYS_KEY);
      if (existing && JSON.stringify(existing) !== JSON.stringify(keys)) {
        warnings.push("Kept existing Reef identity keys; left differing legacy source in place");
        return { changes, warnings };
      }
      if (!existing) {
        try {
          await store.registerIfAbsent(REEF_KEYS_KEY, keys);
        } catch (error) {
          warnings.push(
            `Failed importing Reef identity keys: ${String(error)}; left source in place`,
          );
          return { changes, warnings };
        }
      }
      const persisted = await store.lookup(REEF_KEYS_KEY);
      try {
        if (JSON.stringify(parseReefKeys(persisted)) !== JSON.stringify(keys)) {
          throw new Error("persisted value differs");
        }
      } catch (error) {
        warnings.push(
          `Failed verifying Reef identity keys after import: ${String(error)}; left source in place`,
        );
        return { changes, warnings };
      }
      changes.push("Migrated Reef identity keys -> plugin state");
      const warningCount = warnings.length;
      await archiveLegacyStateSource({
        filePath,
        label: "Reef identity keys",
        changes,
        warnings,
      });
      if (warnings.length === warningCount) {
        await migrationStore.delete(REEF_KEYS_MIGRATION_KEY);
      }
      return { changes, warnings };
    },
  },
  {
    id: "reef-registration-json-to-plugin-state",
    label: "Reef registration state",
    async detectLegacyState(params) {
      const stateDir = resolveLegacyReefStateDir(params);
      const files = (
        await Promise.all(
          REEF_LEGACY_REGISTRATION_SOURCES.map(async (source) => ({
            source,
            exists: await fileExists(path.join(stateDir, source.filename)),
          })),
        )
      ).filter((entry) => entry.exists);
      return files.length > 0
        ? {
            preview: [
              `- Reef registration state -> plugin state (${files.map((entry) => entry.source.filename).join(", ")})`,
            ],
          }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const stateDir = resolveLegacyReefStateDir(params);
      const store = params.context.openPluginStateKeyedStore<
        ReefIdentityBinding | ReefSetupSession
      >({
        namespace: REEF_REGISTRATION_NAMESPACE,
        maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      for (const source of REEF_LEGACY_REGISTRATION_SOURCES) {
        const filePath = path.join(stateDir, source.filename);
        if (!(await fileExists(filePath))) {
          continue;
        }
        let legacy: ReefIdentityBinding | ReefSetupSession | undefined;
        try {
          legacy = source.parse(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
        } catch {
          // The structural validation below owns the fail-closed warning.
        }
        if (!legacy) {
          warnings.push(`Failed importing ${source.label}: invalid JSON; left source in place`);
          continue;
        }
        const existing = await store.lookup(source.key);
        const normalizedExisting = source.parse(existing);
        if (normalizedExisting && JSON.stringify(normalizedExisting) !== JSON.stringify(legacy)) {
          warnings.push(`Kept existing ${source.label}; left differing legacy source in place`);
          continue;
        }
        if (!normalizedExisting) {
          try {
            await store.registerIfAbsent(source.key, legacy);
          } catch (error) {
            warnings.push(
              `Failed importing ${source.label}: ${String(error)}; left source in place`,
            );
            continue;
          }
        }
        const persisted = source.parse(await store.lookup(source.key));
        if (!persisted || JSON.stringify(persisted) !== JSON.stringify(legacy)) {
          warnings.push(`Failed verifying ${source.label}; left source in place`);
          continue;
        }
        changes.push(`Migrated ${source.label} -> plugin state`);
        await archiveLegacyStateSource({
          filePath,
          label: source.label,
          changes,
          warnings,
        });
      }
      return { changes, warnings };
    },
  },
  {
    id: "reef-audit-jsonl-to-plugin-state",
    label: "Reef audit trail",
    async detectLegacyState(params) {
      const filePath = path.join(resolveLegacyReefStateDir(params), "audit.jsonl");
      return (await fileExists(filePath))
        ? { preview: ["- Reef audit trail -> plugin state (audit)"] }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = path.join(resolveLegacyReefStateDir(params), "audit.jsonl");
      let legacy: AuditEntry[];
      try {
        legacy = await readLegacyReefAudit(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { changes, warnings };
        }
        warnings.push(`Failed importing Reef audit trail: ${String(error)}; left source in place`);
        return { changes, warnings };
      }
      if (legacy.length + 1 > REEF_AUDIT_MAX_ENTRIES) {
        warnings.push(
          `Failed importing Reef audit trail: ${legacy.length} entries exceed plugin-state capacity; left source in place`,
        );
        return { changes, warnings };
      }
      const store = params.context.openPluginStateKeyedStore<ReefAuditStateRecord>({
        namespace: REEF_AUDIT_NAMESPACE,
        maxEntries: REEF_AUDIT_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      let canonical: AuditEntry[];
      try {
        canonical = await readStoredReefAudit(store);
      } catch (error) {
        warnings.push(
          `Failed reading canonical Reef audit trail: ${String(error)}; left legacy source in place`,
        );
        return { changes, warnings };
      }
      if (canonical.length > 0 && JSON.stringify(canonical) !== JSON.stringify(legacy)) {
        warnings.push("Kept existing Reef audit trail; left differing legacy source in place");
        return { changes, warnings };
      }
      if (canonical.length === 0 && legacy.length > 0) {
        try {
          for (const entry of legacy) {
            const key = reefAuditEntryKey(entry.entryHash);
            const existing = await store.lookup(key);
            if (existing && JSON.stringify(existing) !== JSON.stringify({ kind: "entry", entry })) {
              throw new Error(`conflicting audit entry ${entry.entryHash}`);
            }
            await store.registerIfAbsent(key, { kind: "entry", entry });
          }
          const last = legacy.at(-1)!;
          if (
            !(await store.registerIfAbsent(REEF_AUDIT_HEAD_KEY, {
              kind: "head",
              hash: last.entryHash,
              seq: last.event.seq,
            }))
          ) {
            throw new Error("audit head appeared during import");
          }
        } catch (error) {
          warnings.push(
            `Failed importing Reef audit trail: ${String(error)}; left source in place`,
          );
          return { changes, warnings };
        }
      }
      const persisted = await readStoredReefAudit(store);
      if (JSON.stringify(persisted) !== JSON.stringify(legacy)) {
        warnings.push("Failed verifying Reef audit trail after import; left source in place");
        return { changes, warnings };
      }
      changes.push(
        `Migrated ${legacy.length} Reef audit ${legacy.length === 1 ? "entry" : "entries"} -> plugin state`,
      );
      await archiveLegacyStateSource({
        filePath,
        label: "Reef audit trail",
        changes,
        warnings,
      });
      return { changes, warnings };
    },
  },
  {
    id: "reef-transient-files-to-plugin-state",
    label: "Reef transient runtime state",
    async detectLegacyState(params) {
      const stateDir = resolveLegacyReefStateDir(params);
      const files = (
        await Promise.all(
          REEF_TRANSIENT_LEGACY_FILENAMES.map(async (filename) => ({
            filename,
            exists: await fileExists(path.join(stateDir, filename)),
          })),
        )
      ).filter((entry) => entry.exists);
      return files.length > 0
        ? {
            preview: [
              `- Reef transient state: rebuild ${files.map((entry) => entry.filename).join(", ")}`,
            ],
          }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const stateDir = resolveLegacyReefStateDir(params);
      for (const filename of REEF_TRANSIENT_LEGACY_FILENAMES) {
        const filePath = path.join(stateDir, filename);
        if (!(await fileExists(filePath))) {
          continue;
        }
        try {
          await fs.rm(filePath);
          changes.push(
            `Removed retired Reef transient state ${filename}; SQLite state rebuilds empty`,
          );
        } catch (error) {
          warnings.push(
            `Failed removing retired Reef transient state ${filePath}: ${String(error)}`,
          );
        }
      }
      return { changes, warnings };
    },
  },
  {
    id: "reef-config-trust-to-plugin-state",
    label: "Reef peer trust",
    async detectLegacyState({ config, context }) {
      const legacy = inspectLegacyReefFriends(config);
      const markerStore = context.openPluginStateKeyedStore<ReefConfigImportMarker>({
        namespace: REEF_CONFIG_IMPORT_NAMESPACE,
        maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const markedKeys = new Set((await markerStore.entries()).map((entry) => entry.key));
      const legacyConfig = legacy?.config;
      const count = legacyConfig
        ? [...legacy.friends.keys()].filter(
            (peer) => !markedKeys.has(resolveReefTrustStoreKey(legacyConfig, peer)),
          ).length
        : (legacy?.friends.size ?? 0);
      const rejected = legacy?.rejected ?? 0;
      return count > 0 || rejected > 0
        ? {
            preview: [
              `- Reef peer trust: config -> plugin state (${count} peer(s), ${rejected} invalid)`,
            ],
          }
        : null;
    },
    async migrateLegacyState({ config, context }) {
      const legacy = inspectLegacyReefFriends(config);
      if (!legacy) {
        return { changes: [], warnings: [] };
      }
      const warnings: string[] = [];
      if (legacy.rejected > 0) {
        warnings.push(
          `Skipped ${legacy.rejected} invalid Reef peer trust row(s); left legacy friends config in place`,
        );
      }
      if (!legacy.config) {
        if (legacy.total > 0) {
          warnings.push(
            "Skipped Reef peer trust migration because channels.reef needs a valid handle and canonical config; left legacy friends config in place",
          );
        }
        return { changes: [], warnings };
      }
      const reefConfig = legacy.config;
      if (legacy.friends.size === 0) {
        return { changes: [], warnings };
      }
      const store = context.openPluginStateKeyedStore<ReefPeerStateSnapshot>({
        namespace: REEF_TRUST_STORE_NAMESPACE,
        maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const markerStore = context.openPluginStateKeyedStore<ReefConfigImportMarker>({
        namespace: REEF_CONFIG_IMPORT_NAMESPACE,
        maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const existingEntries = await store.entries();
      const existingKeys = new Set(existingEntries.map((entry) => entry.key));
      const markerEntries = await markerStore.entries();
      const markedKeys = new Set(markerEntries.map((entry) => entry.key));
      const pendingKeys = [...legacy.friends.keys()]
        .map((peer) => resolveReefTrustStoreKey(reefConfig, peer))
        .filter((key) => !markedKeys.has(key));
      const missingTrust = pendingKeys.filter((key) => !existingKeys.has(key));
      const availableTrust = Math.max(0, REEF_TRUST_STORE_MAX_ENTRIES - existingEntries.length);
      const availableMarkers = Math.max(0, REEF_TRUST_STORE_MAX_ENTRIES - markerEntries.length);
      if (missingTrust.length > availableTrust || pendingKeys.length > availableMarkers) {
        warnings.push(
          `Skipped Reef peer trust migration because plugin state has room for ${availableTrust} of ${missingTrust.length} trust row(s) and ${availableMarkers} of ${pendingKeys.length} import marker(s); left legacy friends config in place`,
        );
        return { changes: [], warnings };
      }
      let imported = 0;
      let alreadyPresent = 0;
      for (const [peer, trust] of legacy.friends) {
        const key = resolveReefTrustStoreKey(reefConfig, peer);
        if (markedKeys.has(key)) {
          continue;
        }
        const inserted = await store.registerIfAbsent(key, {
          revision: 1,
          trust: { ...trust, approvedAt: 0 },
        });
        if (inserted) {
          imported++;
        } else {
          alreadyPresent++;
        }
        await markerStore.registerIfAbsent(key, { version: 1, importedAt: Date.now() });
        markedKeys.add(key);
      }
      if (imported === 0 && alreadyPresent === 0) {
        return { changes: [], warnings };
      }
      return {
        changes: [
          `Migrated Reef peer trust -> plugin state (${imported} imported, ${alreadyPresent} already present)`,
        ],
        warnings,
      };
    },
  },
];
