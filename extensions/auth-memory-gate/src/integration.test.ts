/**
 * End-to-end integration test for the identity-scoped memory stack.
 *
 * Tests the full chain across 3 plugins that share the same PostgreSQL DB:
 *   persist-user-identity (schema + commands) → auth-memory-gate (scope) → memory-graphiti (groupId)
 *
 * Requires DATABASE_URL in .env or environment.
 *
 * Run: DATABASE_URL=<url> pnpm vitest run extensions/auth-memory-gate/src/integration.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { resolveScope, formatScopeBlock, formatHardGateSystemPrompt } from "./scope.js";

// Dynamically import postgres — it lives in extension node_modules
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sql: any;

const DB_URL = process.env.DATABASE_URL;

// Skip entire suite if no DATABASE_URL
const describeIf = DB_URL ? describe : describe.skip;

describeIf("identity-scoped memory stack — integration", () => {
  const testChannel = "integration-test";
  const testPeerId = `test-peer-${Date.now()}`;
  const testPeerId2 = `test-peer2-${Date.now()}`;
  const testExternalId = `test-ext-${Date.now()}`;
  let testUserId: string;

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    sql = postgres(DB_URL!, {
      ssl: { rejectUnauthorized: false },
      max: 3,
      idle_timeout: 10,
      connect_timeout: 10,
    });

    // Ensure schema exists
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
				user_id UUID REFERENCES lp_users(id) ON DELETE CASCADE,
				channel VARCHAR(50) NOT NULL,
				channel_peer_id VARCHAR(512) NOT NULL,
				linked_at TIMESTAMPTZ DEFAULT now(),
				UNIQUE(channel, channel_peer_id)
			)
		`;
  });

  afterAll(async () => {
    if (!sql) {
      return;
    }
    // Clean up test data
    await sql`
			DELETE FROM lp_user_channels
			WHERE channel = ${testChannel}
		`;
    await sql`
			DELETE FROM lp_users
			WHERE first_name = 'IntegTest'
		`;
    await sql.end({ timeout: 5 });
  });

  test("hard gate: unregistered user gets IDENTITY_GATE", async () => {
    // Query for a peer that does not exist
    const rows = await sql`
			SELECT u.id, u.external_id, u.first_name, u.last_name,
			       uc.channel, uc.channel_peer_id,
			       (u.external_id IS NOT NULL) AS verified
			FROM lp_users u
			JOIN lp_user_channels uc ON uc.user_id = u.id
			WHERE uc.channel = ${testChannel}
			  AND uc.channel_peer_id = ${"nonexistent-peer"}
			LIMIT 1
		`;

    expect(rows.length).toBe(0);

    // When user is not found, auth-memory-gate would inject IDENTITY_GATE
    const gatePrompt = formatHardGateSystemPrompt(testChannel, "nonexistent-peer");
    expect(gatePrompt).toContain("[IDENTITY_GATE]");
    expect(gatePrompt).toContain("status: LOCKED");
    expect(gatePrompt).toContain(`channel: ${testChannel}`);
  });

  test("register: guest user gets channel-only identity", async () => {
    // Simulate /register — create user without external_id
    const [user] = await sql`
			INSERT INTO lp_users (first_name, last_name)
			VALUES ('IntegTest', 'Guest')
			RETURNING id
		`;
    testUserId = user.id;

    await sql`
			INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
			VALUES (${testUserId}, ${testChannel}, ${testPeerId})
		`;

    // Verify user exists in DB
    const rows = await sql`
			SELECT u.id, u.external_id, u.first_name, u.last_name,
			       uc.channel, uc.channel_peer_id,
			       (u.external_id IS NOT NULL) AS verified
			FROM lp_users u
			JOIN lp_user_channels uc ON uc.user_id = u.id
			WHERE uc.channel = ${testChannel}
			  AND uc.channel_peer_id = ${testPeerId}
			LIMIT 1
		`;

    expect(rows.length).toBe(1);
    expect(rows[0].external_id).toBeNull();
    expect(rows[0].verified).toBe(false);
    expect(rows[0].first_name).toBe("IntegTest");
  });

  test("scope: guest user gets scope_key = user_id (not external_id)", async () => {
    const rows = await sql`
			SELECT u.id, u.external_id, u.first_name, u.last_name,
			       uc.channel, uc.channel_peer_id,
			       (u.external_id IS NOT NULL) AS verified
			FROM lp_users u
			JOIN lp_user_channels uc ON uc.user_id = u.id
			WHERE uc.channel = ${testChannel}
			  AND uc.channel_peer_id = ${testPeerId}
			LIMIT 1
		`;

    const identity = rows[0];
    const scope = resolveScope(identity, testChannel, testPeerId);

    // Guest user: scope_key should be the internal user_id UUID
    expect(scope.scopeKey).toBe(testUserId);
    expect(scope.verified).toBe(false);

    // Verify the context block (gated is determined by config, not scope)
    const block = formatScopeBlock(scope, {});
    expect(block).toContain(`scope_key: ${testUserId}`);
    expect(block).toContain("verified: false");
    expect(block).toContain("gated: false");
  });

  test("verify: linking external_id upgrades scope_key to external_id", async () => {
    // Simulate /verify — set external_id on the user
    await sql`
			UPDATE lp_users
			SET external_id = ${testExternalId}, updated_at = now()
			WHERE id = ${testUserId}
		`;

    // Re-query
    const rows = await sql`
			SELECT u.id, u.external_id, u.first_name, u.last_name,
			       uc.channel, uc.channel_peer_id,
			       (u.external_id IS NOT NULL) AS verified
			FROM lp_users u
			JOIN lp_user_channels uc ON uc.user_id = u.id
			WHERE uc.channel = ${testChannel}
			  AND uc.channel_peer_id = ${testPeerId}
			LIMIT 1
		`;

    expect(rows[0].verified).toBe(true);
    expect(rows[0].external_id).toBe(testExternalId);

    const scope = resolveScope(rows[0], testChannel, testPeerId);

    // Verified user: scope_key should be the external_id
    expect(scope.scopeKey).toBe(testExternalId);
    expect(scope.verified).toBe(true);

    const block = formatScopeBlock(scope, {});
    expect(block).toContain(`scope_key: ${testExternalId}`);
    expect(block).toContain("verified: true");
  });

  test("cross-channel: second channel linked to same user shares scope_key", async () => {
    // Link a second channel peer to the same user
    await sql`
			INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
			VALUES (${testUserId}, ${testChannel}, ${testPeerId2})
		`;

    // Query from the second channel
    const rows = await sql`
			SELECT u.id, u.external_id, u.first_name, u.last_name,
			       uc.channel, uc.channel_peer_id,
			       (u.external_id IS NOT NULL) AS verified
			FROM lp_users u
			JOIN lp_user_channels uc ON uc.user_id = u.id
			WHERE uc.channel = ${testChannel}
			  AND uc.channel_peer_id = ${testPeerId2}
			LIMIT 1
		`;

    expect(rows.length).toBe(1);
    const scope = resolveScope(rows[0], testChannel, testPeerId2);

    // Same external_id → same scope_key across channels
    expect(scope.scopeKey).toBe(testExternalId);
    expect(scope.verified).toBe(true);
  });

  test("graphiti group_id: identity strategy resolves same scope_key as gate", async () => {
    // This simulates what memory-graphiti's resolveIdentityScopeKey does:
    // it independently queries the same tables and derives the same key
    const rows = await sql`
			SELECT u.id, u.external_id
			FROM lp_users u
			JOIN lp_user_channels uc ON uc.user_id = u.id
			WHERE uc.channel = ${testChannel}
			  AND uc.channel_peer_id = ${testPeerId}
			LIMIT 1
		`;

    // graphiti picks external_id if present, else id
    const graphitiGroupId = rows[0].external_id ?? rows[0].id;

    // gate picks the same way via resolveScope
    const gateRows = await sql`
			SELECT u.id, u.external_id, u.first_name, u.last_name,
			       uc.channel, uc.channel_peer_id,
			       (u.external_id IS NOT NULL) AS verified
			FROM lp_users u
			JOIN lp_user_channels uc ON uc.user_id = u.id
			WHERE uc.channel = ${testChannel}
			  AND uc.channel_peer_id = ${testPeerId}
			LIMIT 1
		`;
    const gateScope = resolveScope(gateRows[0], testChannel, testPeerId);

    // They must agree
    expect(graphitiGroupId).toBe(gateScope.scopeKey);
    expect(graphitiGroupId).toBe(testExternalId);
  });

  test("all linked channels listed for verified user", async () => {
    const channels = await sql`
			SELECT channel, channel_peer_id
			FROM lp_user_channels
			WHERE user_id = ${testUserId}
			ORDER BY channel_peer_id
		`;

    expect(channels.length).toBe(2);
    expect(channels[0].channel_peer_id).toBe(testPeerId);
    expect(channels[1].channel_peer_id).toBe(testPeerId2);
  });
});
