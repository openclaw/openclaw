# Feature: Identity-Scoped Memory — E2E Test Suite & Operational Documentation

## Summary

Build an end-to-end integration test suite that validates the full identity-scoped memory pipeline across multiple channels (/chat API, Slack, WhatsApp), and produce operational documentation for running OpenClaw as a multi-tenant agent with the identity plugin stack. The test suite verifies that auth context flows correctly from channel message → identity resolution → scope gate → scoped memory recall/capture, proving multi-user/multi-tenant readiness.

## User Story

As a platform operator deploying OpenClaw with identity-scoped memory
I want integration tests that prove auth context flows correctly across channels AND operational startup documentation
So that I can confidently deploy a multi-tenant agent where each user's memories are isolated and cross-channel

## Problem Statement

The 4-plugin identity stack (persist-user-identity, persist-postgres, auth-memory-gate, memory-graphiti) has unit tests per plugin, but no tests that exercise the full pipeline from channel message through to scoped memory access. There's also no operational documentation showing how to configure and start OpenClaw with all 4 plugins + web search skill for production use.

## Solution Statement

1. Create `openclaw_test` database with identity tables for isolated testing
2. Build integration tests that simulate /chat API, Slack, and WhatsApp channel contexts with real PostgreSQL + Zep Cloud backends
3. Write operational documentation covering startup configuration, `openclaw.json` reference, and channel-specific auth flows
4. Validate end-to-end by spinning up a gateway process and sending test messages

## Metadata

| Field            | Value                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Type             | ENHANCEMENT                                                                                                                   |
| Complexity       | HIGH                                                                                                                          |
| Systems Affected | extensions/auth-memory-gate, extensions/memory-graphiti, extensions/persist-user-identity, extensions/persist-postgres, test/ |
| Dependencies     | postgres (porsager), @getzep/zep-cloud, vitest                                                                                |
| Estimated Tasks  | 8                                                                                                                             |

---

## UX Design

### Before State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                   ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                             ║
║   ┌──────────────┐    ┌────────────────┐    ┌────────────────────┐          ║
║   │ Plugin Unit  │    │ Plugin Unit    │    │ Plugin Unit        │          ║
║   │ Tests (each) │    │ Tests (each)   │    │ Tests (each)       │          ║
║   └──────────────┘    └────────────────┘    └────────────────────┘          ║
║                                                                             ║
║   GAPS:                                                                     ║
║   - No test proves 4 plugins work together end-to-end                       ║
║   - No test validates channel-specific auth context (WhatsApp JID, Slack)   ║
║   - No test validates hard gate → register → verify → memory recall flow   ║
║   - No operational docs for startup configuration                           ║
║   - No test proves memory-graphiti scope_key matches auth-memory-gate       ║
║     across channel-specific session key formats                             ║
║                                                                             ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                   ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                             ║
║   ┌──────────────┐    ┌──────────────────────────────────────────┐          ║
║   │ Plugin Unit  │    │ E2E Integration Test Suite               │          ║
║   │ Tests (each) │    │                                          │          ║
║   │              │    │ ┌──────────┐ ┌───────┐ ┌──────────┐    │          ║
║   │              │    │ │ /chat API│ │ Slack │ │ WhatsApp │    │          ║
║   │              │    │ └────┬─────┘ └───┬───┘ └────┬─────┘    │          ║
║   │              │    │      │           │          │           │          ║
║   │              │    │      ▼           ▼          ▼           │          ║
║   │              │    │ ┌──────────────────────────────────┐   │          ║
║   │              │    │ │ persist-user-identity (pri 60)   │   │          ║
║   │              │    │ │ → [USER_IDENTITY] block          │   │          ║
║   │              │    │ └────────────┬─────────────────────┘   │          ║
║   │              │    │              ▼                          │          ║
║   │              │    │ ┌──────────────────────────────────┐   │          ║
║   │              │    │ │ persist-postgres (pri 50)        │   │          ║
║   │              │    │ │ → lp_messages                     │   │          ║
║   │              │    │ └────────────┬─────────────────────┘   │          ║
║   │              │    │              ▼                          │          ║
║   │              │    │ ┌──────────────────────────────────┐   │          ║
║   │              │    │ │ auth-memory-gate (pri 40)        │   │          ║
║   │              │    │ │ → [MEMORY_SCOPE] or [GATE]       │   │          ║
║   │              │    │ └────────────┬─────────────────────┘   │          ║
║   │              │    │              ▼                          │          ║
║   │              │    │ ┌──────────────────────────────────┐   │          ║
║   │              │    │ │ memory-graphiti (pri 0)          │   │          ║
║   │              │    │ │ → Zep Cloud scoped recall        │   │          ║
║   │              │    │ └──────────────────────────────────┘   │          ║
║   │              │    │                                         │          ║
║   │              │    │ Tests: hard gate, register, verify,    │          ║
║   │              │    │ cross-channel scope, memory isolation  │          ║
║   └──────────────┘    └──────────────────────────────────────────┘          ║
║                                                                             ║
║   ┌──────────────────────────────────────────────────────────────┐          ║
║   │ Operational Documentation                                    │          ║
║   │ • openclaw.json reference with all 4 plugins                 │          ║
║   │ • Startup script for dev/test                                │          ║
║   │ • Channel-specific auth context mapping                      │          ║
║   └──────────────────────────────────────────────────────────────┘          ║
║                                                                             ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File                                                  | Lines   | Why Read This                                                        |
| -------- | ----------------------------------------------------- | ------- | -------------------------------------------------------------------- |
| P0       | `extensions/auth-memory-gate/src/scope.ts`            | all     | Scope resolution, deriveChannel/derivePeerId, format functions       |
| P0       | `extensions/auth-memory-gate/src/index.ts`            | all     | Hook registration pattern, priority 40/30, gatedPeers Set            |
| P0       | `extensions/memory-graphiti/identity.ts`              | all     | Identity DB query, must match scope.ts logic                         |
| P0       | `extensions/memory-graphiti/index.ts`                 | 120-200 | Plugin registration, identity strategy, before_agent_start/agent_end |
| P0       | `extensions/persist-user-identity/src/index.ts`       | all     | Identity resolution hook (pri 60), /verify, /register commands       |
| P0       | `extensions/persist-user-identity/src/db.ts`          | all     | DB schema, createPgClient, ensureUserSchema, CRUD ops                |
| P1       | `extensions/auth-memory-gate/src/integration.test.ts` | all     | EXISTING integration test pattern to MIRROR                          |
| P1       | `test/helpers/gateway-e2e-harness.ts`                 | all     | Gateway spawn pattern (but we need plugin-loaded variant)            |
| P1       | `extensions/persist-postgres/src/db.ts`               | all     | Message persistence schema (lp_conversations, lp_messages)           |
| P2       | `extensions/memory-graphiti/config.ts`                | all     | Config schema, groupIdStrategy, deriveGroupId                        |

**External Documentation:**

| Source                                                    | Section          | Why Needed                        |
| --------------------------------------------------------- | ---------------- | --------------------------------- |
| [Zep Cloud SDK](https://docs.getzep.com)                  | User/Memory API  | userId mapping, addMemory, search |
| [porsager/postgres](https://github.com/porsager/postgres) | DDL/Transactions | CREATE DATABASE via sql.unsafe()  |

---

## Patterns to Mirror

**SESSION_KEY_CONSTRUCTION:**

```typescript
// SOURCE: extensions/auth-memory-gate/src/scope.ts:36-67
// All 3 identity plugins use identical deriveChannel / derivePeerId
// Session key format: agent:{agentId}:{channel}:direct:{peerId}
// Examples:
//   WhatsApp: agent:default:whatsapp:direct:+15551234567@s.whatsapp.net
//   Slack:    agent:default:slack:direct:U01234ABCDE
//   Webchat:  agent:default:webchat:direct:test-session-123
export function deriveChannel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts[2];
  }
  return "unknown";
}
```

**INTEGRATION_TEST_PATTERN:**

```typescript
// SOURCE: extensions/auth-memory-gate/src/integration.test.ts:15-60
// Uses dynamic postgres import, conditional describe, cleanup in afterAll
let sql: any;
const DB_URL = process.env.DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

describeIf("suite name", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    sql = postgres(DB_URL!, { ssl: { rejectUnauthorized: false }, max: 3 });
    await sql`CREATE TABLE IF NOT EXISTS ...`;
  });
  afterAll(async () => {
    // Clean up test data
    await sql`DELETE FROM ... WHERE ...`;
    await sql.end({ timeout: 5 });
  });
});
```

**GATEWAY_E2E_PATTERN:**

```typescript
// SOURCE: test/helpers/gateway-e2e-harness.ts:101-188
// Key: uses temp HOME, configPath, env vars to skip channels
// IMPORTANT: OPENCLAW_TEST_MINIMAL_GATEWAY=1 bypasses plugin loading entirely
// For our tests we must NOT set that flag — we need plugins loaded
const child = spawn(
  "node",
  ["dist/index.js", "gateway", "--port", String(port), "--bind", "loopback"],
  {
    env: {
      HOME: homeDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      // DO NOT SET: OPENCLAW_TEST_MINIMAL_GATEWAY — we need plugins
    },
  },
);
```

**PLUGIN_CONFIG_PATTERN:**

```json
// SOURCE: extensions/memory-graphiti/README.md:116-138
// openclaw.json plugins section format:
{
  "plugins": {
    "entries": {
      "persist-user-identity": { "enabled": true, "config": {} },
      "persist-postgres": { "enabled": true, "config": {} },
      "auth-memory-gate": { "enabled": true, "config": { "hardGate": true } },
      "memory-graphiti": { "enabled": true, "config": { "groupIdStrategy": "identity" } }
    }
  }
}
```

---

## Files to Change

| File                                          | Action | Justification                                             |
| --------------------------------------------- | ------ | --------------------------------------------------------- |
| `test/e2e/identity-memory-e2e.test.ts`        | CREATE | Full pipeline E2E integration test suite                  |
| `test/e2e/helpers/identity-test-db.ts`        | CREATE | Test database setup/teardown helper                       |
| `test/e2e/helpers/plugin-gateway-harness.ts`  | CREATE | Gateway spawn with plugins loaded (no MINIMAL_GATEWAY)    |
| `docs/concepts/identity-scoped-memory-ops.md` | CREATE | Operational documentation — startup, config, channel auth |
| `scripts/test-identity-e2e.sh`                | CREATE | Shell script to run E2E tests with required env vars      |
| `docs/docs.json`                              | UPDATE | Add nav entry for operational doc                         |

---

## NOT Building (Scope Limits)

- **Full gateway WebSocket E2E**: We won't spawn a real gateway and connect via WebSocket for this iteration — too complex and brittle. Instead, we test the plugin pipeline directly by exercising the hook functions with simulated channel contexts.
- **Real Slack/WhatsApp API integration**: We simulate the session key formats and context that these channels produce, not actual channel adapters.
- **LanceDB/pgvector memory backend**: Only testing Zep Cloud (Graphiti) backend, not other memory stores.
- **CI/CD pipeline integration**: Tests run locally with env vars; no CI config changes.
- **JWT token issuance**: We use the `persist-user-identity` JWT verification path with a test secret, not a real identity provider.

---

## Step-by-Step Tasks

### Task 1: CREATE `test/e2e/helpers/identity-test-db.ts`

- **ACTION**: Create helper module for test database setup/teardown
- **IMPLEMENT**:
  - `createTestDatabase(baseUrl)` — connects to `syntropy_journals`, runs `CREATE DATABASE openclaw_test` via `sql.unsafe()`
  - `setupIdentitySchema(testDbUrl)` — creates `lp_users`, `lp_user_channels`, `lp_conversations`, `lp_messages` tables
  - `seedTestUsers(sql)` — creates a verified user, an unverified user, and channel links for WhatsApp/Slack/webchat
  - `generateTestJwt(secret, sub)` — creates HS256 JWT for /verify tests
  - `cleanupTestDatabase(baseUrl)` — drops `openclaw_test`
- **MIRROR**: `extensions/auth-memory-gate/src/integration.test.ts:30-76` for schema setup
- **MIRROR**: `extensions/persist-user-identity/src/db.ts` for table definitions (ensureUserSchema)
- **IMPORTS**: `postgres`, `jsonwebtoken` or manual HS256 (check if `jose` or `jsonwebtoken` available in repo)
- **GOTCHA**: `CREATE DATABASE` cannot run inside a transaction — must use `sql.unsafe('CREATE DATABASE openclaw_test')` on the base connection. Also must handle "database already exists" error gracefully.
- **GOTCHA**: Base URL is `postgresql://postgres:postgres@localhost:5432/syntropy_journals`, test DB URL is `postgresql://postgres:postgres@localhost:5432/openclaw_test`
- **VALIDATE**: `pnpm tsgo` — types must compile

### Task 2: CREATE `test/e2e/identity-memory-e2e.test.ts` — Database Pipeline Tests

- **ACTION**: Create integration tests that exercise the identity plugin pipeline with real PostgreSQL
- **IMPLEMENT**: Test suite with the following test groups:

  **Group 1: Session Key Parsing Across Channels**
  - Test `deriveChannel` and `derivePeerId` with WhatsApp session keys: `agent:default:whatsapp:direct:+15551234567@s.whatsapp.net`
  - Test with Slack session keys: `agent:default:slack:direct:U01234ABCDE`
  - Test with webchat session keys: `agent:default:webchat:direct:test-session-123`
  - Verify all 3 plugins' implementations agree (import from auth-memory-gate/scope, memory-graphiti/identity, persist-user-identity/index)

  **Group 2: Hard Gate Flow (unregistered → register → verify)**
  - Simulate unregistered WhatsApp user: query DB returns empty → `formatHardGateSystemPrompt()` contains `[IDENTITY_GATE]`
  - Simulate `/register` by inserting user + channel link → scope resolves to `user_id`
  - Simulate `/verify` by setting `external_id` → scope resolves to `external_id`
  - Verify gate clears after registration

  **Group 3: Multi-Channel Identity Convergence**
  - Create verified user with WhatsApp channel link
  - Add Slack channel link to same user
  - Verify both channels resolve to same `scope_key` (external_id)
  - Verify `resolveIdentityScopeKey()` from memory-graphiti returns same key

  **Group 4: Zep Cloud Scoped Memory** (conditional on GETZEP_API_KEY)
  - Add episode to Zep Cloud with `userId = scope_key`
  - Search with same `userId` — should find facts
  - Search with different `userId` — should NOT find facts (isolation)
  - Clean up test user in Zep Cloud

  **Group 5: messageProvider Override**
  - Test that `ctx.messageProvider` takes priority over `deriveChannel(sessionKey)` in all 3 plugins
  - Construct context with `messageProvider: "whatsapp"` but session key `agent:default:main`
  - Verify channel resolves to `"whatsapp"`, not `"main"`

- **MIRROR**: `extensions/auth-memory-gate/src/integration.test.ts` for conditional describe, cleanup pattern
- **IMPORTS**: Import `resolveScope`, `formatScopeBlock`, `formatHardGateSystemPrompt`, `deriveChannel`, `derivePeerId` from auth-memory-gate scope.ts; `resolveIdentityScopeKey` from memory-graphiti identity.ts
- **GOTCHA**: Zep Cloud async processing — after adding episode, need small delay before search returns results. Use 2-3 second delay or retry loop.
- **GOTCHA**: Zep Cloud has 10k char limit per episode content
- **VALIDATE**: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/openclaw_test pnpm vitest run test/e2e/identity-memory-e2e.test.ts`

### Task 3: CREATE `scripts/test-identity-e2e.sh`

- **ACTION**: Create shell script that automates the E2E test lifecycle
- **IMPLEMENT**:
  ```bash
  #!/usr/bin/env bash
  # 1. Create openclaw_test database (idempotent)
  # 2. Set DATABASE_URL and GETZEP_API_KEY env vars
  # 3. Run the E2E test suite via vitest
  # 4. Optionally drop the test database (--cleanup flag)
  ```
- **MIRROR**: `scripts/test-install-sh-docker.sh` for script structure
- **GOTCHA**: Need `psql` or direct postgres connection for CREATE DATABASE. Can use the test helper from Task 1.
- **VALIDATE**: `bash scripts/test-identity-e2e.sh --dry-run`

### Task 4: CREATE `docs/concepts/identity-scoped-memory-ops.md` — Operational Documentation

- **ACTION**: Create operational guide for deploying OpenClaw with the identity-scoped memory stack
- **IMPLEMENT**:

  **Section 1: Prerequisites**
  - PostgreSQL with a database for identity tables
  - Zep Cloud API key (or self-hosted Graphiti)
  - OpenClaw installed (npm or Docker)

  **Section 2: Configuration Reference (`openclaw.json`)**
  - Full `openclaw.json` with all 4 plugins + web search skill configured
  - Environment variable mapping
  - Plugin priority explanation

  **Section 3: Startup**
  - `openclaw gateway run` with required env vars
  - Docker compose example with PostgreSQL + OpenClaw
  - Health check commands

  **Section 4: Channel-Specific Auth Context**
  - How WhatsApp peer IDs flow through (`+15551234567@s.whatsapp.net`)
  - How Slack user IDs flow through (`U01234ABCDE`)
  - How `/chat` API session keys map
  - `ctx.messageProvider` priority over session key

  **Section 5: User Lifecycle**
  - New user → hard gate → `/register` or `/verify` → scoped memory
  - Cross-channel linking via `/verify`
  - `/whoami` status check

  **Section 6: Troubleshooting**
  - Common issues (DB not connected, plugin load order, missing tables)
  - Log messages to look for

- **MIRROR**: `docs/concepts/identity-scoped-memory.md` for doc style and structure
- **VALIDATE**: Manual review — check all code examples are accurate

### Task 5: CREATE `test/e2e/helpers/plugin-gateway-harness.ts` — Gateway with Plugins

- **ACTION**: Create a gateway harness variant that loads our 4 plugins
- **IMPLEMENT**:
  - Fork from `test/helpers/gateway-e2e-harness.ts` pattern
  - Write `openclaw.json` to temp dir with plugin configuration
  - Set `OPENCLAW_BUNDLED_PLUGINS_DIR` to point to `extensions/`
  - Do NOT set `OPENCLAW_TEST_MINIMAL_GATEWAY` (need plugin loading)
  - Set `DATABASE_URL` and `GETZEP_API_KEY` in spawned process env
  - Return port, tokens, temp dir for test use
- **MIRROR**: `test/helpers/gateway-e2e-harness.ts:101-188` for spawn pattern
- **GOTCHA**: Gateway must be built first (`pnpm build`) for `dist/index.js` to exist
- **GOTCHA**: Without `OPENCLAW_TEST_MINIMAL_GATEWAY`, gateway will attempt to load all channels. Set `OPENCLAW_SKIP_CHANNELS=1` and `OPENCLAW_SKIP_PROVIDERS=1` to focus on plugin loading only.
- **VALIDATE**: `pnpm tsgo`

### Task 6: ADD Gateway-Level E2E Tests to `test/e2e/identity-memory-e2e.test.ts`

- **ACTION**: Add test group that spawns a real gateway with plugins and sends WebSocket messages
- **IMPLEMENT**:

  **Group 6: Gateway Process — /chat API Flow** (conditional on build available)
  - Spawn gateway with plugin config via harness from Task 5
  - Connect WebSocket client to `ws://127.0.0.1:{port}`
  - Send `chat.send` with session key `agent:default:webchat:direct:unregistered-user`
  - Expect hard gate response (agent only discusses verification)
  - Send simulated `/register Test User` command
  - Send another `chat.send` — expect normal response with scope injected
  - Check Zep Cloud for episode captured with correct userId

- **MIRROR**: `test/gateway.multi.e2e.test.ts` for WebSocket client usage
- **GOTCHA**: Requires `pnpm build` before running. Make test skip gracefully if dist/ not available.
- **GOTCHA**: Gateway startup can take up to 60 seconds. Use the `waitForPortOpen` pattern.
- **GOTCHA**: LLM responses require actual API keys (Anthropic, OpenAI, etc.). For CI, the gateway test should verify plugin loading and hook execution, not full LLM response.
- **VALIDATE**: `DATABASE_URL=... GETZEP_API_KEY=... pnpm vitest run test/e2e/identity-memory-e2e.test.ts`

### Task 7: UPDATE `docs/docs.json` — Add Nav Entry

- **ACTION**: Add the operational documentation to the docs navigation
- **IMPLEMENT**: Add entry under `concepts` group: `{ "title": "Identity Memory Ops", "path": "concepts/identity-scoped-memory-ops" }`
- **MIRROR**: Existing entries in `docs/docs.json` for concepts section
- **VALIDATE**: Check JSON is valid

### Task 8: Integration Validation — Run Full Suite

- **ACTION**: Execute the complete E2E test suite against local PostgreSQL + Zep Cloud
- **IMPLEMENT**:
  1. Create `openclaw_test` database:
     ```bash
     psql postgresql://postgres:postgres@localhost:5432/syntropy_journals -c "CREATE DATABASE openclaw_test"
     ```
  2. Run tests:
     ```bash
     DATABASE_URL=postgresql://postgres:postgres@localhost:5432/openclaw_test \
     GETZEP_API_KEY=z_1dWlkIjoiMDc1ODkzMWUtYjFlMi00M2Q1LThjNjAtMzAxNzkyNjBlZGFiIn0.gu87U-QhdGSOuUl3uzMvTvmMTssegezBeE-pI-bxCsr0UorxKRniQULcbEedH4sCC-OL3oBuDxVXdCdMDs5Aag \
     pnpm vitest run test/e2e/identity-memory-e2e.test.ts
     ```
  3. Optionally spin up gateway and test manually:
     ```bash
     DATABASE_URL=... GETZEP_API_KEY=... openclaw gateway run --port 3000 --bind loopback
     ```
- **VALIDATE**: All tests pass green

---

## Testing Strategy

### Test Groups

| Test Group                | Test Cases                                        | Validates                                              |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Session Key Parsing       | WhatsApp/Slack/webchat keys, edge cases           | Channel context correctly derived across all 3 plugins |
| Hard Gate Flow            | unregistered→gate, register→scope, verify→upgrade | Identity lifecycle with hard gate                      |
| Multi-Channel Convergence | Same user on WhatsApp+Slack shares scope_key      | Cross-channel memory continuity                        |
| Zep Cloud Scoped Memory   | Write+read with scopeKey, isolation test          | Memory actually scoped to user                         |
| messageProvider Override  | messageProvider wins over sessionKey              | Correct channel derivation in all plugins              |
| Gateway /chat API         | WebSocket chat.send with plugin pipeline          | Full stack E2E (optional, requires build)              |

### Edge Cases Checklist

- [ ] Session key with `main` (shared session — no peer) returns null scope
- [ ] Session key with `unknown` channel skips identity lookup
- [ ] User with external_id has scope_key = external_id, NOT user_id
- [ ] User without external_id has scope_key = user_id UUID
- [ ] Same external_id across channels → same scope_key
- [ ] Different external_ids → different scope_keys (isolation)
- [ ] Zep Cloud search with wrong userId returns empty results
- [ ] Hard gate blocks normal conversation, allows only verification discussion
- [ ] `/register` clears hard gate on next message
- [ ] `/verify` upgrades scope_key from user_id to external_id
- [ ] messageProvider="whatsapp" with sessionKey="agent:x:main" → channel="whatsapp"

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
pnpm tsgo && pnpm check
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
pnpm vitest run extensions/auth-memory-gate
pnpm vitest run extensions/memory-graphiti/index.test.ts
```

**EXPECT**: All existing plugin tests still pass

### Level 3: E2E_INTEGRATION

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/openclaw_test \
GETZEP_API_KEY=z_1dWlkIjoiMDc1ODkzMWUtYjFlMi00M2Q1LThjNjAtMzAxNzkyNjBlZGFiIn0.gu87U-QhdGSOuUl3uzMvTvmMTssegezBeE-pI-bxCsr0UorxKRniQULcbEedH4sCC-OL3oBuDxVXdCdMDs5Aag \
pnpm vitest run test/e2e/identity-memory-e2e.test.ts
```

**EXPECT**: All E2E tests pass

### Level 4: DATABASE_VALIDATION

- [ ] `openclaw_test` database exists
- [ ] `lp_users` table has correct columns (id, external_id, first_name, last_name, created_at, updated_at)
- [ ] `lp_user_channels` table has correct columns (id, user_id, channel, channel_peer_id, linked_at)
- [ ] Test data is cleaned up after test run

### Level 5: MANUAL_VALIDATION

1. Start gateway: `DATABASE_URL=... GETZEP_API_KEY=... openclaw gateway run --port 3000`
2. Connect via webchat or WebSocket client
3. Send message as unregistered user → should get hard gate response
4. Run `/register Test User` → should register and clear gate
5. Send message → should get normal response
6. Check Zep Cloud dashboard for captured episode

---

## Acceptance Criteria

- [ ] E2E test suite exercises full 4-plugin pipeline with real PostgreSQL
- [ ] Tests cover /chat API, Slack, and WhatsApp session key formats
- [ ] Hard gate → register → verify lifecycle tested end-to-end
- [ ] Zep Cloud memory scoping validated (write + read + isolation)
- [ ] Cross-channel identity convergence proven
- [ ] Operational documentation covers startup, config, and troubleshooting
- [ ] All existing plugin unit tests continue to pass
- [ ] Test script automates database setup and test execution

---

## Risks and Mitigations

| Risk                                                | Likelihood | Impact | Mitigation                                                           |
| --------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------- |
| Zep Cloud async processing delays cause flaky tests | HIGH       | MED    | Use retry loop with 5s timeout for search after episode add          |
| Local PostgreSQL not running                        | MED        | HIGH   | Skip tests gracefully with `describeIf`, provide clear error message |
| Gateway build not available for Task 6              | MED        | LOW    | Make gateway E2E tests conditional on dist/ existence                |
| Zep Cloud rate limiting during tests                | LOW        | MED    | Use unique userId per test run (timestamp suffix), clean up after    |
| Plugin import resolution in test context            | MED        | MED    | Use relative imports from extensions/ since they share root tsconfig |

---

## Notes

- **Database isolation**: Tests use `openclaw_test` database, not the production `syntropy_journals`. The test helper creates it if missing and cleans up test data after each run.
- **Zep Cloud vs self-hosted**: Tests use Zep Cloud with the provided API key. Self-hosted Graphiti testing is out of scope.
- **messageProvider priority**: All 3 identity plugins check `ctx.messageProvider` first, then fall back to `deriveChannel(sessionKey)`. This is critical for `dmScope="main"` sessions where the session key is `agent:{id}:main` with no channel segment.
- **No OPENCLAW_TEST_MINIMAL_GATEWAY**: The existing gateway E2E harness sets this flag which bypasses `loadGatewayPlugins()` entirely (uses `emptyPluginRegistry`). Our tests MUST NOT set this flag — we need plugins loaded.
- **JWT test tokens**: For `/verify` tests, we generate test JWTs signed with a known secret. The `persist-user-identity` JWT config must match this secret.
