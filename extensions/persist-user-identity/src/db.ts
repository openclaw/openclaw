import postgres from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserRow = {
  id: string;
  external_id: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: Date;
  updated_at: Date;
};

export type UserChannelRow = {
  id: string;
  user_id: string;
  channel: string;
  channel_peer_id: string;
  linked_at: Date;
};

/** Joined result from user + channel lookup. */
export type ResolvedIdentity = UserRow & {
  channel: string;
  channel_peer_id: string;
  verified: boolean;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createPgClient(databaseUrl: string) {
  return postgres(databaseUrl, { max: 10 });
}

// ---------------------------------------------------------------------------
// Schema — idempotent, shares `lp_` prefix with persist-postgres
// ---------------------------------------------------------------------------

export async function ensureUserSchema(sql: postgres.Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS lp_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      external_id VARCHAR(256) UNIQUE,
      first_name VARCHAR(128),
      last_name VARCHAR(128),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS lp_user_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES lp_users(id) ON DELETE CASCADE,
      channel VARCHAR(50) NOT NULL,
      channel_peer_id VARCHAR(512) NOT NULL,
      linked_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(channel, channel_peer_id)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_lp_uc_lookup
      ON lp_user_channels (channel, channel_peer_id)
  `;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Look up a user by their channel-specific peer identifier.
 * Returns the full user row plus channel info, or null if unlinked.
 */
export async function findUserByChannelPeer(
  sql: postgres.Sql,
  channel: string,
  channelPeerId: string,
): Promise<ResolvedIdentity | null> {
  const rows = await sql`
    SELECT u.*, uc.channel, uc.channel_peer_id,
           (u.external_id IS NOT NULL) AS verified
    FROM lp_users u
    JOIN lp_user_channels uc ON uc.user_id = u.id
    WHERE uc.channel = ${channel}
      AND uc.channel_peer_id = ${channelPeerId}
    LIMIT 1
  `;
  return (rows[0] as ResolvedIdentity | undefined) ?? null;
}

/**
 * Find user by their externally-issued identifier (e.g. JWT `sub` claim).
 */
export async function findUserByExternalId(
  sql: postgres.Sql,
  externalId: string,
): Promise<UserRow | null> {
  const rows = await sql`
    SELECT * FROM lp_users WHERE external_id = ${externalId} LIMIT 1
  `;
  return (rows[0] as UserRow | undefined) ?? null;
}

/**
 * Create a new user. `externalId` is null for channel-only (unverified) users.
 */
export async function createUser(
  sql: postgres.Sql,
  opts: { firstName?: string; lastName?: string; externalId?: string },
): Promise<UserRow> {
  const rows = await sql`
    INSERT INTO lp_users (first_name, last_name, external_id)
    VALUES (${opts.firstName ?? null}, ${opts.lastName ?? null}, ${opts.externalId ?? null})
    RETURNING *
  `;
  return rows[0] as UserRow;
}

/**
 * Link a channel identity to an existing user (upsert — reassigns if already linked).
 */
export async function linkChannelToUser(
  sql: postgres.Sql,
  userId: string,
  channel: string,
  channelPeerId: string,
): Promise<UserChannelRow> {
  const rows = await sql`
    INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
    VALUES (${userId}, ${channel}, ${channelPeerId})
    ON CONFLICT (channel, channel_peer_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      linked_at = now()
    RETURNING *
  `;
  return rows[0] as UserChannelRow;
}

/**
 * Set name on an existing user.
 */
export async function updateUserName(
  sql: postgres.Sql,
  userId: string,
  firstName: string,
  lastName: string,
): Promise<UserRow> {
  const rows = await sql`
    UPDATE lp_users
    SET first_name = ${firstName}, last_name = ${lastName}, updated_at = now()
    WHERE id = ${userId}
    RETURNING *
  `;
  return rows[0] as UserRow;
}

/**
 * Upgrade a channel-only user to a verified user by setting their external_id.
 * If a user with that external_id already exists, merges by re-linking the
 * channel identity to the existing verified user.
 */
export async function linkExternalId(
  sql: postgres.Sql,
  userId: string,
  externalId: string,
  channel: string,
  channelPeerId: string,
): Promise<UserRow> {
  const existing = await findUserByExternalId(sql, externalId);

  if (existing) {
    // Verified user already exists — re-link this channel to them
    await linkChannelToUser(sql, existing.id, channel, channelPeerId);
    return existing;
  }

  // Upgrade current user to verified
  const rows = await sql`
    UPDATE lp_users
    SET external_id = ${externalId}, updated_at = now()
    WHERE id = ${userId}
    RETURNING *
  `;
  return rows[0] as UserRow;
}

/**
 * Find users by first and last name (case-insensitive exact match).
 * Used as a local DB fallback when the Syntropy Journals API is unavailable.
 */
export async function findUsersByName(
  sql: postgres.Sql,
  firstName: string,
  lastName: string,
): Promise<UserRow[]> {
  const rows = await sql`
    SELECT * FROM lp_users
    WHERE LOWER(first_name) = LOWER(${firstName})
      AND LOWER(last_name) = LOWER(${lastName})
    ORDER BY updated_at DESC
    LIMIT 5
  `;
  return rows as unknown as UserRow[];
}

/**
 * List all channel identities linked to a user.
 */
export async function listUserChannels(
  sql: postgres.Sql,
  userId: string,
): Promise<UserChannelRow[]> {
  const rows = await sql`
    SELECT * FROM lp_user_channels WHERE user_id = ${userId} ORDER BY linked_at
  `;
  return rows as unknown as UserChannelRow[];
}
