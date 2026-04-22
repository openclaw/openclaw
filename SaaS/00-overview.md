# OpenClaw SaaS Transformation Plan — Executive Overview

> **Document:** 00-overview.md
> **Scope:** Current-state analysis, SaaS vision, risk assessment, and execution roadmap index
> **Audience:** Engineering leadership, Staff+ architects, Security team

---

## 1. Current Architecture Summary

OpenClaw is a **multi-channel AI gateway** that routes messages across 20+ messaging channels (Telegram, Discord, Slack, Signal, WhatsApp, Matrix, MS Teams, etc.) to LLM providers. Today it operates as a **single-tenant, self-hosted** application.

### 1.1 Data Storage — Current State

| Layer                   | Current Implementation                                                        | SaaS Risk                                                                |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Configuration**       | Single JSON5 file (`~/.openclaw/openclaw.json`)                               | No tenant isolation; single config governs all behavior                  |
| **Sessions**            | JSON files on local filesystem (`sessions/store.ts`) with file-level locking  | No multi-tenant session separation; file I/O does not scale horizontally |
| **Secrets/Credentials** | Env vars, file-based, or exec-based providers (`src/secrets/`)                | Secrets are global; no per-tenant vault isolation                        |
| **Auth Profiles**       | JSON file (`auth-profiles.json`) in state dir                                 | Single set of provider credentials; no tenant-scoped API keys            |
| **Pairing/Allowlists**  | Per-channel JSON files (`{channel}-allowFrom.json`, `{channel}-pairing.json`) | Flat files; no tenant scoping                                            |
| **Memory/RAG**          | Builtin or QMD (LanceDB vector store)                                         | Single vector namespace; no tenant data boundaries                       |
| **Media**               | Local filesystem with optional TTL cleanup                                    | No tenant-scoped storage quotas or isolation                             |
| **Gateway Auth**        | Token/password, Tailscale, trusted-proxy                                      | No user accounts, no RBAC, no tenant identity                            |

### 1.2 Key Architectural Characteristics

- **No relational database** — entire persistence layer is JSON files on disk
- **No user/account management system** — gateway uses bearer tokens, not user identities
- **No multi-tenancy primitives** — `accountId` exists in routing but maps to channel bot accounts, not SaaS tenants
- **Plugin SDK** — rich extension system (`extensions/`) with well-defined boundaries
- **Stateless gateway core** — the HTTP/WS gateway itself is largely stateless; state lives in files
- **Config-driven architecture** — behavior controlled via `openclaw.json` with env var substitution and `$include` directives

### 1.3 Strengths to Preserve

1. **Plugin architecture** — extensible channel/provider system via `extensions/`
2. **Config validation** — Zod-based schema validation with migration support
3. **Security posture** — existing secrets resolution, host env security policies, CSP, rate limiting
4. **Channel abstraction** — unified `ChannelId` + routing layer decouples channels from core logic
5. **Session key design** — structured `agent:{agentId}:{key}` format supports future scoping

---

## 2. SaaS Target Architecture

### 2.1 Vision

Transform OpenClaw from a self-hosted single-tenant gateway into a **multi-tenant SaaS platform** where:

- Each **tenant** (organization) gets an isolated workspace with its own config, channels, agents, and credentials
- **Data isolation** is enforced at the database level (RLS) — not just application logic
- **Secrets** are encrypted per-tenant with tenant-scoped key hierarchies
- **Horizontal scaling** is achievable without filesystem coupling
- The **self-hosted mode** remains supported as a degenerate single-tenant deployment

### 2.2 Tenancy Model Decision

**Chosen model: Shared Database / Shared Schema with Row-Level Security (RLS)**

| Alternative                                | Verdict            | Reason                                                                                                           |
| ------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| DB-per-tenant                              | Rejected (for now) | Operationally expensive at scale; connection pool explosion; hard to query across tenants for platform analytics |
| Schema-per-tenant                          | Rejected (for now) | Migration complexity scales linearly with tenant count; DDL drift risk                                           |
| **Shared schema + RLS**                    | **Selected**       | Optimal for 1–10,000 tenants; single migration path; PostgreSQL RLS provides DB-enforced isolation               |
| Hybrid (shared + dedicated for enterprise) | Future upgrade     | Enterprise tier can graduate to dedicated schemas/databases when compliance requires it                          |

### 2.3 Technology Decisions

| Concern                   | Decision                                            | Rationale                                                                       |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Primary Database**      | PostgreSQL 16+                                      | RLS, JSONB, partitioning, `pg_stat_statements`, mature ecosystem                |
| **ORM/Query Layer**       | Drizzle ORM                                         | TypeScript-native, migration-safe, lightweight, supports RLS via `SET` commands |
| **Connection Pooling**    | PgBouncer (transaction mode)                        | Required for horizontal gateway scaling; prevents connection exhaustion         |
| **Secrets Encryption**    | AES-256-GCM with per-tenant DEKs, master KEK in KMS | Envelope encryption; tenant key rotation without re-encrypting all data         |
| **Auth**                  | OIDC/OAuth 2.0 + JWT with tenant claims             | Standard SaaS auth; supports SSO for enterprise tenants                         |
| **Migration Tool**        | Drizzle Kit                                         | Aligned with ORM choice; generates safe DDL                                     |
| **Vector Store (Memory)** | pgvector extension                                  | Eliminates separate LanceDB dependency; tenant-isolated via RLS                 |

---

## 3. Risk Assessment

### 3.1 High-Risk Areas

| Risk                             | Impact                        | Mitigation                                                                                              |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Data leakage between tenants** | Critical — trust-destroying   | RLS enforced at DB level; defense-in-depth with application-layer checks; penetration testing per phase |
| **Session store migration**      | High — data loss potential    | Dual-write phase; filesystem fallback; reversible migration batches                                     |
| **Secrets migration**            | High — credential exposure    | Encrypt-on-read during migration; never log plaintext; audit trail on every access                      |
| **Plugin compatibility**         | Medium — ecosystem breakage   | Versioned Plugin SDK; tenant context injected via existing `deps` pattern                               |
| **Performance regression**       | Medium — user-facing latency  | Benchmark filesystem vs. DB latency before/after; connection pooling; read replicas                     |
| **Self-hosted mode breakage**    | Medium — existing user impact | SQLite fallback for single-tenant; feature flags gate SaaS-only paths                                   |

### 3.2 Non-Negotiable Constraints

1. **Zero data leakage** — a tenant must never see another tenant's sessions, config, secrets, or messages
2. **Backward compatibility** — self-hosted single-tenant mode must continue working
3. **Plugin SDK stability** — existing plugins must work without modification in Phase 1
4. **No plaintext secrets at rest** — all tenant credentials encrypted with per-tenant keys
5. **Audit trail** — every sensitive operation (secret access, config change, admin action) logged immutably

---

## 4. Document Index

This plan is structured in execution order. Each document is self-contained but references predecessors.

| Document                      | Title                                        | Focus                                                            |
| ----------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| **00-overview.md**            | Executive Overview (this document)           | Current state, vision, risk assessment                           |
| **01-data-isolation.md**      | Data Isolation and PostgreSQL Schema         | Tenant model, RLS, full DDL, indexes, partitioning               |
| **02-security-encryption.md** | Security, Encryption, and Secrets Management | Auth, encryption architecture, key management, secrets migration |
| **03-migration-strategy.md**  | Migration Strategy and Execution Phases      | Phased rollout, dual-write, data migration, rollback plans       |
| **04-infrastructure.md**      | Infrastructure, Scaling, and Observability   | Deployment topology, connection pooling, monitoring, SLAs        |

---

## 5. Execution Timeline (High-Level)

```
Phase 0 — Foundation          [Weeks 1–4]
  ├── PostgreSQL + Drizzle setup
  ├── Tenant/user tables + RLS
  ├── Auth service (JWT + OIDC)
  └── Database abstraction layer

Phase 1 — Core Migration      [Weeks 5–10]
  ├── Config store → DB
  ├── Session store → DB (dual-write)
  ├── Secrets vault (encrypted)
  └── Pairing/allowlist → DB

Phase 2 — Channel Isolation   [Weeks 11–14]
  ├── Per-tenant channel credentials
  ├── Per-tenant webhook routing
  ├── Media storage isolation
  └── Memory/RAG tenant scoping

Phase 3 — Platform Layer      [Weeks 15–18]
  ├── Billing/subscription tables
  ├── Usage metering
  ├── Admin dashboard
  └── Tenant onboarding flow

Phase 4 — Hardening           [Weeks 19–22]
  ├── Penetration testing
  ├── Performance benchmarks
  ├── Self-hosted compatibility verification
  └── GA release preparation
```

---

## 6. Success Criteria

| Metric                         | Target                                                      |
| ------------------------------ | ----------------------------------------------------------- |
| **Tenant data isolation**      | Zero cross-tenant data access in penetration test           |
| **Session latency (p99)**      | < 50ms for session read (vs. current filesystem baseline)   |
| **Config read latency (p99)**  | < 20ms (cached), < 100ms (cold)                             |
| **Secrets decryption latency** | < 5ms per secret                                            |
| **Horizontal scaling**         | Gateway instances scale independently; no shared filesystem |
| **Self-hosted compatibility**  | All existing `openclaw gateway run` workflows unchanged     |
| **Plugin SDK backward compat** | 100% of bundled plugins pass existing test suites           |
| **Concurrent tenants**         | Support 1,000 tenants with 5,000 concurrent sessions each   |
