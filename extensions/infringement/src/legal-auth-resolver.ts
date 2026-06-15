import type { RowDataPacket } from "mysql2/promise";
import { executeQuery } from "./mysql-client.js";
import type { MySqlConfig } from "./types.js";

/**
 * Infringement access for a user.
 *
 * Unlike feed_query (per-topic customer isolation), the 图文/视频侵权检测 module
 * is a staff workbench: entity_auth(entityType='Legal') is a binary ACCESS GATE,
 * not a row-level scope. Once granted, the user works the shared case pool.
 * secret=1 cases are withheld unless the user is a superuser (legal_user_role.su=1),
 * matching the separate "secret vault" in InfringementController.
 *
 * NOTE: entity_auth.entityId for 'Legal' references the legacy LegalCheckJob, not
 * infringement_case — so it is only ever used as a gate, never as a join key.
 */
export interface LegalAccess {
  /** True when the user has at least one entity_auth(Legal) grant. */
  authorized: boolean;
  /** True when legal_user_role.su = 1 (may see secret=1 cases). */
  isSuperUser: boolean;
}

interface CacheEntry {
  access: LegalAccess;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolves infringement access server-side. The userId comes from the trusted
 * tool factory context (never from LLM params), so this resolver is the security
 * boundary. Results are cached per uid; on a DB blip a stale entry is served
 * rather than throwing (grants change rarely).
 */
export class LegalAuthResolver {
  private readonly config: MySqlConfig;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(config: MySqlConfig) {
    this.config = config;
  }

  async getAccess(userId: string): Promise<LegalAccess> {
    if (!userId) {
      return { authorized: false, isSuperUser: false };
    }

    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.access;
    }

    try {
      const [authorized, isSuperUser] = await Promise.all([
        this.hasLegalGrant(userId),
        this.isSuperUser(userId),
      ]);
      const access: LegalAccess = { authorized, isSuperUser };
      this.cache.set(userId, { access, expiresAt: Date.now() + CACHE_TTL_MS });
      return access;
    } catch (error) {
      if (cached) {
        return cached.access;
      }
      throw new Error(
        `Failed to resolve infringement access for user ${userId}: ${String(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  /** True when the user has any entity_auth(entityType='Legal') row. */
  private async hasLegalGrant(userId: string): Promise<boolean> {
    const rows = await executeQuery<RowDataPacket[]>(
      this.config,
      "SELECT 1 AS ok FROM entity_auth WHERE uid = ? AND entityType = 'Legal' LIMIT 1",
      [userId],
    );
    return (rows?.length ?? 0) > 0;
  }

  /** True when legal_user_role.su = 1 (missing row => not super). */
  private async isSuperUser(userId: string): Promise<boolean> {
    const rows = await executeQuery<RowDataPacket[]>(
      this.config,
      "SELECT su FROM legal_user_role WHERE id = ?",
      [userId],
    );
    return Number(rows?.[0]?.su) === 1;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
