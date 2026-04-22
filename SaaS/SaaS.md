# OpenClaw SaaS Transformation Plan

> **Status:** Draft — Ready for technical review
> **Author:** AI Architect (Cascade)
> **Target:** Transform OpenClaw from single-tenant self-hosted gateway → multi-tenant SaaS platform
> **Primary Focus:** Customer data isolation and protection

---

## Plan Structure

This plan is organized into 5 documents, each self-contained and ordered for sequential execution:

| #     | Document                                                 | Focus Area                              | Key Deliverables                                                                                      |
| ----- | -------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **0** | [00-overview.md](./00-overview.md)                       | Executive Overview                      | Current-state analysis, SaaS vision, risk assessment, technology decisions, timeline                  |
| **1** | [01-data-isolation.md](./01-data-isolation.md)           | Data Isolation & PostgreSQL Schema      | Full production-grade DDL (14 tables), RLS policies, indexes, partitioning, pgvector, scaling roadmap |
| **2** | [02-security-encryption.md](./02-security-encryption.md) | Security, Encryption & Secrets          | JWT/OIDC auth, RBAC, AES-256-GCM envelope encryption, KMS integration, key rotation, audit trail      |
| **3** | [03-migration-strategy.md](./03-migration-strategy.md)   | Migration Strategy & Execution          | 4-phase rollout, dual-write strategy, migration scripts, feature flags, rollback plans                |
| **4** | [04-infrastructure.md](./04-infrastructure.md)           | Infrastructure, Scaling & Observability | Deployment topology, PgBouncer, Redis, monitoring, alerting, disaster recovery, cost estimation       |

---

## Current State (Summary)

OpenClaw today is a **single-tenant, self-hosted** multi-channel AI gateway with:

- **No database** — all persistence is JSON files on local filesystem
- **No user accounts** — gateway uses shared bearer tokens
- **No multi-tenancy** — single config, single set of credentials, single session store
- **Strong plugin architecture** — extensible channel/provider system worth preserving

---

## Target State (Summary)

A **multi-tenant SaaS platform** where:

- Every tenant's data is **isolated at the database level** via PostgreSQL Row-Level Security (RLS)
- All secrets are **encrypted at rest** with per-tenant keys (AES-256-GCM envelope encryption)
- Authentication uses **JWT + OIDC** with tenant-scoped claims
- Gateway instances are **stateless and horizontally scalable** — no shared filesystem
- **Self-hosted mode is preserved** as a feature-flag-gated single-tenant deployment
- **Audit trail** captures every sensitive operation immutably

---

## Data Isolation Architecture (Core)

```
┌─────────────────────────────────────────────────────────────┐
│                    ISOLATION LAYERS                           │
│                                                             │
│  Layer 1: Authentication (JWT)                               │
│    └─ Every request carries tenant_id in JWT claims          │
│                                                             │
│  Layer 2: Application (Middleware)                            │
│    └─ SET LOCAL app.current_tenant_id = '{tenant_id}'        │
│    └─ All queries include WHERE tenant_id = ? (belt)         │
│                                                             │
│  Layer 3: Database (RLS)                                     │
│    └─ POLICY tenant_isolation USING                          │
│       (tenant_id = current_setting('app.current_tenant_id')) │
│    └─ FORCE ROW LEVEL SECURITY on every tenant table         │
│                                                             │
│  Layer 4: Encryption                                         │
│    └─ Per-tenant DEK (Data Encryption Key)                   │
│    └─ Master KEK in KMS (never leaves KMS)                   │
│    └─ All secrets: AES-256-GCM encrypted at rest             │
└─────────────────────────────────────────────────────────────┘
```

---

## Execution Timeline

```
Phase 0 — Foundation          [Weeks 1–4]    → PostgreSQL, auth, encryption core
Phase 1 — Core Migration      [Weeks 5–10]   → Config, sessions, secrets → DB
Phase 2 — Channel Isolation   [Weeks 11–14]  → Per-tenant webhooks, media, RAG
Phase 3 — Platform Layer      [Weeks 15–18]  → Billing, usage metering, onboarding
Phase 4 — Hardening           [Weeks 19–22]  → Pen testing, benchmarks, GA prep
```

---

## Quick Reference — Technology Decisions

| Concern            | Decision                                             |
| ------------------ | ---------------------------------------------------- |
| Database           | PostgreSQL 16+                                       |
| ORM                | Drizzle ORM                                          |
| Tenant isolation   | Shared schema + RLS                                  |
| Connection pooling | PgBouncer (transaction mode)                         |
| Secrets encryption | AES-256-GCM, envelope encryption, per-tenant DEKs    |
| KMS                | AWS KMS / GCP KMS / HashiCorp Vault / Local fallback |
| Auth               | JWT (ES256) + OIDC                                   |
| Vector store       | pgvector (replaces LanceDB)                          |
| Caching            | In-process + Redis                                   |
| Object storage     | S3 / MinIO (tenant-prefixed)                         |

---

## How to Read This Plan

1. Start with **00-overview.md** for the full current-state analysis and risk assessment
2. Read **01-data-isolation.md** for the complete PostgreSQL schema (copy-paste-ready DDL)
3. Read **02-security-encryption.md** for the encryption and auth design
4. Read **03-migration-strategy.md** for the phased execution plan with rollback procedures
5. Read **04-infrastructure.md** for deployment, scaling, and operational concerns
