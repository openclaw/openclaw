import type { AuthStoreBackend } from "./backend.js";
import { AUTH_STORE_VERSION, log } from "./constants.js";
import type { EncryptedPayload } from "./crypto.js";
import { decryptJson, encryptJson } from "./crypto.js";
import type { AuthProfileCredential, AuthProfileStore, ProfileUsageStats } from "./types.js";

// Lazy-loaded DB dependencies to avoid circular chunk references in the bundler.
// These are only resolved at call time (when the DB backend is actually used).
async function lazyDb() {
  const { getDatabase } = await import("../../infra/database/client.js");
  const { getDrizzle } = await import("../../infra/database/drizzle-client.js");
  const { authCredentials, authUsageStats, authStoreMeta } = await import(
    "../../infra/database/drizzle-schema.js"
  );
  return { getDatabase, getDrizzle, authCredentials, authUsageStats, authStoreMeta };
}

/**
 * Database-backed auth store. All agents share a single set of credentials,
 * eliminating token desync across agent directories.
 *
 * Credentials are encrypted with AES-256-GCM before storage.
 * The encryption key is passed at construction time.
 */
export class DbAuthStoreBackend implements AuthStoreBackend {
  private readonly encryptionKey: Buffer;
  private readonly keyVersion: number;

  constructor(encryptionKey: Buffer, keyVersion = 1) {
    if (encryptionKey.length !== 32) {
      throw new Error(`encryption key must be exactly 32 bytes (got ${encryptionKey.length})`);
    }
    this.encryptionKey = encryptionKey;
    this.keyVersion = keyVersion;
  }

  /**
   * Load ALL credentials from the DB and reconstruct an AuthProfileStore.
   * The `agentDir` parameter is intentionally ignored — all agents share one store.
   */
  load(_agentDir?: string, _options?: { allowKeychainPrompt?: boolean }): AuthProfileStore {
    // Drizzle queries are async, but the interface is sync for backwards compatibility.
    // We use a synchronous wrapper that blocks on the promise.
    // This is acceptable because auth loads happen at startup/refresh (~1-5/min).
    throw new Error(
      "DbAuthStoreBackend.load() is async-only. Use loadAsync() or loadWithLock() instead.",
    );
  }

  /**
   * Async version of load() for direct use by DB-aware consumers.
   */
  async loadAsync(): Promise<AuthProfileStore> {
    const { getDrizzle, authCredentials, authUsageStats, authStoreMeta } = await lazyDb();
    const db = getDrizzle();

    const [rows, statsRows, metaRows] = await Promise.all([
      db.select().from(authCredentials),
      db.select().from(authUsageStats),
      db.select().from(authStoreMeta),
    ]);

    const profiles: Record<string, AuthProfileCredential> = {};
    for (const row of rows) {
      try {
        const payload: EncryptedPayload = {
          ciphertext: row.encryptedData,
          iv: row.iv,
          tag: row.authTag,
        };
        const credential = decryptJson<AuthProfileCredential>(payload, this.encryptionKey);
        profiles[row.profileId] = credential;
      } catch (err) {
        log.warn("failed to decrypt credential", {
          profileId: row.profileId,
          keyVersion: row.keyVersion,
          err,
        });
      }
    }

    const usageStats: Record<string, ProfileUsageStats> = {};
    for (const row of statsRows) {
      usageStats[row.profileId] = {
        lastUsed: row.lastUsed ? row.lastUsed.getTime() : undefined,
        errorCount: row.errorCount ?? 0,
        lastFailureAt: row.lastFailureAt ? row.lastFailureAt.getTime() : undefined,
        failureCounts: (row.failureCounts as Record<string, number> | null) ?? undefined,
        cooldownUntil: row.cooldownUntil ? row.cooldownUntil.getTime() : undefined,
        disabledUntil: row.disabledUntil ? row.disabledUntil.getTime() : undefined,
        disabledReason: (row.disabledReason as ProfileUsageStats["disabledReason"]) ?? undefined,
      };
    }

    let order: Record<string, string[]> | undefined;
    let lastGood: Record<string, string> | undefined;
    for (const row of metaRows) {
      if (row.key === "order") {
        order = row.value as Record<string, string[]>;
      } else if (row.key === "lastGood") {
        lastGood = row.value as Record<string, string>;
      }
    }

    return {
      version: AUTH_STORE_VERSION,
      profiles,
      order,
      lastGood,
      usageStats: Object.keys(usageStats).length > 0 ? usageStats : undefined,
    };
  }

  /**
   * Persist the full AuthProfileStore to the DB.
   * Upserts all credentials (encrypted) and usage stats.
   * The `agentDir` parameter is intentionally ignored.
   */
  save(store: AuthProfileStore, _agentDir?: string): void {
    // Fire and forget — errors are logged but don't block the caller
    this.saveAsync(store).catch((err) => {
      log.warn("failed to save auth store to DB", { err });
    });
  }

  async saveAsync(store: AuthProfileStore): Promise<void> {
    const { getDrizzle, authCredentials, authUsageStats, authStoreMeta } = await lazyDb();
    const db = getDrizzle();

    // Upsert credentials
    for (const [profileId, credential] of Object.entries(store.profiles)) {
      const encrypted = encryptJson(credential, this.encryptionKey);
      const expiresAt =
        "expires" in credential && typeof credential.expires === "number"
          ? new Date(credential.expires)
          : null;

      await db
        .insert(authCredentials)
        .values({
          profileId,
          provider: credential.provider,
          credentialType: credential.type,
          encryptedData: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.tag,
          keyVersion: this.keyVersion,
          email: "email" in credential ? (credential.email ?? null) : null,
          expiresAt,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: authCredentials.profileId,
          set: {
            provider: credential.provider,
            credentialType: credential.type,
            encryptedData: encrypted.ciphertext,
            iv: encrypted.iv,
            authTag: encrypted.tag,
            keyVersion: this.keyVersion,
            email: "email" in credential ? (credential.email ?? null) : null,
            expiresAt,
            updatedAt: new Date(),
          },
        });
    }

    // Upsert usage stats
    if (store.usageStats) {
      for (const [profileId, stats] of Object.entries(store.usageStats)) {
        await db
          .insert(authUsageStats)
          .values({
            profileId,
            lastUsed: stats.lastUsed ? new Date(stats.lastUsed) : null,
            errorCount: stats.errorCount ?? 0,
            lastFailureAt: stats.lastFailureAt ? new Date(stats.lastFailureAt) : null,
            failureCounts: stats.failureCounts ?? {},
            cooldownUntil: stats.cooldownUntil ? new Date(stats.cooldownUntil) : null,
            disabledUntil: stats.disabledUntil ? new Date(stats.disabledUntil) : null,
            disabledReason: stats.disabledReason ?? null,
          })
          .onConflictDoUpdate({
            target: authUsageStats.profileId,
            set: {
              lastUsed: stats.lastUsed ? new Date(stats.lastUsed) : null,
              errorCount: stats.errorCount ?? 0,
              lastFailureAt: stats.lastFailureAt ? new Date(stats.lastFailureAt) : null,
              failureCounts: stats.failureCounts ?? {},
              cooldownUntil: stats.cooldownUntil ? new Date(stats.cooldownUntil) : null,
              disabledUntil: stats.disabledUntil ? new Date(stats.disabledUntil) : null,
              disabledReason: stats.disabledReason ?? null,
            },
          });
      }
    }

    // Upsert metadata (order, lastGood)
    if (store.order) {
      await db
        .insert(authStoreMeta)
        .values({ key: "order", value: store.order, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: authStoreMeta.key,
          set: { value: store.order, updatedAt: new Date() },
        });
    }
    if (store.lastGood) {
      await db
        .insert(authStoreMeta)
        .values({ key: "lastGood", value: store.lastGood, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: authStoreMeta.key,
          set: { value: store.lastGood, updatedAt: new Date() },
        });
    }
  }

  /**
   * Atomic read-modify-write using PostgreSQL advisory lock.
   * This ensures only one process/agent can update the store at a time.
   */
  async loadWithLock(params: {
    agentDir?: string;
    updater: (store: AuthProfileStore) => boolean;
  }): Promise<AuthProfileStore | null> {
    const { getDatabase } = await lazyDb();
    const pgSql = getDatabase();

    // Advisory lock ID — use a stable hash for "auth_store" namespace
    const LOCK_ID = 0x4155_5448; // "AUTH" in hex

    try {
      return await pgSql.begin(async (tx) => {
        // Acquire exclusive advisory lock within this transaction
        await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;

        // Load current state
        const store = await this.loadAsync();

        // Apply updater
        const shouldSave = params.updater(store);
        if (shouldSave) {
          await this.saveAsync(store);
        }

        return store;
        // Lock is automatically released when the transaction ends
      });
    } catch (err) {
      log.warn("failed to acquire advisory lock for auth store", { err });
      return null;
    }
  }
}
