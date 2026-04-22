# OpenClaw SaaS — Infrastructure, Scaling, and Observability

> **Document:** 04-infrastructure.md
> **Prerequisite:** 00-overview.md, 01-data-isolation.md, 02-security-encryption.md, 03-migration-strategy.md
> **Scope:** Deployment topology, horizontal scaling, connection pooling, monitoring, alerting, SLAs, disaster recovery

---

## 1. Target Deployment Topology

```
                         ┌──────────────────────┐
                         │    CDN / WAF          │
                         │  (Cloudflare / AWS CF) │
                         └──────────┬───────────┘
                                    │ HTTPS
                                    ▼
                         ┌──────────────────────┐
                         │   Load Balancer       │
                         │   (ALB / Nginx)       │
                         │   TLS termination     │
                         └──────────┬───────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
           ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
           │  Gateway #1  │ │  Gateway #2  │ │  Gateway #N  │
           │  (stateless) │ │  (stateless) │ │  (stateless) │
           └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
                  │                │                │
                  └────────────────┼────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
           ┌──────────────┐ ┌──────────┐ ┌──────────────┐
           │  PgBouncer   │ │  Redis   │ │  Object      │
           │  (pool)      │ │  (cache/ │ │  Storage     │
           │              │ │  pubsub) │ │  (S3/MinIO)  │
           └──────┬───────┘ └──────────┘ └──────────────┘
                  │
           ┌──────┴───────┐
           │  PostgreSQL   │
           │  Primary      │──── Streaming Replication
           │  (RLS active) │
           └──────┬───────┘
                  │
           ┌──────┴───────┐
           │  PostgreSQL   │
           │  Read Replica │  ← read-heavy queries (session list, analytics)
           └──────────────┘
```

---

## 2. Component Specifications

### 2.1 Gateway Instances (Stateless)

| Parameter             | Value                              | Rationale                                           |
| --------------------- | ---------------------------------- | --------------------------------------------------- |
| **Runtime**           | Node 22+ (built output `dist/`)    | Matches current production path                     |
| **Instances**         | 2–N (auto-scaled by CPU/memory)    | Horizontal scaling                                  |
| **CPU**               | 2–4 vCPU per instance              | WebSocket + LLM proxy workload                      |
| **Memory**            | 4–8 GB per instance                | DEK cache, session cache, WS connections            |
| **State**             | None on disk                       | All persistent state in PostgreSQL + object storage |
| **Health check**      | `GET /healthz` (existing endpoint) | LB routes only to healthy instances                 |
| **Graceful shutdown** | Drain WS connections over 30s      | Zero-downtime deploys                               |

**Statelesness requirements for SaaS gateway:**

```typescript
// Current filesystem dependencies that must be eliminated or abstracted:

// BEFORE (filesystem-coupled):
const sessionStore = loadSessionStore(storePath); // reads JSON file
const config = loadConfig(); // reads openclaw.json
const allowFrom = loadAllowFrom(credentialsDir); // reads JSON file

// AFTER (database-backed, stateless):
const sessionStore = await dbSessionStore.load(tenantId, sessionKey); // PostgreSQL
const config = await dbConfigStore.load(tenantId); // PostgreSQL (cached)
const allowFrom = await dbAllowlistStore.check(tenantId, channelAccountId, senderId); // PostgreSQL
```

### 2.2 PostgreSQL Primary

| Parameter                               | Value                                         | Rationale                                    |
| --------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| **Version**                             | 16+                                           | Native RLS improvements, logical replication |
| **Instance**                            | db.r6g.xlarge (4 vCPU, 32 GB) initial         | Sufficient for 10K tenants                   |
| **Storage**                             | 500 GB gp3 (3000 IOPS baseline)               | Headroom for 12 months; auto-expand          |
| **Extensions**                          | pgcrypto, pg_stat_statements, pg_trgm, vector | Required by schema                           |
| **max_connections**                     | 200                                           | PgBouncer handles multiplexing               |
| **shared_buffers**                      | 8 GB (25% of RAM)                             | Standard tuning                              |
| **effective_cache_size**                | 24 GB (75% of RAM)                            | Query planner hint                           |
| **work_mem**                            | 64 MB                                         | Sufficient for sorting/hashing               |
| **maintenance_work_mem**                | 1 GB                                          | Speeds up VACUUM and index creation          |
| **wal_level**                           | logical                                       | Required for streaming replication + CDC     |
| **statement_timeout**                   | 30s                                           | Kill runaway queries                         |
| **idle_in_transaction_session_timeout** | 10s                                           | Kill zombie transactions                     |
| **lock_timeout**                        | 5s                                            | Fail fast on lock contention                 |

### 2.3 PgBouncer

| Parameter                | Value         | Rationale                                             |
| ------------------------ | ------------- | ----------------------------------------------------- |
| **pool_mode**            | transaction   | Required for RLS (`SET LOCAL` resets per transaction) |
| **max_client_conn**      | 2000          | Supports 10+ gateway instances × 25 pool size each    |
| **default_pool_size**    | 25            | Per-database pool size                                |
| **reserve_pool_size**    | 5             | Burst capacity                                        |
| **reserve_pool_timeout** | 3s            | How long to wait before using reserve                 |
| **server_check_query**   | `SELECT 1`    | Connection validation                                 |
| **server_check_delay**   | 30s           | Health check interval                                 |
| **auth_type**            | scram-sha-256 | Secure authentication                                 |
| **server_tls_sslmode**   | verify-full   | TLS to PostgreSQL                                     |

**Critical RLS note:** PgBouncer in `transaction` mode resets all session-level settings between transactions. This is **correct and required** for RLS — each transaction independently sets `app.current_tenant_id` via `SET LOCAL`. Never use `session` mode with multi-tenant RLS.

### 2.4 Redis

| Purpose               | Configuration                                                         |
| --------------------- | --------------------------------------------------------------------- |
| **Rate limiting**     | Sliding window counters per tenant/user/IP                            |
| **Session cache**     | Short-TTL cache for hot session reads (30s TTL)                       |
| **Config cache**      | Per-tenant config cache (5 min TTL, invalidate on write)              |
| **DEK cache sync**    | Pub/sub for DEK invalidation across gateway instances                 |
| **Distributed locks** | Redlock for coordinated operations (partition creation, DEK rotation) |

```
Instance: ElastiCache r6g.large (2 vCPU, 13 GB)
Mode: Cluster mode disabled (single shard, replica for HA)
Eviction: allkeys-lru
maxmemory: 10 GB
```

### 2.5 Object Storage (Media)

| Parameter      | Value                                                                           |
| -------------- | ------------------------------------------------------------------------------- |
| **Provider**   | S3 / MinIO (self-hosted)                                                        |
| **Bucket**     | `openclaw-media-{env}`                                                          |
| **Key prefix** | `{tenant_id}/{channel_type}/{date}/`                                            |
| **Encryption** | SSE-KMS (S3) or server-side AES-256 (MinIO)                                     |
| **Lifecycle**  | Transition to IA after 90 days; delete after `media.ttlHours` per tenant config |
| **Access**     | Pre-signed URLs (1 hour expiry); no public access                               |

---

## 3. Horizontal Scaling Strategy

### 3.1 Gateway Scaling

```yaml
# Kubernetes HPA example
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: openclaw-gateway
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: openclaw-gateway
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
    - type: Pods
      pods:
        metric:
          name: websocket_connections
        target:
          type: AverageValue
          averageValue: "500" # scale when avg WS connections > 500 per pod
```

### 3.2 WebSocket Sticky Sessions

WebSocket connections require session affinity during a connection lifetime:

```yaml
# Ingress annotation for sticky sessions
metadata:
  annotations:
    nginx.ingress.kubernetes.io/affinity: cookie
    nginx.ingress.kubernetes.io/affinity-mode: balanced
    nginx.ingress.kubernetes.io/session-cookie-name: openclaw-ws-affinity
    nginx.ingress.kubernetes.io/session-cookie-expires: "86400"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "86400"
```

**Important:** Sticky sessions are for WebSocket connection persistence only. All HTTP API requests are stateless and can hit any gateway instance.

### 3.3 Database Scaling Path

```
Stage 1 (launch):
  Primary + 1 Read Replica
  PgBouncer on each gateway node (sidecar)

Stage 2 (10K tenants):
  Primary + 2 Read Replicas
  Dedicated PgBouncer cluster (2 nodes)
  Route analytics/reporting queries to replicas

Stage 3 (50K tenants):
  Primary + 3 Read Replicas
  Consider Citus for distributed queries
  OR application-level sharding by tenant_id

Stage 4 (100K+ tenants):
  Dedicated DB for enterprise tier
  Shard free/starter/pro tenants by region
  CQRS: separate write and read models
```

---

## 4. Caching Architecture

### 4.1 Cache Layers

```
┌─────────────────────────────────────────────────┐
│ Layer 1: In-Process (per gateway instance)       │
│   • DEK cache (5 min TTL)                        │
│   • Config cache (30s TTL)                       │
│   • Allowlist cache (60s TTL)                    │
│   • Hot session cache (LRU, 1000 entries)        │
└────────────────────┬────────────────────────────┘
                     │ cache miss
                     ▼
┌─────────────────────────────────────────────────┐
│ Layer 2: Redis (shared across gateway instances)  │
│   • Tenant config (5 min TTL)                    │
│   • Session metadata (30s TTL)                   │
│   • Rate limit counters                          │
│   • Distributed lock state                       │
└────────────────────┬────────────────────────────┘
                     │ cache miss
                     ▼
┌─────────────────────────────────────────────────┐
│ Layer 3: PostgreSQL (source of truth)             │
│   • All persistent data                          │
│   • RLS enforced on every query                  │
└─────────────────────────────────────────────────┘
```

### 4.2 Cache Invalidation

```typescript
// Redis pub/sub channels for cross-instance cache invalidation
const CACHE_CHANNELS = {
  CONFIG_UPDATED: "cache:config:updated", // payload: { tenantId }
  SECRET_UPDATED: "cache:secret:updated", // payload: { tenantId, key }
  DEK_ROTATED: "cache:dek:rotated", // payload: { tenantId }
  ALLOWLIST_UPDATED: "cache:allowlist:updated", // payload: { tenantId, channelAccountId }
};

// Publisher: after any write to tenant_configs
async function onConfigWrite(tenantId: string): Promise<void> {
  // Invalidate local cache
  localConfigCache.delete(tenantId);
  // Invalidate Redis cache
  await redis.del(`config:${tenantId}`);
  // Notify other gateway instances
  await redis.publish(CACHE_CHANNELS.CONFIG_UPDATED, JSON.stringify({ tenantId }));
}

// Subscriber: each gateway instance listens for invalidation events
redis.subscribe(Object.values(CACHE_CHANNELS), (channel, message) => {
  const { tenantId } = JSON.parse(message);
  switch (channel) {
    case CACHE_CHANNELS.CONFIG_UPDATED:
      localConfigCache.delete(tenantId);
      break;
    case CACHE_CHANNELS.DEK_ROTATED:
      dekCache.invalidate(tenantId);
      break;
    // ... other channels
  }
});
```

---

## 5. Observability

### 5.1 Metrics (Prometheus/OpenTelemetry)

#### Application Metrics

| Metric                                         | Type      | Labels                                   | Alert Threshold     |
| ---------------------------------------------- | --------- | ---------------------------------------- | ------------------- |
| `openclaw_http_request_duration_seconds`       | Histogram | method, path, status, tenant_id          | p99 > 1s            |
| `openclaw_ws_connections_active`               | Gauge     | tenant_id                                | > 1000 per instance |
| `openclaw_session_operations_total`            | Counter   | operation (read/write/delete), tenant_id | —                   |
| `openclaw_session_operation_duration_seconds`  | Histogram | operation, tenant_id                     | p99 > 50ms          |
| `openclaw_secret_operations_total`             | Counter   | operation (encrypt/decrypt), tenant_id   | —                   |
| `openclaw_secret_operation_duration_seconds`   | Histogram | operation                                | p99 > 10ms          |
| `openclaw_message_events_total`                | Counter   | direction, channel_type, tenant_id       | —                   |
| `openclaw_config_cache_hit_ratio`              | Gauge     | —                                        | < 0.90              |
| `openclaw_dek_cache_hit_ratio`                 | Gauge     | —                                        | < 0.95              |
| `openclaw_rate_limit_rejections_total`         | Counter   | scope, tenant_id                         | spike detection     |
| `openclaw_tenant_active_sessions`              | Gauge     | tenant_id                                | > plan limit        |
| `openclaw_webhook_processing_duration_seconds` | Histogram | channel_type                             | p99 > 500ms         |

#### Database Metrics (pg_stat_statements + custom)

```sql
-- Top slow queries (run every 5 minutes, export to metrics)
SELECT query, calls,
  round(mean_exec_time::numeric, 2) AS avg_ms,
  round(max_exec_time::numeric, 2) AS max_ms,
  round(total_exec_time::numeric / 1000, 2) AS total_seconds
FROM pg_stat_statements
WHERE mean_exec_time > 50  -- only queries averaging > 50ms
ORDER BY mean_exec_time DESC
LIMIT 20;

-- Cache hit ratio (should be > 95%)
SELECT
  sum(blks_hit)::float / nullif(sum(blks_hit + blks_read), 0) AS cache_ratio
FROM pg_stat_database
WHERE datname = current_database();

-- Dead tuple ratio per table (should be < 10%)
SELECT relname, n_dead_tup, n_live_tup,
  round(n_dead_tup::numeric / nullif(n_live_tup, 0) * 100, 1) AS dead_pct,
  last_autovacuum
FROM pg_stat_user_tables
WHERE n_live_tup > 1000
ORDER BY n_dead_tup DESC;

-- Table sizes (track growth)
SELECT relname,
  pg_size_pretty(pg_total_relation_size(oid)) AS total_size,
  pg_size_pretty(pg_indexes_size(oid)) AS index_size,
  n_live_tup AS live_rows
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(oid) DESC;

-- Connection pool utilization
SELECT count(*) AS total_connections,
  count(*) FILTER (WHERE state = 'active') AS active,
  count(*) FILTER (WHERE state = 'idle') AS idle,
  count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx
FROM pg_stat_activity
WHERE backend_type = 'client backend';

-- Sequential scan detection (should be minimal on large tables)
SELECT relname, seq_scan, idx_scan,
  round(idx_scan::numeric / nullif(seq_scan + idx_scan, 0) * 100, 1) AS idx_pct
FROM pg_stat_user_tables
WHERE seq_scan > 100
  AND n_live_tup > 10000
ORDER BY seq_scan DESC;
```

### 5.2 Logging

```typescript
// Structured logging with tenant context
interface LogContext {
  tenantId?: string;
  userId?: string;
  sessionKey?: string;
  channelType?: string;
  requestId: string; // unique per HTTP request / WS message
  traceId?: string; // OpenTelemetry trace ID
}

// Log levels:
// ERROR — failures requiring immediate attention (DB errors, encryption failures)
// WARN  — degraded operation (cache miss, fallback to filesystem, rate limit approached)
// INFO  — normal operations (tenant created, config updated, session started)
// DEBUG — verbose (query timing, cache hit/miss detail, RLS context)

// CRITICAL RULE: Never log secret values, decrypted data, or full config payloads.
// Redact fields: encrypted_value, password, token, api_key, authorization header.
```

### 5.3 Alerting Rules

| Alert                         | Condition                                                                              | Severity | Action                                         |
| ----------------------------- | -------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| **DB Connection Exhaustion**  | active connections > 80% of max                                                        | Critical | Scale PgBouncer; check connection leaks        |
| **Cache Ratio Drop**          | cache_ratio < 0.95 for 10 min                                                          | Warning  | Check shared_buffers; identify large seq scans |
| **Dead Tuple Bloat**          | dead_pct > 10% on any table for 1 hour                                                 | Warning  | Check autovacuum; manual VACUUM if needed      |
| **Slow Queries**              | mean_exec_time > 1000ms for any query                                                  | Warning  | Add index; optimize query plan                 |
| **RLS Bypass Attempt**        | `app.bypass_rls = 'on'` set from non-service role                                      | Critical | Immediate investigation; potential breach      |
| **Secret Decryption Failure** | decrypt errors > 5/min for any tenant                                                  | Critical | Check KMS connectivity; verify DEK integrity   |
| **Cross-Tenant Query**        | Any query returning data where `tenant_id != current_setting('app.current_tenant_id')` | Critical | Data isolation breach; incident response       |
| **High Error Rate**           | HTTP 5xx > 1% for 5 min                                                                | Critical | Check DB health; check gateway logs            |
| **Session Latency**           | session read p99 > 100ms for 5 min                                                     | Warning  | Check connection pool; check index health      |
| **Partition Missing**         | Next month's partition not created 7 days before month end                             | Warning  | Run partition creation job                     |
| **DEK Expiry**                | Any tenant DEK older than 90 days                                                      | Warning  | Trigger key rotation                           |

### 5.4 Dashboards

**Dashboard 1 — Platform Health**

- Request rate (total, per-tenant top 10)
- Error rate (5xx, 4xx)
- Latency percentiles (p50, p95, p99)
- Active WebSocket connections
- DB connection pool utilization
- Cache hit ratios (config, session, DEK)

**Dashboard 2 — Tenant Health**

- Active tenants (by plan)
- Sessions per tenant (distribution)
- Message throughput per tenant
- Secret access patterns
- Rate limit rejections

**Dashboard 3 — Database Health**

- Query latency (top 20 slowest)
- Cache ratio
- Dead tuple ratios
- Table sizes and growth
- Replication lag
- Autovacuum activity

**Dashboard 4 — Security**

- Auth failures (by type, by IP)
- Rate limit triggers
- Audit log volume
- DEK rotation status
- Secret access anomalies

---

## 6. Disaster Recovery

### 6.1 Backup Strategy

| Component                  | Backup Method                        | Frequency                       | Retention             | RTO            | RPO         |
| -------------------------- | ------------------------------------ | ------------------------------- | --------------------- | -------------- | ----------- |
| **PostgreSQL**             | Automated snapshots (RDS/pgBackRest) | Continuous WAL + daily snapshot | 30 days               | 15 min         | 5 min (WAL) |
| **Object Storage (Media)** | Cross-region replication             | Continuous                      | Matches tenant config | 0 (replicated) | 0           |
| **Redis**                  | RDB snapshots                        | Every 6 hours                   | 7 days                | 5 min          | 6 hours     |
| **KMS Keys**               | Provider-managed (multi-region)      | Continuous                      | Indefinite            | 0              | 0           |
| **Configuration (IaC)**    | Git (Terraform/Pulumi)               | On every change                 | Indefinite            | 30 min         | 0           |

### 6.2 Recovery Procedures

#### Database Recovery

```
Scenario: Primary DB failure
─────────────────────────────
1. Promote read replica to primary (< 1 min)
2. Update PgBouncer to point to new primary
3. Gateway instances reconnect automatically (connection retry)
4. Create new read replica from promoted primary
5. Verify: RLS policies active, all tables accessible

Scenario: Data corruption (logical)
────────────────────────────────────
1. Identify affected time range from audit_logs
2. Point-in-time recovery to pre-corruption snapshot
3. Restore affected tables only (pg_restore --data-only --table=...)
4. Verify data integrity with reconciliation scripts
5. Re-encrypt secrets if DEK table was affected
```

#### Tenant Data Export

```typescript
// Tenant data export for portability and compliance (GDPR right to data portability)
interface TenantExport {
  tenant: TenantRecord;
  config: OpenClawConfig;
  agents: AgentRecord[];
  channels: ChannelAccountRecord[]; // credentials excluded
  sessions: SessionRecord[]; // messages included
  allowlists: AllowlistRecord[];
  auditLogs: AuditLogRecord[];
  // Secrets NOT included in export — tenant must re-enter credentials
}

async function exportTenantData(db: DrizzleClient, tenantId: string): Promise<TenantExport> {
  return withTenantContext(db, tenantId, async (tx) => {
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
    const config = await tx
      .select()
      .from(tenantConfigs)
      .where(and(eq(tenantConfigs.tenantId, tenantId), eq(tenantConfigs.isActive, true)));
    const agentList = await tx.select().from(agents).where(eq(agents.tenantId, tenantId));
    // ... etc
    return { tenant, config: config[0]?.configData ?? {}, agents: agentList /* ... */ };
  });
}
```

### 6.3 Tenant Deletion

```
Tenant Deletion Procedure (GDPR-compliant):
────────────────────────────────────────────
Trigger: Owner requests deletion via API or admin action.

Step 1 — Soft delete (immediate):
  • SET tenants.status = 'cancelled', tenants.deleted_at = NOW()
  • All RLS-scoped queries return empty (tenant data invisible)
  • Gateway stops processing messages for this tenant

Step 2 — Grace period (30 days):
  • Tenant can be reactivated by support
  • Data preserved but inaccessible

Step 3 — Hard delete (after grace period):
  • DELETE FROM tenants WHERE id = $tenant_id (CASCADE deletes all child tables)
  • Delete media from object storage: s3 rm --recursive s3://bucket/{tenant_id}/
  • Delete vector embeddings
  • Shred DEKs (overwrite with random bytes before DELETE)
  • Audit log: action = 'tenant.purged' (audit logs retained per compliance)

Step 4 — Verification:
  • Confirm zero rows in all tenant-scoped tables for this tenant_id
  • Confirm zero objects in S3 with this tenant_id prefix
```

---

## 7. SLA Targets

| Metric                  | Free Tier   | Starter     | Pro           | Enterprise     |
| ----------------------- | ----------- | ----------- | ------------- | -------------- |
| **Uptime**              | 99%         | 99.5%       | 99.9%         | 99.95%         |
| **API Latency (p99)**   | 500ms       | 200ms       | 100ms         | 50ms           |
| **Message Processing**  | Best effort | < 5s        | < 2s          | < 1s           |
| **Data Retention**      | 30 days     | 90 days     | 1 year        | Custom         |
| **Backup RPO**          | 24h         | 6h          | 5 min         | 1 min          |
| **Support**             | Community   | Email (48h) | Email (4h)    | Dedicated (1h) |
| **Data Residency**      | US only     | US/EU       | US/EU/AP      | Custom         |
| **SSO**                 | —           | —           | Google/GitHub | Custom OIDC    |
| **Audit Log Retention** | 7 days      | 90 days     | 1 year        | Custom         |

---

## 8. Infrastructure as Code

### 8.1 Recommended Stack

| Layer                       | Tool                                                 | Rationale                                            |
| --------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| **IaC**                     | Terraform or Pulumi                                  | Declarative, reproducible, drift detection           |
| **Container Orchestration** | Kubernetes (EKS/GKE) or Docker Compose (small scale) | Horizontal scaling, rolling deploys                  |
| **CI/CD**                   | GitHub Actions (existing)                            | Already in use; add deployment stages                |
| **Secret Management**       | AWS Secrets Manager / HashiCorp Vault                | Store DATABASE_URL, KMS keys, JWT signing keys       |
| **DNS**                     | Route 53 / Cloudflare                                | Tenant custom domains (future)                       |
| **Monitoring**              | Prometheus + Grafana or Datadog                      | Metrics, dashboards, alerting                        |
| **Logging**                 | Loki or CloudWatch Logs                              | Centralized, structured, searchable                  |
| **Tracing**                 | OpenTelemetry + Jaeger/Tempo                         | Distributed request tracing across gateway instances |

### 8.2 Environment Progression

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│   Dev    │───▶│ Staging  │───▶│ Preview  │───▶│Production│
│          │    │          │    │ (per-PR)  │    │          │
│ Local DB │    │ Shared DB│    │ Ephemeral │    │ HA DB    │
│ No KMS   │    │ Test KMS │    │ Test KMS  │    │ Prod KMS │
│ 1 gateway│    │ 2 gateway│    │ 1 gateway │    │ N gateway│
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

### 8.3 CI/CD Pipeline Additions

```yaml
# .github/workflows/saas-deploy.yml (conceptual)
jobs:
  test:
    steps:
      - pnpm install
      - pnpm check # lint + format
      - pnpm build # type-check + compile
      - pnpm test # unit tests (includes RLS isolation tests)

  integration-test:
    needs: test
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_DB: openclaw_test
    steps:
      - pnpm drizzle-kit push # apply schema to test DB
      - pnpm test:integration # DB-backed integration tests

  deploy-staging:
    needs: integration-test
    if: github.ref == 'refs/heads/main'
    steps:
      - terraform apply -target=module.staging
      - pnpm drizzle-kit push --config=drizzle.staging.config.ts
      - kubectl rollout restart deployment/openclaw-gateway -n staging

  deploy-production:
    needs: deploy-staging
    if: github.event_name == 'release'
    steps:
      - terraform apply -target=module.production
      - pnpm drizzle-kit push --config=drizzle.production.config.ts # safe migrations only
      - kubectl rollout restart deployment/openclaw-gateway -n production
      # Post-deploy verification
      - curl -f https://api.openclaw.ai/healthz
      - pnpm test:smoke --env=production
```

---

## 9. Cost Estimation (Monthly, at Launch Scale)

| Component                           | Specification                       | Estimated Cost    |
| ----------------------------------- | ----------------------------------- | ----------------- |
| **PostgreSQL (RDS)**                | db.r6g.xlarge, 500 GB gp3, Multi-AZ | ~$600             |
| **Read Replica**                    | db.r6g.large                        | ~$250             |
| **Gateway Instances**               | 3× t3.xlarge (4 vCPU, 16 GB)        | ~$450             |
| **Redis (ElastiCache)**             | r6g.large, single node              | ~$200             |
| **Load Balancer (ALB)**             | + data transfer                     | ~$50              |
| **Object Storage (S3)**             | 100 GB + requests                   | ~$10              |
| **KMS**                             | 1 master key + API calls            | ~$5               |
| **Monitoring (CloudWatch/Datadog)** | Custom metrics + logs               | ~$100             |
| **CDN (CloudFront)**                | Control UI static assets            | ~$20              |
| **Total**                           |                                     | **~$1,685/month** |

**Break-even analysis:** At $29/month for Starter plan, ~60 paying tenants cover infrastructure. At $99/month for Pro, ~17 tenants.

---

## 10. What to Watch After Launch

### Week 1

- [ ] Confirm cache_ratio > 95% via `pg_stat_database`
- [ ] Confirm no large sequential scans on tables > 10K rows
- [ ] Confirm autovacuum is running on sessions and message_events
- [ ] Verify DEK cache hit ratio > 95%
- [ ] Monitor PgBouncer connection utilization (should be < 50%)
- [ ] Check RLS audit: no cross-tenant query patterns in logs

### Month 1

- [ ] Review slow query log — add indexes if mean_exec_time > 100ms
- [ ] Check dead tuple ratios on high-churn tables
- [ ] Verify connection count stays below 60% of max_connections
- [ ] Assess partition strategy: are monthly partitions appropriately sized?
- [ ] Review rate limit effectiveness: are abuse patterns caught?
- [ ] First DEK rotation cycle completed successfully for all tenants

### At 1,000 Tenants

- [ ] Assess need for second read replica
- [ ] Review pgvector index performance (IVFFlat lists parameter)
- [ ] Evaluate moving to dedicated PgBouncer cluster
- [ ] Check tenant distribution: any noisy neighbors?
- [ ] Review object storage costs and lifecycle policies

### At 10,000 Tenants

- [ ] Plan for schema-per-tenant for enterprise tier
- [ ] Evaluate Citus or application-level sharding
- [ ] Consider CQRS for analytics workloads
- [ ] Review multi-region deployment for data residency
- [ ] Assess dedicated DB offerings for enterprise tier
