# OpenClaw SaaS — Migration Strategy and Execution Phases

> **Document:** 03-migration-strategy.md
> **Prerequisite:** 00-overview.md, 01-data-isolation.md, 02-security-encryption.md
> **Scope:** Phased migration plan, dual-write strategy, data migration procedures, rollback plans, and risk mitigation

---

## 1. Migration Principles

1. **Zero downtime** — no migration step requires full system shutdown
2. **Reversible** — every phase has an explicit rollback plan; no one-way doors in early phases
3. **Dual-write first** — new storage receives writes alongside existing filesystem; cutover only after validation
4. **Incremental** — each phase delivers independently testable value
5. **Self-hosted preservation** — filesystem path remains functional as fallback; feature flags gate SaaS paths
6. **Data integrity** — checksums and reconciliation at every migration boundary

---

## 2. Feature Flag System

All SaaS paths are gated behind feature flags resolved at startup:

```typescript
// Feature flags resolved from env + config
interface SaasFeatureFlags {
  // Phase 0
  saasMode: boolean; // OPENCLAW_SAAS_MODE=1
  databaseEnabled: boolean; // PostgreSQL connection configured

  // Phase 1
  configStoreDual: boolean; // dual-write config to DB + filesystem
  configStoreDb: boolean; // read config from DB (cutover)
  sessionStoreDual: boolean; // dual-write sessions to DB + filesystem
  sessionStoreDb: boolean; // read sessions from DB (cutover)
  secretsVault: boolean; // use encrypted tenant_secrets

  // Phase 2
  channelIsolation: boolean; // per-tenant channel routing
  mediaIsolation: boolean; // per-tenant media storage
  memoryIsolation: boolean; // per-tenant vector store (pgvector)

  // Phase 3
  billingEnabled: boolean; // billing/subscription system active
  usageMeteringEnabled: boolean; // message event tracking for billing
}

function resolveSaasFlags(env: NodeJS.ProcessEnv, config: OpenClawConfig): SaasFeatureFlags {
  const saasMode = env.OPENCLAW_SAAS_MODE === "1";
  return {
    saasMode,
    databaseEnabled: saasMode && Boolean(env.DATABASE_URL),
    configStoreDual: saasMode && env.OPENCLAW_CONFIG_STORE_DUAL === "1",
    configStoreDb: saasMode && env.OPENCLAW_CONFIG_STORE_DB === "1",
    sessionStoreDual: saasMode && env.OPENCLAW_SESSION_STORE_DUAL === "1",
    sessionStoreDb: saasMode && env.OPENCLAW_SESSION_STORE_DB === "1",
    secretsVault: saasMode && env.OPENCLAW_SECRETS_VAULT === "1",
    channelIsolation: saasMode && env.OPENCLAW_CHANNEL_ISOLATION === "1",
    mediaIsolation: saasMode && env.OPENCLAW_MEDIA_ISOLATION === "1",
    memoryIsolation: saasMode && env.OPENCLAW_MEMORY_ISOLATION === "1",
    billingEnabled: saasMode && env.OPENCLAW_BILLING === "1",
    usageMeteringEnabled: saasMode && env.OPENCLAW_USAGE_METERING === "1",
  };
}
```

---

## 3. Phase 0 — Foundation (Weeks 1–4)

### 3.1 Objectives

- PostgreSQL database provisioned and connected
- Core tables created (tenants, users, tenant_members, tenant_deks)
- Database abstraction layer introduced
- Auth service operational (JWT + OIDC)
- Self-hosted mode unchanged

### 3.2 Implementation Steps

#### Step 0.1 — Database Setup

```
1. Provision PostgreSQL 16+ instance
   - RDS/Cloud SQL for managed, or Docker for dev
   - Enable extensions: pgcrypto, pg_stat_statements, pg_trgm
   - Configure: max_connections=200, statement_timeout='30s'

2. Create database roles:
   - app_user: INSERT, SELECT, UPDATE, DELETE on app tables
   - app_admin: app_user + GRANT on audit tables + schema migration
   - app_readonly: SELECT only (for monitoring/analytics)

3. Deploy PgBouncer:
   - pool_mode = transaction
   - default_pool_size = 25
   - max_client_conn = 2000
```

#### Step 0.2 — Drizzle ORM Integration

```
1. Add dependencies:
   pnpm add drizzle-orm pg
   pnpm add -D drizzle-kit @types/pg

2. Create schema definitions:
   src/db/schema/tenants.ts
   src/db/schema/users.ts
   src/db/schema/tenant-members.ts
   src/db/schema/tenant-deks.ts
   src/db/index.ts            — connection + client factory
   src/db/rls.ts              — tenant context helpers

3. Generate and run initial migration:
   pnpm drizzle-kit generate
   pnpm drizzle-kit push

4. Integration test:
   - Create tenant → create user → add member → verify RLS isolation
```

#### Step 0.3 — Auth Service

```
1. Create auth module:
   src/auth/jwt.ts            — sign/verify JWT (ES256)
   src/auth/middleware.ts      — Express/Hono middleware
   src/auth/oidc.ts           — OIDC provider integration
   src/auth/routes.ts         — /auth/* endpoints
   src/auth/rbac.ts           — permission checks

2. Key management:
   - Generate ES256 key pair
   - Store private key in KMS or env (OPENCLAW_JWT_PRIVATE_KEY)
   - Expose JWKS endpoint at /.well-known/jwks.json

3. Self-hosted compatibility:
   - If !saasMode: skip JWT auth, use existing token/password auth
   - Auto-create default tenant + admin user on first SaaS boot
```

#### Step 0.4 — KMS / Encryption Setup

```
1. Create KMS abstraction:
   src/encryption/kms.ts         — KMS provider interface + factory
   src/encryption/kms-aws.ts     — AWS KMS implementation
   src/encryption/kms-local.ts   — Local key derivation (self-hosted)
   src/encryption/envelope.ts    — encrypt/decrypt with DEK
   src/encryption/dek-cache.ts   — in-memory DEK cache

2. Provision master KEK:
   - AWS: aws kms create-key --key-spec AES_256
   - Local: generate from OPENCLAW_MASTER_KEY via HKDF

3. Integration test:
   - Create tenant → generate DEK → encrypt secret → decrypt → verify roundtrip
```

### 3.3 Rollback Plan — Phase 0

**Risk:** Minimal. Phase 0 is additive only — no existing behavior modified.

```
Rollback: Remove OPENCLAW_SAAS_MODE=1 from env.
All SaaS code paths are gated; gateway reverts to filesystem mode.
Database tables remain but are unused.
```

### 3.4 Validation Criteria — Phase 0

- [ ] `pnpm build` passes with new DB modules
- [ ] `pnpm test` passes (all existing tests unchanged)
- [ ] New auth integration tests pass
- [ ] RLS isolation test passes (cross-tenant query returns 0 rows)
- [ ] Encryption roundtrip test passes
- [ ] Self-hosted mode (`OPENCLAW_SAAS_MODE` unset) behaves identically to pre-Phase-0

---

## 4. Phase 1 — Core Migration (Weeks 5–10)

### 4.1 Objectives

- Config store migrated to DB (dual-write, then cutover)
- Session store migrated to DB (dual-write, then cutover)
- Secrets encrypted and stored in DB
- Pairing/allowlists migrated to DB
- Audit logging active

### 4.2 Config Store Migration

#### 4.2.1 — Database Config Adapter

```typescript
// New: src/config/io-db.ts
// Implements the same interface as createConfigIO() but backed by PostgreSQL

interface ConfigStore {
  loadConfig(tenantId: string): Promise<OpenClawConfig>;
  writeConfig(tenantId: string, config: OpenClawConfig, userId?: string): Promise<void>;
  getConfigVersion(tenantId: string): Promise<number>;
  rollbackConfig(tenantId: string, version: number): Promise<void>;
}

// Factory that selects filesystem or DB based on feature flags
function createConfigStore(flags: SaasFeatureFlags): ConfigStore {
  if (flags.configStoreDb) {
    return new DbConfigStore(); // reads from DB
  }
  if (flags.configStoreDual) {
    return new DualWriteConfigStore(); // writes to both, reads from filesystem
  }
  return new FilesystemConfigStore(); // current behavior
}
```

#### 4.2.2 — Dual-Write Strategy

```
Phase 1a — Dual Write (2 weeks):
  • Every config write goes to BOTH filesystem AND database
  • Reads still come from filesystem (source of truth)
  • Background reconciliation job compares DB vs filesystem every 5 minutes
  • Discrepancies logged as warnings; auto-heal by re-syncing from filesystem

Phase 1b — DB Primary (1 week):
  • Flip: reads come from DB; filesystem writes continue as backup
  • Monitor: latency, error rate, config hash match
  • If anomaly detected: auto-fallback to filesystem within 30 seconds

Phase 1c — Filesystem Removal (1 week):
  • Stop filesystem writes
  • Filesystem config retained as cold backup for 30 days
  • Config versioning fully in DB (tenant_configs.version)
```

#### 4.2.3 — Config Migration Script

```typescript
// scripts/migrate-config-to-db.ts
// Run once per existing instance to import filesystem config into DB

async function migrateConfigToDb(options: {
  configPath: string;
  tenantId: string;
  db: DrizzleClient;
}): Promise<void> {
  // 1. Read existing config from filesystem
  const raw = fs.readFileSync(options.configPath, "utf-8");
  const parsed = json5.parse(raw);

  // 2. Validate
  const validated = validateConfigObjectWithPlugins(parsed, { env: process.env });
  if (!validated.ok) {
    throw new Error(
      `Config validation failed: ${validated.issues.map((i) => i.message).join(", ")}`,
    );
  }

  // 3. Extract secrets from config → encrypt → store in tenant_secrets
  const secretPaths = extractSecretPaths(parsed);
  for (const { path, value } of secretPaths) {
    await encryptAndStoreSecret(options.db, options.tenantId, path, value);
  }

  // 4. Replace secret values in config with references
  const sanitizedConfig = replaceSecretsWithRefs(parsed, secretPaths);

  // 5. Store config in DB
  await withTenantContext(options.db, options.tenantId, async (tx) => {
    await tx.insert(tenantConfigs).values({
      tenantId: options.tenantId,
      configData: sanitizedConfig,
      configHash: hashConfig(JSON.stringify(sanitizedConfig)),
      version: 1,
      isActive: true,
    });
  });

  // 6. Verify roundtrip
  const loaded = await loadConfigFromDb(options.db, options.tenantId);
  const originalHash = hashConfig(JSON.stringify(sanitizedConfig));
  const loadedHash = hashConfig(JSON.stringify(loaded));
  if (originalHash !== loadedHash) {
    throw new Error("Config roundtrip verification failed");
  }
}
```

### 4.3 Session Store Migration

#### 4.3.1 — Database Session Adapter

```typescript
// New: src/config/sessions/store-db.ts

interface SessionStore {
  load(tenantId: string, sessionKey: string): Promise<SessionEntry | null>;
  save(tenantId: string, sessionKey: string, entry: SessionEntry): Promise<void>;
  delete(tenantId: string, sessionKey: string): Promise<void>;
  list(tenantId: string, options: SessionListOptions): Promise<SessionEntry[]>;
  prune(tenantId: string, maxAge: number): Promise<number>;
}

// Dual-write store: writes to both filesystem and DB
class DualWriteSessionStore implements SessionStore {
  constructor(
    private readonly fs: FilesystemSessionStore,
    private readonly db: DbSessionStore,
  ) {}

  async save(tenantId: string, sessionKey: string, entry: SessionEntry): Promise<void> {
    // Write to both; filesystem is source of truth during dual-write
    await Promise.all([
      this.fs.save(tenantId, sessionKey, entry),
      this.db.save(tenantId, sessionKey, entry).catch((err) => {
        // Log but don't fail — DB is secondary during dual-write
        logger.warn("Session dual-write to DB failed", { sessionKey, error: err.message });
      }),
    ]);
  }

  async load(tenantId: string, sessionKey: string): Promise<SessionEntry | null> {
    // Read from filesystem during dual-write phase
    return this.fs.load(tenantId, sessionKey);
  }
}
```

#### 4.3.2 — Session Migration Script

```typescript
// scripts/migrate-sessions-to-db.ts
// Batch import existing JSON session store into PostgreSQL

async function migrateSessionsToDb(options: {
  storePath: string;
  tenantId: string;
  db: DrizzleClient;
  batchSize: number; // default: 500
}): Promise<{ migrated: number; skipped: number; errors: number }> {
  const store = loadSessionStore(options.storePath, { skipCache: true });
  const entries = Object.entries(store);
  let migrated = 0,
    skipped = 0,
    errors = 0;

  for (let i = 0; i < entries.length; i += options.batchSize) {
    const batch = entries.slice(i, i + options.batchSize);

    await withTenantContext(options.db, options.tenantId, async (tx) => {
      for (const [sessionKey, entry] of batch) {
        try {
          const parsed = parseAgentSessionKey(sessionKey);
          await tx
            .insert(sessions)
            .values({
              tenantId: options.tenantId,
              sessionKey,
              agentId: parsed?.agentId ?? "main",
              messages: entry.messages ?? [],
              deliveryContext: entry.deliveryContext ?? null,
              metadata: entry.metadata ?? {},
              status: "active",
              messageCount: (entry.messages ?? []).length,
              lastActivityAt: entry.lastActivityAt ? new Date(entry.lastActivityAt) : new Date(),
              createdAt: entry.createdAt ? new Date(entry.createdAt) : new Date(),
            })
            .onConflictDoNothing(); // skip duplicates
          migrated++;
        } catch (err) {
          logger.error("Session migration error", { sessionKey, error: err });
          errors++;
        }
      }
    });

    // Progress logging
    logger.info(`Session migration progress: ${migrated + skipped + errors}/${entries.length}`);
  }

  return { migrated, skipped, errors };
}
```

#### 4.3.3 — Session Reconciliation

```typescript
// Run during dual-write phase to detect drift
async function reconcileSessions(options: {
  storePath: string;
  tenantId: string;
  db: DrizzleClient;
}): Promise<{ matched: number; driftCount: number; dbOnly: number; fsOnly: number }> {
  const fsStore = loadSessionStore(options.storePath, { skipCache: true });
  const dbSessions = await listAllDbSessions(options.db, options.tenantId);

  const fsKeys = new Set(Object.keys(fsStore));
  const dbKeys = new Set(dbSessions.map((s) => s.sessionKey));

  let matched = 0,
    driftCount = 0;
  const fsOnly = [...fsKeys].filter((k) => !dbKeys.has(k)).length;
  const dbOnly = [...dbKeys].filter((k) => !fsKeys.has(k)).length;

  for (const key of fsKeys) {
    if (dbKeys.has(key)) {
      const fsEntry = fsStore[key];
      const dbEntry = dbSessions.find((s) => s.sessionKey === key);
      const fsHash = hashSessionEntry(fsEntry);
      const dbHash = hashSessionEntry(dbEntry);
      if (fsHash === dbHash) {
        matched++;
      } else {
        driftCount++;
        // Auto-heal: filesystem is source of truth during dual-write
        await syncSessionToDb(options.db, options.tenantId, key, fsEntry);
      }
    }
  }

  return { matched, driftCount, dbOnly, fsOnly };
}
```

### 4.4 Secrets Migration

```
Secrets Migration Procedure:
────────────────────────────
Executed per tenant during Phase 1 activation.

Step 1 — Inventory existing secrets:
  • Scan env vars for known API key patterns (OPENAI_API_KEY, etc.)
  • Scan config for secret-input references
  • Scan auth-profiles.json for provider credentials
  • Scan channel configs for bot tokens

Step 2 — Create tenant DEK:
  • Generate 256-bit random key
  • Encrypt DEK with master KEK via KMS
  • Store in tenant_deks table

Step 3 — Encrypt and store each secret:
  • For each discovered secret:
    a. Encrypt plaintext with tenant DEK (AES-256-GCM)
    b. INSERT into tenant_secrets (encrypted_value, iv, dek_version)
    c. Verify: decrypt from DB → compare with original plaintext
    d. Audit log: action = 'secret.migrated'

Step 4 — Update config references:
  • Replace inline secret values in tenant_configs with $ref pointers
  • Example: "OPENAI_API_KEY": "sk-..." → "OPENAI_API_KEY": {"$ref": "vault:openai_api_key"}

Step 5 — Verification:
  • For each migrated secret: decrypt from DB → verify against original source
  • Run gateway health check with DB-sourced secrets

Step 6 — Cleanup (after 30-day observation):
  • Remove plaintext from env files (manual, guided)
  • Archive old auth-profiles.json
  • Audit log: action = 'secret.migration_complete'
```

### 4.5 Pairing / Allowlist Migration

```typescript
// scripts/migrate-allowlists-to-db.ts
async function migrateAllowlistsToDb(options: {
  credentialsDir: string;
  tenantId: string;
  db: DrizzleClient;
}): Promise<void> {
  const files = fs.readdirSync(options.credentialsDir).filter((f) => f.endsWith("-allowFrom.json"));

  for (const file of files) {
    const channelType = file.replace("-allowFrom.json", "").split("-")[0];
    const raw = fs.readFileSync(path.join(options.credentialsDir, file), "utf-8");
    const entries: AllowFromEntry[] = JSON.parse(raw);

    // Find or create channel_account
    const channelAccount = await findOrCreateChannelAccount(
      options.db,
      options.tenantId,
      channelType,
    );

    // Import allowlist entries
    for (const entry of entries) {
      await withTenantContext(options.db, options.tenantId, async (tx) => {
        await tx
          .insert(channelAllowlists)
          .values({
            tenantId: options.tenantId,
            channelAccountId: channelAccount.id,
            senderId: entry.id ?? entry.sender,
            source: "import",
          })
          .onConflictDoNothing();
      });
    }
  }
}
```

### 4.6 Rollback Plan — Phase 1

```
Rollback Strategy (per sub-phase):

Config dual-write (1a):
  • Disable OPENCLAW_CONFIG_STORE_DUAL
  • Gateway reverts to filesystem-only reads and writes
  • DB config data retained but unused
  • Risk: Zero — filesystem was never modified

Config DB primary (1b):
  • Disable OPENCLAW_CONFIG_STORE_DB
  • Re-enable filesystem reads
  • Run reconciliation to sync any DB-only changes back to filesystem
  • Risk: Low — config changes during DB-primary window need manual sync

Session dual-write:
  • Disable OPENCLAW_SESSION_STORE_DUAL
  • Gateway reverts to filesystem-only
  • DB session data retained but stale
  • Risk: Zero — filesystem always had authoritative data during dual-write

Session DB primary:
  • Disable OPENCLAW_SESSION_STORE_DB
  • Run reconciliation to sync DB changes back to filesystem
  • Risk: Medium — active sessions during DB-primary window may have
    DB-only state that needs manual export

Secrets vault:
  • Disable OPENCLAW_SECRETS_VAULT
  • Gateway reverts to env vars / filesystem secrets
  • Encrypted secrets remain in DB for re-activation
  • Risk: Low — original env vars must still be available
```

### 4.7 Validation Criteria — Phase 1

- [ ] Config read/write works via DB with correct tenant isolation
- [ ] Session CRUD works via DB; latency < 50ms p99
- [ ] All secrets encrypted; zero plaintext in DB (`SELECT * FROM tenant_secrets WHERE encrypted_value IS NULL` returns 0)
- [ ] Dual-write reconciliation shows 0 drift after 24 hours
- [ ] Allowlists imported with 100% entry coverage
- [ ] Audit logs capturing all sensitive operations
- [ ] Existing tests pass with SaaS flags both on and off
- [ ] Self-hosted mode (flags off) unchanged

---

## 5. Phase 2 — Channel Isolation (Weeks 11–14)

### 5.1 Objectives

- Per-tenant webhook routing (each tenant's channels have unique webhook endpoints)
- Per-tenant channel credentials (each tenant manages their own bot tokens)
- Media storage isolated per tenant
- Memory/RAG isolated per tenant (pgvector)

### 5.2 Webhook Routing Architecture

```
Current:  POST /webhook/telegram      → single bot
Target:   POST /webhooks/telegram/{random_path}  → tenant-specific bot

Flow:
1. Inbound webhook hits /webhooks/{channel_type}/{webhook_path}
2. Lookup channel_accounts by webhook_path (globally unique)
3. Resolve tenant_id from channel_account
4. SET LOCAL app.current_tenant_id = tenant_id
5. Decrypt channel credentials from tenant_secrets
6. Process message in tenant context
7. Route response through tenant's channel account
```

```typescript
// src/gateway/webhook-router.ts
async function routeWebhook(
  channelType: string,
  webhookPath: string,
  payload: unknown,
): Promise<void> {
  // Step 1: Resolve channel account (no RLS needed — webhook_path is globally unique)
  const channelAccount = await db
    .select()
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.webhookPath, webhookPath),
        eq(channelAccounts.channelType, channelType),
        isNull(channelAccounts.deletedAt),
      ),
    )
    .limit(1);

  if (!channelAccount.length) {
    throw new WebhookNotFoundError(channelType, webhookPath);
  }

  const account = channelAccount[0];

  // Step 2: Process within tenant context
  await withTenantContext(db, account.tenantId, async (tx) => {
    // Decrypt channel credentials
    const credentials = await decryptChannelCredentials(tx, account);

    // Verify webhook signature (platform-specific)
    await verifyWebhookSignature(channelType, payload, credentials);

    // Route to channel handler
    await processInboundMessage(tx, account, payload, credentials);
  });
}
```

### 5.3 Media Storage Isolation

```
Current:  ~/.openclaw/media/*          (flat directory)
Target:   Object storage with tenant-prefixed paths

Storage structure:
  s3://openclaw-media/{tenant_id}/{channel_type}/{date}/{filename}

For self-hosted / local:
  ~/.openclaw/media/{tenant_id}/{channel_type}/{date}/{filename}

Access control:
  • Pre-signed URLs for client access (expire in 1 hour)
  • Tenant ID in path prefix prevents cross-tenant access
  • Bucket policy: deny access without tenant prefix
```

```typescript
// src/media/tenant-media-store.ts
interface TenantMediaStore {
  store(tenantId: string, file: MediaFile): Promise<MediaRef>;
  retrieve(tenantId: string, ref: MediaRef): Promise<Buffer>;
  delete(tenantId: string, ref: MediaRef): Promise<void>;
  getSignedUrl(tenantId: string, ref: MediaRef, ttl: number): Promise<string>;
  getUsage(tenantId: string): Promise<{ bytes: number; count: number }>;
}

// S3 implementation enforces tenant prefix
class S3TenantMediaStore implements TenantMediaStore {
  async store(tenantId: string, file: MediaFile): Promise<MediaRef> {
    const key = `${tenantId}/${file.channelType}/${formatDate(new Date())}/${file.filename}`;
    await this.s3.putObject({
      Bucket: this.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimeType,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: this.kmsKeyId,
    });
    return { bucket: this.bucket, key, size: file.buffer.length };
  }
}
```

### 5.4 Memory/RAG Isolation (pgvector)

```
Current:  LanceDB / QMD with single namespace
Target:   pgvector with tenant-scoped RLS

Migration:
1. Export existing embeddings from LanceDB (if any)
2. Re-embed documents using tenant's configured model
3. Store in memory_embeddings table with tenant_id + agent_id
4. RLS ensures tenant isolation automatically

Search query (tenant-isolated):
  SET LOCAL app.current_tenant_id = '{tenant_id}';
  SELECT content, metadata,
         1 - (embedding <=> $query_vector) AS similarity
  FROM memory_embeddings
  WHERE agent_id = $agent_id
  ORDER BY embedding <=> $query_vector
  LIMIT 10;
  -- RLS automatically filters to current tenant
```

### 5.5 Validation Criteria — Phase 2

- [ ] Each tenant's webhooks route to correct channel accounts
- [ ] Webhook signature verification works per-tenant
- [ ] Media files stored with tenant prefix; cross-tenant access returns 403
- [ ] RAG search returns only current tenant's embeddings
- [ ] Channel credential decryption works per-tenant
- [ ] Load test: 100 concurrent tenants processing messages simultaneously

---

## 6. Phase 3 — Platform Layer (Weeks 15–18)

### 6.1 Objectives

- Billing/subscription management
- Usage metering (messages, tokens, storage)
- Admin dashboard for tenant management
- Self-service tenant onboarding flow

### 6.2 Billing Tables

```sql
-- ════════════════════════════════════
-- TABLE: subscriptions
-- Role: Tenant subscription state (one active per tenant).
-- Scale class: BOUNDED
-- ════════════════════════════════════
CREATE TABLE subscriptions (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  plan            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  billing_cycle   TEXT NOT NULL DEFAULT 'monthly',
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end   TIMESTAMPTZ NOT NULL,
  stripe_subscription_id TEXT,
  stripe_customer_id     TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at    TIMESTAMPTZ,

  CONSTRAINT pk_subscriptions PRIMARY KEY (id),
  CONSTRAINT fk_subscriptions_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT chk_subscriptions_plan CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
  CONSTRAINT chk_subscriptions_status CHECK (status IN ('active', 'past_due', 'cancelled', 'trialing')),
  CONSTRAINT chk_subscriptions_cycle CHECK (billing_cycle IN ('monthly', 'yearly'))
);

-- One active subscription per tenant
CREATE UNIQUE INDEX idx_subscriptions_tenant_active
  ON subscriptions(tenant_id)
  WHERE status IN ('active', 'trialing') AND cancelled_at IS NULL;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON subscriptions
  USING (current_setting('app.bypass_rls', true) = 'on');
```

```sql
-- ════════════════════════════════════
-- TABLE: usage_records
-- Role: Aggregated daily usage per tenant for billing.
-- Scale class: FAST_GROWTH
-- Write pattern: INSERT_HEAVY (daily aggregation from message_events)
-- ════════════════════════════════════
CREATE TABLE usage_records (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  period_date     DATE NOT NULL,
  messages_in     INTEGER NOT NULL DEFAULT 0,
  messages_out    INTEGER NOT NULL DEFAULT 0,
  tokens_used     BIGINT NOT NULL DEFAULT 0,
  media_bytes     BIGINT NOT NULL DEFAULT 0,
  api_calls       INTEGER NOT NULL DEFAULT 0,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_usage_records PRIMARY KEY (id),
  CONSTRAINT fk_usage_records_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_usage_records_tenant_date
  ON usage_records(tenant_id, period_date);

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON usage_records
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON usage_records
  USING (current_setting('app.bypass_rls', true) = 'on');
```

### 6.3 Tenant Onboarding Flow

```
New Tenant Registration:
  1. User signs up (email/password or OIDC)
  2. User creates tenant (slug, display_name, plan)
  3. System:
     a. INSERT into tenants
     b. INSERT into tenant_members (user, tenant, role='owner')
     c. Generate tenant DEK → encrypt with master KEK → INSERT into tenant_deks
     d. INSERT default tenant_configs (empty config with sensible defaults)
     e. INSERT default agent (agent_id='main')
     f. INSERT into subscriptions (plan=free, status=active)
     g. INSERT audit_log: action='tenant.create'
  4. User redirected to onboarding wizard:
     a. Choose model provider (→ store API key as encrypted secret)
     b. Connect first channel (→ create channel_account + store credentials)
     c. Test message roundtrip
  5. Tenant operational
```

### 6.4 Validation Criteria — Phase 3

- [ ] Subscription lifecycle: create → activate → upgrade → cancel
- [ ] Usage metering: daily aggregation matches message_events
- [ ] Stripe webhook integration functional
- [ ] Onboarding flow: 0 → operational in < 5 minutes
- [ ] Admin dashboard: list tenants, view usage, manage subscriptions

---

## 7. Phase 4 — Hardening (Weeks 19–22)

### 7.1 Objectives

- Penetration testing (focus: cross-tenant data access)
- Performance benchmarks (DB vs. filesystem comparison)
- Self-hosted compatibility verification
- GA release preparation

### 7.2 Penetration Testing Scope

| Test Case                        | Method                                                        | Pass Criteria                            |
| -------------------------------- | ------------------------------------------------------------- | ---------------------------------------- |
| **Cross-tenant session read**    | Authenticated as tenant A, request tenant B's sessions        | HTTP 403 or empty result                 |
| **Cross-tenant secret read**     | Authenticated as tenant A, attempt to read tenant B's secrets | HTTP 403 or empty result                 |
| **RLS bypass via SQL injection** | Craft inputs that attempt `SET LOCAL` manipulation            | All inputs sanitized; no bypass          |
| **Webhook path enumeration**     | Brute-force webhook paths                                     | Rate limited; no information leakage     |
| **JWT manipulation**             | Modify tenant claim in JWT                                    | Signature verification fails             |
| **Privilege escalation**         | Member attempts admin operations                              | HTTP 403                                 |
| **DEK extraction**               | Attempt to read encrypted DEK without KMS access              | KMS call required; no plaintext exposure |
| **Audit log tampering**          | Attempt UPDATE/DELETE on audit_logs                           | Permission denied                        |

### 7.3 Performance Benchmarks

| Operation                | Filesystem Baseline   | DB Target                     | Acceptable Threshold |
| ------------------------ | --------------------- | ----------------------------- | -------------------- |
| Config read              | ~1ms (cached)         | < 5ms (cached), < 20ms (cold) | < 50ms p99           |
| Session read             | ~5ms                  | < 10ms                        | < 50ms p99           |
| Session write            | ~10ms (atomic rename) | < 15ms                        | < 50ms p99           |
| Secret decrypt           | N/A (plaintext)       | < 5ms                         | < 10ms p99           |
| Allowlist check          | ~2ms (JSON parse)     | < 5ms                         | < 10ms p99           |
| Message event insert     | N/A                   | < 5ms                         | < 10ms p99           |
| Memory search (pgvector) | ~50ms (LanceDB)       | < 100ms                       | < 200ms p99          |

### 7.4 Self-Hosted Compatibility Matrix

| Feature         | Self-Hosted (flags off)    | SaaS (flags on)                  |
| --------------- | -------------------------- | -------------------------------- |
| Config storage  | Filesystem (openclaw.json) | PostgreSQL (tenant_configs)      |
| Session storage | Filesystem (JSON)          | PostgreSQL (sessions)            |
| Secrets         | Env vars / file providers  | Encrypted vault (tenant_secrets) |
| Auth            | Token/password             | JWT + OIDC                       |
| Channels        | Single set, global         | Per-tenant, isolated             |
| Media           | Local filesystem           | Tenant-prefixed (S3 or local)    |
| Memory          | LanceDB / QMD              | pgvector                         |
| Gateway         | Single instance            | Horizontally scalable            |
| User accounts   | None (gateway-level auth)  | Full user/tenant model           |

### 7.5 GA Release Checklist

- [ ] All Phase 0–3 validation criteria passed
- [ ] Penetration test report: zero critical/high findings
- [ ] Performance benchmarks: all within acceptable thresholds
- [ ] Self-hosted mode: full regression suite passes
- [ ] Documentation: SaaS setup guide, admin guide, migration guide
- [ ] Monitoring: dashboards for tenant health, query performance, error rates
- [ ] Runbook: incident response for data isolation breach, key compromise, DB failover
- [ ] Legal: privacy policy updated, DPA template available for enterprise
- [ ] Backup/restore: tested end-to-end with encrypted data
