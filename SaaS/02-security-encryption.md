# OpenClaw SaaS — Security, Encryption, and Secrets Management

> **Document:** 02-security-encryption.md
> **Prerequisite:** 00-overview.md, 01-data-isolation.md
> **Scope:** Authentication, authorization, encryption-at-rest, key management, secrets lifecycle, and compliance

---

## 1. Authentication Architecture

### 1.1 Current State

| Surface           | Current Auth                                        | SaaS Gap                                     |
| ----------------- | --------------------------------------------------- | -------------------------------------------- |
| **Gateway HTTP**  | Bearer token or password (`OPENCLAW_GATEWAY_TOKEN`) | No user identity; shared token for all users |
| **Gateway WS**    | Same token + device identity (Control UI)           | No tenant scoping; device auth is optional   |
| **Tailscale**     | Tailnet identity (login+profile)                    | Single tailnet; no multi-tenant mapping      |
| **Trusted proxy** | IP-based trust                                      | Not applicable to SaaS                       |

### 1.2 Target Authentication Stack

```
┌─────────────────────────────────────────────────────────┐
│                     Client (Browser / CLI / Bot)         │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTPS + JWT Bearer
                           ▼
┌─────────────────────────────────────────────────────────┐
│                     API Gateway / LB                     │
│              (TLS termination, rate limiting)             │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                  Auth Middleware                          │
│  ┌───────────────┐  ┌────────────────┐  ┌────────────┐ │
│  │  JWT Verify    │  │  Tenant Resolve │  │  RBAC      │ │
│  │  (RS256/ES256) │  │  (from claims)  │  │  Check     │ │
│  └───────────────┘  └────────────────┘  └────────────┘ │
│                           │                              │
│              SET LOCAL app.current_tenant_id              │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              PostgreSQL (RLS enforced)                    │
└─────────────────────────────────────────────────────────┘
```

### 1.3 JWT Token Structure

```jsonc
{
  // Header
  "alg": "ES256",
  "typ": "JWT",
  "kid": "key-2026-04"          // key rotation support

  // Payload
  "sub": "user-uuid",           // user.id
  "tid": "tenant-uuid",         // tenant.id (primary tenant context)
  "email": "user@example.com",
  "role": "admin",              // role within this tenant
  "tslug": "acme-corp",        // tenant slug (for display; never used for authz)
  "iat": 1719000000,
  "exp": 1719003600,           // 1 hour
  "iss": "https://auth.openclaw.ai",
  "aud": "https://api.openclaw.ai"
}
```

### 1.4 Auth Endpoints

| Endpoint                       | Method        | Purpose                                                   |
| ------------------------------ | ------------- | --------------------------------------------------------- |
| `POST /auth/register`          | Public        | Create user + tenant (or join existing tenant via invite) |
| `POST /auth/login`             | Public        | Email/password login → JWT                                |
| `POST /auth/login/oidc`        | Public        | OIDC/OAuth redirect initiation (Google, GitHub, Okta)     |
| `GET /auth/callback/:provider` | Public        | OIDC callback → JWT                                       |
| `POST /auth/refresh`           | Authenticated | Refresh token → new JWT                                   |
| `POST /auth/logout`            | Authenticated | Revoke refresh token                                      |
| `POST /auth/switch-tenant`     | Authenticated | Issue new JWT for a different tenant the user belongs to  |
| `POST /auth/invite`            | Admin         | Generate tenant invitation link                           |

### 1.5 OIDC / SSO Integration

```typescript
// Supported OIDC providers (extensible via config)
const OIDC_PROVIDERS = {
  google: {
    discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
    scopes: ["openid", "email", "profile"],
  },
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["read:user", "user:email"],
  },
  // Enterprise SSO: tenant-specific OIDC provider configured in tenant_configs
  custom: {
    // discoveryUrl loaded from tenant_configs.config_data.auth.oidc.discoveryUrl
  },
};
```

### 1.6 Self-Hosted Mode Compatibility

For self-hosted single-tenant deployments, auth falls back to current behavior:

```typescript
// Resolved at startup based on OPENCLAW_SAAS_MODE env var or config
type AuthMode = "saas" | "self-hosted";

function resolveAuthMode(env: NodeJS.ProcessEnv): AuthMode {
  if (env.OPENCLAW_SAAS_MODE === "1") return "saas";
  // Legacy: token/password auth → single implicit tenant
  return "self-hosted";
}

// Self-hosted: auto-create a default tenant + admin user on first boot
// JWT is issued internally; gateway token remains as alternative
```

---

## 2. Authorization (RBAC)

### 2.1 Role Hierarchy

| Role       | Permissions                                                                 | Typical Use         |
| ---------- | --------------------------------------------------------------------------- | ------------------- |
| **owner**  | Full tenant control; billing; delete tenant; transfer ownership             | Tenant creator      |
| **admin**  | Manage channels, agents, config, secrets, members; cannot delete tenant     | Team leads          |
| **member** | Use agents, view sessions, manage own pairing; cannot modify config/secrets | Regular users       |
| **viewer** | Read-only access to sessions and analytics; cannot interact with agents     | Auditors, observers |

### 2.2 Permission Matrix

| Resource                 | owner | admin | member   | viewer |
| ------------------------ | ----- | ----- | -------- | ------ |
| Tenant settings          | RW    | RW    | R        | R      |
| Config (tenant_configs)  | RW    | RW    | —        | —      |
| Secrets (tenant_secrets) | RW    | RW    | —        | —      |
| Agents                   | RW    | RW    | R        | R      |
| Channel accounts         | RW    | RW    | R        | R      |
| Channel allowlists       | RW    | RW    | RW (own) | —      |
| Sessions                 | RW    | RW    | RW (own) | R      |
| Audit logs               | R     | R     | —        | R      |
| Members                  | RW    | RW    | R        | R      |
| Billing                  | RW    | R     | —        | —      |

### 2.3 Authorization Middleware

```typescript
type Permission =
  | "tenant:read"
  | "tenant:write"
  | "config:read"
  | "config:write"
  | "secrets:read"
  | "secrets:write"
  | "agents:read"
  | "agents:write"
  | "channels:read"
  | "channels:write"
  | "sessions:read"
  | "sessions:write"
  | "audit:read"
  | "members:read"
  | "members:write"
  | "billing:read"
  | "billing:write";

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: [
    "tenant:read",
    "tenant:write",
    "config:read",
    "config:write",
    "secrets:read",
    "secrets:write",
    "agents:read",
    "agents:write",
    "channels:read",
    "channels:write",
    "sessions:read",
    "sessions:write",
    "audit:read",
    "members:read",
    "members:write",
    "billing:read",
    "billing:write",
  ],
  admin: [
    "tenant:read",
    "tenant:write",
    "config:read",
    "config:write",
    "secrets:read",
    "secrets:write",
    "agents:read",
    "agents:write",
    "channels:read",
    "channels:write",
    "sessions:read",
    "sessions:write",
    "audit:read",
    "members:read",
    "members:write",
    "billing:read",
  ],
  member: [
    "tenant:read",
    "agents:read",
    "channels:read",
    "sessions:read",
    "sessions:write",
    "members:read",
  ],
  viewer: [
    "tenant:read",
    "agents:read",
    "channels:read",
    "sessions:read",
    "audit:read",
    "members:read",
  ],
};

function requirePermission(...required: Permission[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const userPerms = ROLE_PERMISSIONS[req.auth.role] ?? [];
    const missing = required.filter((p) => !userPerms.includes(p));
    if (missing.length > 0) {
      return res.status(403).json({
        error: "forbidden",
        missing_permissions: missing,
      });
    }
    next();
  };
}
```

---

## 3. Encryption Architecture

### 3.1 Threat Model

| Threat                                          | Mitigation                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Database compromise** (attacker gets DB dump) | All secrets encrypted at rest with per-tenant DEKs; DEKs encrypted with master KEK in KMS                  |
| **Application server compromise**               | KEK never leaves KMS; DEKs cached in memory only, short TTL; audit logs detect anomalous access            |
| **Insider threat (rogue operator)**             | RLS prevents cross-tenant queries even for DB superuser (with FORCE RLS); audit trail on all secret access |
| **Network interception**                        | TLS everywhere; no plaintext secrets in transit                                                            |
| **Key compromise**                              | Per-tenant key rotation; re-encrypt affected secrets without downtime                                      |
| **Backup exposure**                             | Backups contain encrypted data; useless without KEK                                                        |

### 3.2 Envelope Encryption Design

```
┌─────────────────────────────────────────────────────────────┐
│                    Key Hierarchy                             │
│                                                             │
│  ┌─────────────────────────────────────┐                    │
│  │  Master KEK (Key Encryption Key)    │  ← Lives in KMS   │
│  │  AWS KMS / GCP KMS / HashiCorp Vault│    (never leaves)  │
│  └──────────────────┬──────────────────┘                    │
│                     │ encrypts/decrypts                     │
│                     ▼                                       │
│  ┌─────────────────────────────────────┐                    │
│  │  Tenant DEK (Data Encryption Key)   │  ← One per tenant │
│  │  Stored encrypted in tenant_deks    │    Cached in RAM   │
│  │  Rotated independently per tenant   │    TTL: 5 minutes  │
│  └──────────────────┬──────────────────┘                    │
│                     │ encrypts/decrypts                     │
│                     ▼                                       │
│  ┌─────────────────────────────────────┐                    │
│  │  Tenant Data                        │                    │
│  │  - API keys (tenant_secrets)        │                    │
│  │  - OAuth tokens                     │                    │
│  │  - Channel credentials              │                    │
│  │  - Webhook signing secrets          │                    │
│  └─────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 Tenant DEK Table

```sql
-- ════════════════════════════════════
-- TABLE: tenant_deks
-- Role: Stores encrypted DEKs per tenant. Each tenant can have multiple
--       DEK versions for key rotation (only latest is active for new encryptions).
-- Scale class: BOUNDED (1-3 active versions per tenant)
-- Write pattern: READ_HEAVY
-- ════════════════════════════════════
CREATE TABLE tenant_deks (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  version         INTEGER NOT NULL,
  encrypted_dek   BYTEA NOT NULL,                 -- DEK encrypted with master KEK
  kek_id          TEXT NOT NULL,                   -- which KMS key encrypted this DEK
  algorithm       TEXT NOT NULL DEFAULT 'aes-256-gcm',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,   -- active for new encryptions
  rotated_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_tenant_deks PRIMARY KEY (id),
  CONSTRAINT fk_tenant_deks_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT chk_tenant_deks_algorithm CHECK (algorithm IN ('aes-256-gcm', 'aes-256-cbc'))
);

-- Only one active DEK per tenant
CREATE UNIQUE INDEX idx_tenant_deks_active
  ON tenant_deks(tenant_id)
  WHERE is_active = TRUE;

CREATE INDEX CONCURRENTLY idx_tenant_deks_tenant_version
  ON tenant_deks(tenant_id, version DESC);

ALTER TABLE tenant_deks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_deks
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON tenant_deks
  USING (current_setting('app.bypass_rls', true) = 'on');
```

### 3.4 Encryption / Decryption Implementation

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  dekVersion: number;
}

/**
 * Encrypt a secret value using the tenant's active DEK.
 * DEK is decrypted in-memory via KMS call (cached with short TTL).
 */
function encryptSecret(plaintext: string, dek: Buffer, dekVersion: number): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return { ciphertext, iv, authTag, dekVersion };
}

/**
 * Decrypt a secret value. Resolves the correct DEK version from tenant_deks.
 */
function decryptSecret(payload: EncryptedPayload, dek: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, dek, payload.iv);
  decipher.setAuthTag(payload.authTag);
  const plaintext = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  return plaintext.toString("utf-8");
}

/**
 * Store format in tenant_secrets table:
 *   encrypted_value = iv (12 bytes) + authTag (16 bytes) + ciphertext (variable)
 *   dek_version = which DEK version was used
 */
function packEncryptedValue(payload: EncryptedPayload): Buffer {
  return Buffer.concat([payload.iv, payload.authTag, payload.ciphertext]);
}

function unpackEncryptedValue(packed: Buffer): { iv: Buffer; authTag: Buffer; ciphertext: Buffer } {
  return {
    iv: packed.subarray(0, IV_LENGTH),
    authTag: packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH),
    ciphertext: packed.subarray(IV_LENGTH + TAG_LENGTH),
  };
}
```

### 3.5 DEK Cache (In-Memory)

```typescript
/**
 * In-memory DEK cache with short TTL to minimize KMS calls.
 * Cache is per-process; does not share across gateway instances.
 */
class DekCache {
  private cache = new Map<string, { dek: Buffer; expiresAt: number }>();
  private readonly ttlMs = 5 * 60 * 1000; // 5 minutes

  get(tenantId: string, version: number): Buffer | null {
    const key = `${tenantId}:${version}`;
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.dek;
  }

  set(tenantId: string, version: number, dek: Buffer): void {
    const key = `${tenantId}:${version}`;
    this.cache.set(key, { dek, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(tenantId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  // Periodic cleanup of expired entries
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}
```

### 3.6 Key Rotation Procedure

```
KEY ROTATION — Per-Tenant DEK Rotation
──────────────────────────────────────
Trigger: Scheduled (every 90 days), manual, or on suspected compromise.

Step 1 — Generate new DEK
  • Generate 256-bit random key
  • Encrypt new DEK with master KEK via KMS
  • INSERT into tenant_deks with version = current_max + 1, is_active = TRUE
  • SET is_active = FALSE on previous version

Step 2 — Re-encrypt active secrets (background job)
  • SELECT all tenant_secrets WHERE dek_version < new_version
  • For each: decrypt with old DEK → encrypt with new DEK → UPDATE
  • Batch: 100 secrets per transaction to limit lock duration

Step 3 — Verify and cleanup
  • Confirm zero secrets remain on old dek_version
  • Mark old DEK as expired (but retain for audit; do NOT delete)
  • Invalidate DEK cache for this tenant

Step 4 — Audit
  • INSERT audit_log: action = 'dek.rotated', resource_type = 'tenant_dek'

Rollback: If step 2 fails midway, secrets on old version are still readable
(old DEK retained). Retry re-encryption. No data loss possible.

Estimated time: < 1 second for typical tenant (50 secrets).
```

### 3.7 Master KEK Management

| KMS Provider            | Configuration                                                       | Self-Hosted Fallback                                                                      |
| ----------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **AWS KMS**             | `OPENCLAW_KMS_PROVIDER=aws`, `OPENCLAW_KMS_KEY_ARN=arn:aws:kms:...` | —                                                                                         |
| **GCP KMS**             | `OPENCLAW_KMS_PROVIDER=gcp`, `OPENCLAW_KMS_KEY_NAME=projects/...`   | —                                                                                         |
| **HashiCorp Vault**     | `OPENCLAW_KMS_PROVIDER=vault`, `OPENCLAW_VAULT_ADDR=...`            | —                                                                                         |
| **Local (self-hosted)** | `OPENCLAW_KMS_PROVIDER=local`                                       | Master key derived from `OPENCLAW_MASTER_KEY` env var via HKDF; stored only in env/memory |

```typescript
interface KmsProvider {
  encrypt(plaintext: Buffer): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<Buffer>;
  keyId(): string;
}

// Factory resolves provider from config/env
function createKmsProvider(env: NodeJS.ProcessEnv): KmsProvider {
  const provider = env.OPENCLAW_KMS_PROVIDER ?? "local";
  switch (provider) {
    case "aws":
      return new AwsKmsProvider(env);
    case "gcp":
      return new GcpKmsProvider(env);
    case "vault":
      return new VaultKmsProvider(env);
    case "local":
      return new LocalKmsProvider(env);
    default:
      throw new Error(`Unknown KMS provider: ${provider}`);
  }
}
```

---

## 4. Secrets Lifecycle

### 4.1 Secret Write Flow

```
User writes secret via API or CLI
  │
  ├─► Validate: key format, value length
  ├─► Authorize: requirePermission('secrets:write')
  ├─► Resolve tenant DEK (cache → DB → KMS decrypt)
  ├─► Encrypt value with DEK (AES-256-GCM)
  ├─► Pack: iv + authTag + ciphertext → BYTEA
  ├─► INSERT/UPDATE tenant_secrets
  ├─► Audit log: action = 'secret.write'
  └─► Response: { id, key, metadata } (NO value returned)
```

### 4.2 Secret Read Flow

```
Gateway needs secret (e.g., OPENAI_API_KEY for tenant)
  │
  ├─► RLS context: SET LOCAL app.current_tenant_id
  ├─► SELECT encrypted_value, iv, dek_version FROM tenant_secrets
  ├─► Resolve DEK for dek_version (cache → DB → KMS decrypt)
  ├─► Decrypt value with DEK
  ├─► Audit log: action = 'secret.read' (with caller context)
  └─► Return plaintext to caller (NEVER log, NEVER cache plaintext)
```

### 4.3 Secret Deletion

```
Secrets are soft-deleted (deleted_at set, value retained encrypted).
Hard delete after retention period (90 days default):
  • Background job: DELETE FROM tenant_secrets WHERE deleted_at < NOW() - INTERVAL '90 days'
  • Audit log: action = 'secret.purge'
```

### 4.4 Mapping Current Secrets to Tenant Secrets

| Current Secret Source             | Tenant Secret Key                           | Migration Notes                       |
| --------------------------------- | ------------------------------------------- | ------------------------------------- |
| `OPENAI_API_KEY` env var          | `openai_api_key`                            | Read from env → encrypt → store       |
| `ANTHROPIC_API_KEY` env var       | `anthropic_api_key`                         | Same                                  |
| `TELEGRAM_BOT_TOKEN` env var      | `telegram_bot_token`                        | Stored in channel_accounts.secret_ids |
| `DISCORD_BOT_TOKEN` env var       | `discord_bot_token`                         | Same                                  |
| `gateway.auth.token` config       | `gateway_auth_token`                        | Per-tenant gateway credential         |
| `oauth.json` file                 | `oauth_access_token`, `oauth_refresh_token` | Split into separate secrets           |
| `auth-profiles.json` entries      | `auth_profile_{provider}_key`               | Per-profile secret                    |
| Config `secrets.providers[].exec` | Not migrated — SaaS replaces with vault     | Exec providers are self-hosted only   |

---

## 5. Transport Security

### 5.1 TLS Configuration

| Component               | TLS Requirement                           | Certificate                |
| ----------------------- | ----------------------------------------- | -------------------------- |
| **API Gateway**         | TLS 1.3 required, TLS 1.2 minimum         | Let's Encrypt / ACM        |
| **Gateway ↔ DB**        | TLS required (`sslmode=verify-full`)      | Internal CA                |
| **Gateway ↔ KMS**       | Provider-managed TLS                      | Provider-managed           |
| **Gateway ↔ PgBouncer** | TLS required                              | Internal CA                |
| **Inter-service**       | mTLS where possible                       | Internal CA                |
| **Webhook callbacks**   | TLS required; HMAC signature verification | Per-channel signing secret |

### 5.2 Webhook Security

Inbound webhooks from messaging platforms need tenant routing + verification:

```typescript
// Webhook URL structure: POST /webhooks/{channel_type}/{webhook_path}
// webhook_path is a unique, random, per-channel-account value
// Not guessable; not based on tenant slug or channel ID

// Verification flow:
// 1. Extract webhook_path from URL
// 2. Lookup channel_accounts by webhook_path (unique index, no tenant context needed)
// 3. Set tenant context from the channel_account's tenant_id
// 4. Verify platform signature (Telegram: secret_token header; Slack: signing secret; etc.)
// 5. Process message within tenant context
```

---

## 6. Rate Limiting and Abuse Prevention

### 6.1 Rate Limit Tiers

| Surface                | Rate Limit                      | Scope       |
| ---------------------- | ------------------------------- | ----------- |
| **Auth endpoints**     | 10 req/min per IP               | Global      |
| **API endpoints**      | 100 req/min per user            | Per-user    |
| **Message processing** | Based on plan tier              | Per-tenant  |
| **Secret access**      | 60 req/min per tenant           | Per-tenant  |
| **Webhook inbound**    | 500 req/min per channel_account | Per-channel |
| **Config writes**      | 10 req/min per tenant           | Per-tenant  |

### 6.2 Rate Limit Implementation

```typescript
// Redis-backed sliding window rate limiter
// Key format: ratelimit:{scope}:{identifier}:{window}
// Example: ratelimit:api:user:550e8400-e29b-41d4-a716-446655440000:1719000000

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  scope: "global" | "tenant" | "user" | "ip" | "channel";
}

const PLAN_RATE_LIMITS: Record<string, { messagesPerDay: number; agentCalls: number }> = {
  free: { messagesPerDay: 100, agentCalls: 50 },
  starter: { messagesPerDay: 5000, agentCalls: 2500 },
  pro: { messagesPerDay: 50000, agentCalls: 25000 },
  enterprise: { messagesPerDay: -1, agentCalls: -1 }, // unlimited (soft limit via config)
};
```

---

## 7. Compliance and Audit

### 7.1 Audit Events

Every sensitive operation produces an immutable audit log entry:

| Action               | Resource Type     | Trigger                                |
| -------------------- | ----------------- | -------------------------------------- |
| `secret.read`        | `tenant_secret`   | Any decryption of a secret             |
| `secret.write`       | `tenant_secret`   | Create or update a secret              |
| `secret.delete`      | `tenant_secret`   | Soft-delete a secret                   |
| `secret.purge`       | `tenant_secret`   | Hard-delete after retention            |
| `dek.rotated`        | `tenant_dek`      | DEK rotation initiated                 |
| `config.write`       | `tenant_config`   | Config updated                         |
| `config.rollback`    | `tenant_config`   | Config rolled back to previous version |
| `member.invite`      | `tenant_member`   | User invited to tenant                 |
| `member.remove`      | `tenant_member`   | User removed from tenant               |
| `member.role_change` | `tenant_member`   | Role changed                           |
| `channel.create`     | `channel_account` | New channel integration added          |
| `channel.delete`     | `channel_account` | Channel integration removed            |
| `auth.login`         | `user`            | Successful login                       |
| `auth.login_failed`  | `user`            | Failed login attempt                   |
| `auth.token_refresh` | `user`            | JWT refreshed                          |
| `tenant.create`      | `tenant`          | New tenant provisioned                 |
| `tenant.suspend`     | `tenant`          | Tenant suspended                       |
| `tenant.delete`      | `tenant`          | Tenant deletion initiated              |

### 7.2 Audit Log Integrity

```sql
-- Audit logs are INSERT-ONLY. No UPDATE or DELETE policies.
-- Application layer enforces this. DB-level protection:

REVOKE UPDATE, DELETE ON audit_logs FROM app_user;
GRANT INSERT, SELECT ON audit_logs TO app_user;

-- Admin/service role can SELECT for compliance queries
-- but cannot UPDATE or DELETE either:
REVOKE UPDATE, DELETE ON audit_logs FROM app_admin;
```

### 7.3 Data Residency

For enterprise tenants with data residency requirements:

```typescript
// tenant_configs.config_data.compliance.dataResidency
type DataResidency = {
  region: "us" | "eu" | "ap"; // determines DB routing
  encryptionRequired: boolean; // always true in SaaS mode
  retentionDays: number; // audit log retention (default: 365)
  sessionRetentionDays: number; // session data retention (default: 90)
};
```

At scale, data residency is enforced by routing tenants to region-specific DB clusters. Initially, all tenants share a single cluster with a `region` marker for future migration.

---

## 8. Security Hardening Checklist

### 8.1 Pre-Launch

- [ ] All secrets encrypted at rest (verify: `SELECT count(*) FROM tenant_secrets WHERE length(encrypted_value) = 0` must be 0)
- [ ] RLS enabled and forced on all tenant-scoped tables
- [ ] RLS cross-tenant penetration test passed (see 01-data-isolation.md §7.3)
- [ ] JWT validation: RS256/ES256 only, no HS256 (prevents secret-key-based forgery)
- [ ] Refresh tokens stored hashed (bcrypt), not plaintext
- [ ] CORS: explicit origin allowlist, no wildcard
- [ ] CSP headers on Control UI (existing implementation preserved)
- [ ] Rate limiting active on all public endpoints
- [ ] `pg_stat_statements` enabled for query monitoring
- [ ] No plaintext secrets in application logs (grep audit)
- [ ] Database connection uses `sslmode=verify-full`
- [ ] PgBouncer `auth_type = scram-sha-256`
- [ ] Webhook paths are cryptographically random (min 32 hex chars)

### 8.2 Ongoing

- [ ] DEK rotation: automated every 90 days per tenant
- [ ] Master KEK rotation: annually (KMS-managed)
- [ ] Dependency audit: `pnpm audit` in CI/CD
- [ ] Penetration test: quarterly
- [ ] Audit log review: monthly (automated alerts for anomalies)
- [ ] Dead session cleanup: daily cron
- [ ] Expired pairing cleanup: hourly cron
- [ ] Partition creation: automated monthly (pg_partman or cron)
