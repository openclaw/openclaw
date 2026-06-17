import { createHash, randomBytes } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { execute, query } from "./db-client.js";
import type { MySqlConfig } from "./types.js";

/** Generate a raw key the same way PHP ApiKeyTable::generateApiKey does. */
function generateRawKey(): string {
  return `sk_${randomBytes(32).toString("hex")}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Resolves the per-uid backend API key for `Authorization: Bearer`.
 *
 * Order: explicit config override -> existing active api_key row -> auto-provision
 * a fresh row (mirroring PHP ApiKeyTable::generateApiKey: sk_+hex, sha256 hash,
 * raw stored in encryptedKey, no expiry). So a brand-new user needs zero manual
 * setup — the first tool call mints and caches their key. Shared across every
 * leading-v2 module so each uid is minted/cached once for the whole backend.
 */
export class ApiKeyResolver {
  private readonly overrides: Record<string, string>;
  private readonly db: MySqlConfig | undefined;
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(overrides: Record<string, string>, db: MySqlConfig | undefined) {
    this.overrides = overrides;
    this.db = db;
  }

  async getApiKey(userId: string): Promise<string> {
    const override = this.overrides[userId];
    if (override) {
      return override;
    }
    const cached = this.cache.get(userId);
    if (cached) {
      return cached;
    }
    // De-dupe concurrent first-time resolves for the same uid (avoid double mint).
    let pending = this.inflight.get(userId);
    if (!pending) {
      pending = this.resolveFromDb(userId).finally(() => this.inflight.delete(userId));
      this.inflight.set(userId, pending);
    }
    const key = await pending;
    this.cache.set(userId, key);
    return key;
  }

  private async resolveFromDb(userId: string): Promise<string> {
    if (!this.db) {
      throw new Error(
        "No API key configured for this account and no db connection to provision one.",
      );
    }
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) {
      throw new Error(`Cannot resolve an API key for non-numeric user id "${userId}".`);
    }

    const rows = await query<RowDataPacket[]>(
      this.db,
      "SELECT encryptedKey FROM api_key WHERE uid = ? AND revoked = 0 " +
        "AND (expiresAt IS NULL OR expiresAt > NOW()) ORDER BY id DESC LIMIT 1",
      [uid],
    );
    const existing = rows?.[0]?.encryptedKey;
    if (typeof existing === "string" && existing.trim()) {
      return existing.trim();
    }

    const rawKey = generateRawKey();
    await execute(
      this.db,
      "INSERT INTO api_key (uid, name, keyHash, encryptedKey, expiresAt, createdAt, revoked) " +
        "VALUES (?, 'lobster-agent', ?, ?, NULL, NOW(), 0)",
      [uid, sha256Hex(rawKey), rawKey],
    );
    return rawKey;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
