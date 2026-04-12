/**
 * Syntropy token storage — persists the API token issued during pairing.
 *
 * Table `syntropy_tokens` stores one token per `lp_users` row (keyed by
 * the OpenClaw internal UUID, not the Clerk user ID).  Tokens are upserted
 * so re-pairing replaces the old token.
 */

import type postgres from "postgres";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureSyntropySchema(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS syntropy_tokens (
      user_id   UUID NOT NULL REFERENCES lp_users(id) ON DELETE CASCADE,
      auth_token TEXT NOT NULL,
      origin     VARCHAR(50) NOT NULL DEFAULT 'pairing',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id)
    )
  `;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Store (or replace) the Syntropy auth token for a user.
 *
 * @param sql       Postgres client
 * @param userId    OpenClaw internal UUID (`lp_users.id`)
 * @param authToken The full `sj_<short>_<long>` token string
 * @param origin    How the token was obtained (`"pairing"` or `"manual"`)
 */
export async function upsertSyntropyToken(
  sql: postgres.Sql,
  userId: string,
  authToken: string,
  origin = "pairing",
): Promise<void> {
  await sql`
    INSERT INTO syntropy_tokens (user_id, auth_token, origin)
    VALUES (${userId}, ${authToken}, ${origin})
    ON CONFLICT (user_id) DO UPDATE
      SET auth_token = EXCLUDED.auth_token,
          origin     = EXCLUDED.origin,
          updated_at = now()
  `;
}

/**
 * Retrieve the stored Syntropy auth token for a user.
 *
 * @param sql    Postgres client
 * @param userId OpenClaw internal UUID (`lp_users.id`)
 * @returns      The token string, or `null` if not stored.
 */
export async function getSyntropyToken(sql: postgres.Sql, userId: string): Promise<string | null> {
  const rows = await sql`
    SELECT auth_token FROM syntropy_tokens WHERE user_id = ${userId}
  `;
  return (rows[0]?.auth_token as string) ?? null;
}
