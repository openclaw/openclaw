/**
 * Syntropy Health — consolidated OpenClaw extension.
 *
 * Owns the full lifecycle from identity gate to tool execution:
 *
 * 1. **before_agent_start** (priority 35) — Verifies the user has a stored
 *    Syntropy auth token.  Caches the resolved user for the tool factory.
 *    If no token, injects `[SYNTROPY_GATE]`.
 *
 * 2. **Tool factory** (sync) — Returns 9 health tools for users whose token
 *    was resolved in the hook.  Unverified users get no tools (hard gate).
 *
 * 3. **Token storage** — `syntropy_tokens` table (one per user, keyed by
 *    `lp_users.id`).  Tokens stored after `!verify` via persist-user-identity.
 *
 * Priority ordering:
 *   60  persist-user-identity
 *   50  persist-postgres
 *   40  auth-memory-gate
 *   35  syntropy (THIS)
 *    0  memory-graphiti
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import postgres from "postgres";
import { ensureSyntropySchema } from "./db.js";
import { createAllTools } from "./tools.js";

// ---------------------------------------------------------------------------
// Session key parsing (inlined to avoid cross-extension dependency)
// ---------------------------------------------------------------------------

function deriveChannel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  return parts.length >= 3 && parts[0] === "agent" ? parts[2] : "unknown";
}

function derivePeerId(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") return sessionKey;
  const rest = parts.slice(2);
  const directIdx = rest.indexOf("direct");
  if (directIdx >= 0 && directIdx < rest.length - 1) return rest.slice(directIdx + 1).join(":");
  return rest.length >= 2 ? rest.slice(1).join(":") : (rest[0] ?? sessionKey);
}

// ---------------------------------------------------------------------------
// Identity + token resolution
// ---------------------------------------------------------------------------

interface ResolvedUser {
  userId: string;
  externalId: string;
  authToken: string;
}

async function resolveUser(
  sql: postgres.Sql,
  channel: string,
  peerId: string,
): Promise<ResolvedUser | null> {
  const rows = await sql`
    SELECT u.id, u.external_id, st.auth_token
    FROM lp_users u
    JOIN lp_user_channels uc ON uc.user_id = u.id
    LEFT JOIN syntropy_tokens st ON st.user_id = u.id
    WHERE uc.channel = ${channel}
      AND uc.channel_peer_id = ${peerId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row?.external_id || !row?.auth_token) return null;
  return {
    userId: row.id as string,
    externalId: row.external_id as string,
    authToken: row.auth_token as string,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const SYNTROPY_GATE = `[SYNTROPY_GATE]
status: LOCKED
reason: No Syntropy auth token found for this user.

Health tools (food logging, diet scoring, check-ins) are NOT available.
The user needs to complete pairing first:
1. Log in to the Syntropy web app
2. Click "Link Device" to get a 6-digit code
3. Type: !verify <code>
[/SYNTROPY_GATE]`;

const syntropyPlugin = {
  id: "syntropy",
  name: "Syntropy Health Integration",
  description:
    "Identity gate, token storage, and health tools for Syntropy Health. " +
    "Requires persist-user-identity and auth-memory-gate plugins.",

  register(api: OpenClawPluginApi) {
    const baseUrl =
      (api.pluginConfig?.syntropyBaseUrl as string | undefined) ?? "http://localhost:3000";
    const databaseUrl =
      (api.pluginConfig?.databaseUrl as string | undefined) ?? process.env.DATABASE_URL ?? "";

    if (!databaseUrl) {
      api.logger.warn("syntropy: no databaseUrl or DATABASE_URL — plugin disabled");
      return;
    }

    const sql = postgres(databaseUrl, { max: 5 });

    ensureSyntropySchema(sql).catch((err) =>
      api.logger.error(`syntropy: schema init failed: ${err}`),
    );

    api.logger.info(`syntropy: enabled (base=${baseUrl})`);

    // Cache resolved user per session key — populated by before_agent_start,
    // consumed by the synchronous tool factory.
    const resolvedUsers = new Map<string, ResolvedUser>();

    // -----------------------------------------------------------------
    // Hook: before_agent_start (priority 35)
    // -----------------------------------------------------------------

    api.on(
      "before_agent_start",
      async (_event, ctx) => {
        try {
          const sessionKey = ctx?.sessionKey ?? "";
          const channel = ctx?.messageProvider ?? deriveChannel(sessionKey);
          const peerId = derivePeerId(sessionKey);

          if (!peerId || peerId === "main" || peerId === "unknown") return {};

          const cacheKey = `${channel}:${peerId}`;
          const user = await resolveUser(sql, channel, peerId);

          if (!user) {
            resolvedUsers.delete(cacheKey);
            return { prependContext: SYNTROPY_GATE };
          }

          // Cache for the tool factory
          resolvedUsers.set(cacheKey, user);
          return {};
        } catch (err) {
          api.logger.error(`syntropy: before_agent_start error: ${err}`);
          return {};
        }
      },
      { priority: 35 },
    );

    // -----------------------------------------------------------------
    // Tool factory (SYNC) — reads from cache populated by the hook.
    // -----------------------------------------------------------------

    api.registerTool((ctx) => {
      try {
        const sessionKey = ctx.sessionKey ?? "";
        const channel = ctx.messageChannel ?? deriveChannel(sessionKey);
        const peerId = derivePeerId(sessionKey);

        if (!peerId || peerId === "main" || peerId === "unknown") return null;

        const cacheKey = `${channel}:${peerId}`;
        const user = resolvedUsers.get(cacheKey);
        if (!user) return null;

        return createAllTools(baseUrl, user.authToken);
      } catch (err) {
        api.logger.error(`syntropy: tool factory error: ${err}`);
        return null;
      }
    });

    // -----------------------------------------------------------------
    // Shutdown
    // -----------------------------------------------------------------

    api.on(
      "gateway_stop",
      async () => {
        try {
          await sql.end({ timeout: 5 });
          api.logger.info("syntropy: database connections closed");
        } catch (err) {
          api.logger.error(`syntropy: error closing connections: ${err}`);
        }
      },
      { priority: 90 },
    );
  },
};

export default syntropyPlugin;
