# MABOS ERP Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 13 ERP domain tools to MABOS agents with Postgres + TypeDB + BDI markdown hybrid data layer and two-way sync.

**Architecture:** Domain-action tools (`erp_<domain>`) built by a factory, backed by Postgres (transactional), TypeDB (knowledge graph), and markdown (cognitive state). A sync engine bridges ERP records with BDI agent cognitive files bidirectionally.

**Tech Stack:** TypeScript ESM, Postgres (pg), TypeDB (typedb-driver), Vitest, existing AgentTool interface from pi-agent-core.

**Design Doc:** `docs/plans/2026-02-19-erp-tools-design.md`

**Commit convention:** Use `scripts/committer "<msg>" <file...>` for all commits.

**Test convention:** Colocated `*.test.ts` files. Run with `pnpm test <path>`. TDD: write failing test first.

**Build:** `pnpm build:mabos` compiles via `tsc -p mabos/tsconfig.json`. Update `mabos/tsconfig.json` includes as files are added.

---

## Phase 1: Foundation (DB Clients, Shared Types, Validators, Audit)

### Task 1: Create shared ERP types

**Files:**

- Create: `mabos/erp/shared/types.ts`

**Step 1: Create the types file**

```typescript
// mabos/erp/shared/types.ts

/** ISO 4217 currency code. */
export type CurrencyCode = string;

/** Monetary value with currency. */
export interface Money {
  amount: number;
  currency: CurrencyCode;
}

/** Date range for filtering. */
export interface DateRange {
  from: string; // ISO date
  to: string;
}

/** Pagination params accepted by all list actions. */
export interface PaginationParams {
  limit?: number;
  offset?: number;
}

/** Sort order for list queries. */
export interface SortParams {
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

/** Standard list response wrapper. */
export interface ListResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Common entity statuses used across domains. */
export type EntityStatus = "active" | "archived" | "draft" | "suspended";

/** Result of any ERP tool action. */
export type ErpActionResult<T = unknown> =
  | { success: true; data: T }
  | { error: string; details?: string };

/** Common fields on all ERP entities. */
export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt?: string;
}

/** Audit log entry shape. */
export interface AuditEntry {
  id: string;
  domain: string;
  entityType: string;
  entityId: string;
  action: string;
  agentId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(erp): add shared ERP types" mabos/erp/shared/types.ts
```

---

### Task 2: Create input validators

**Files:**

- Create: `mabos/erp/shared/validators.ts`
- Create: `mabos/erp/shared/validators.test.ts`

**Step 1: Write the failing test**

```typescript
// mabos/erp/shared/validators.test.ts

import { describe, it, expect } from "vitest";
import {
  validateUUID,
  validateISODate,
  validateCurrency,
  validatePositiveAmount,
} from "./validators.js";

describe("ERP validators", () => {
  describe("validateUUID", () => {
    it("accepts valid UUID v4", () => {
      expect(validateUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    });
    it("rejects invalid string", () => {
      expect(validateUUID("not-a-uuid")).toBe(false);
    });
    it("rejects empty string", () => {
      expect(validateUUID("")).toBe(false);
    });
  });

  describe("validateISODate", () => {
    it("accepts YYYY-MM-DD", () => {
      expect(validateISODate("2026-03-15")).toBe(true);
    });
    it("rejects invalid date", () => {
      expect(validateISODate("2026-13-45")).toBe(false);
    });
    it("rejects empty string", () => {
      expect(validateISODate("")).toBe(false);
    });
  });

  describe("validateCurrency", () => {
    it("accepts 3-letter uppercase code", () => {
      expect(validateCurrency("USD")).toBe(true);
      expect(validateCurrency("EUR")).toBe(true);
    });
    it("rejects lowercase", () => {
      expect(validateCurrency("usd")).toBe(false);
    });
    it("rejects wrong length", () => {
      expect(validateCurrency("US")).toBe(false);
    });
  });

  describe("validatePositiveAmount", () => {
    it("accepts positive number", () => {
      expect(validatePositiveAmount(100.5)).toBe(true);
    });
    it("rejects zero", () => {
      expect(validatePositiveAmount(0)).toBe(false);
    });
    it("rejects negative", () => {
      expect(validatePositiveAmount(-10)).toBe(false);
    });
    it("rejects NaN", () => {
      expect(validatePositiveAmount(NaN)).toBe(false);
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run mabos/erp/shared/validators.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write implementation**

```typescript
// mabos/erp/shared/validators.ts

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function validateUUID(value: string): boolean {
  return UUID_RE.test(value);
}

export function validateISODate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

export function validateCurrency(value: string): boolean {
  return CURRENCY_RE.test(value);
}

export function validatePositiveAmount(value: number): boolean {
  return typeof value === "number" && !isNaN(value) && value > 0;
}

/** Validate required fields are present and non-empty. */
export function validateRequired(params: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    if (params[field] === undefined || params[field] === null || params[field] === "") {
      return `Missing required field: ${field}`;
    }
  }
  return null;
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run mabos/erp/shared/validators.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
scripts/committer "feat(erp): add input validators with tests" mabos/erp/shared/validators.ts mabos/erp/shared/validators.test.ts
```

---

### Task 3: Create Postgres client wrapper

**Files:**

- Create: `mabos/erp/db/postgres.ts`

**Step 1: Write the Postgres client**

```typescript
// mabos/erp/db/postgres.ts

import pg from "pg";

const { Pool } = pg;

export type PgClient = pg.Pool;
export type PgQueryResult = pg.QueryResult;

let pool: PgClient | null = null;

export function getErpPgPool(): PgClient {
  if (!pool) {
    pool = new Pool({
      host: process.env.MABOS_PG_HOST ?? "localhost",
      port: parseInt(process.env.MABOS_PG_PORT ?? "5432", 10),
      database: process.env.MABOS_PG_DATABASE ?? "mabos_erp",
      user: process.env.MABOS_PG_USER ?? "mabos",
      password: process.env.MABOS_PG_PASSWORD ?? "",
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

/** Run a query with parameterized values. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  client: PgClient,
  sql: string,
  values?: unknown[],
): Promise<T[]> {
  const result = await client.query<T>(sql, values);
  return result.rows;
}

/** Run a query and return exactly one row, or null. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  client: PgClient,
  sql: string,
  values?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(client, sql, values);
  return rows[0] ?? null;
}

/** Run multiple statements in a transaction. */
export async function transaction<T>(
  client: PgClient,
  fn: (conn: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const conn = await client.connect();
  try {
    await conn.query("BEGIN");
    const result = await fn(conn);
    await conn.query("COMMIT");
    return result;
  } catch (err) {
    await conn.query("ROLLBACK");
    throw err;
  } finally {
    conn.release();
  }
}

/** Gracefully close the pool. */
export async function closeErpPgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(erp): add Postgres client wrapper" mabos/erp/db/postgres.ts
```

---

### Task 4: Create TypeDB client wrapper

**Files:**

- Create: `mabos/erp/db/typedb.ts`

**Step 1: Write the TypeDB client**

```typescript
// mabos/erp/db/typedb.ts

/**
 * TypeDB client wrapper for the ERP knowledge graph.
 *
 * Provides session management, entity/relation insert helpers,
 * and TypeQL query execution.
 */

export interface TypeDBConfig {
  host: string;
  port: number;
  database: string;
}

export interface TypeDBClient {
  config: TypeDBConfig;
  query: (typeql: string) => Promise<unknown[]>;
  insertEntity: (type: string, attrs: Record<string, unknown>) => Promise<void>;
  insertRelation: (
    relationType: string,
    ...roles: Array<{ role: string; entityType: string; id: string }>
  ) => Promise<void>;
  deleteEntity: (type: string, keyAttr: string, keyValue: string) => Promise<void>;
  close: () => Promise<void>;
}

export function getTypeDBConfig(): TypeDBConfig {
  return {
    host: process.env.MABOS_TYPEDB_HOST ?? "localhost",
    port: parseInt(process.env.MABOS_TYPEDB_PORT ?? "1729", 10),
    database: process.env.MABOS_TYPEDB_DATABASE ?? "mabos_knowledge",
  };
}

/**
 * Create a TypeDB client.
 *
 * Uses the typedb-driver package. The actual driver import is deferred
 * so the module can load even when TypeDB is unavailable (graceful degradation).
 */
export async function createTypeDBClient(config?: TypeDBConfig): Promise<TypeDBClient> {
  const cfg = config ?? getTypeDBConfig();

  // Dynamic import for graceful degradation
  const { TypeDB } = await import("typedb-driver");
  const driver = await TypeDB.coreDriver(`${cfg.host}:${cfg.port}`);

  const client: TypeDBClient = {
    config: cfg,

    async query(typeql: string): Promise<unknown[]> {
      const session = await driver.session(cfg.database, "data");
      try {
        const tx = await session.transaction("read");
        try {
          const results: unknown[] = [];
          const stream = tx.query.get(typeql);
          for await (const row of stream) {
            results.push(row);
          }
          return results;
        } finally {
          await tx.close();
        }
      } finally {
        await session.close();
      }
    },

    async insertEntity(type: string, attrs: Record<string, unknown>): Promise<void> {
      const attrClauses = Object.entries(attrs)
        .map(([k, v]) => {
          const val = typeof v === "string" ? `"${v}"` : v;
          return `has ${k} ${val}`;
        })
        .join(", ");

      const typeql = `insert $e isa ${type}, ${attrClauses};`;

      const session = await driver.session(cfg.database, "data");
      try {
        const tx = await session.transaction("write");
        try {
          await tx.query.insert(typeql);
          await tx.commit();
        } catch (err) {
          await tx.close();
          throw err;
        }
      } finally {
        await session.close();
      }
    },

    async insertRelation(
      relationType: string,
      ...roles: Array<{ role: string; entityType: string; id: string }>
    ): Promise<void> {
      const matchClauses = roles
        .map((r, i) => {
          const keyAttr = `${r.entityType}-id`;
          return `$r${i} isa ${r.entityType}, has ${keyAttr} "${r.id}"`;
        })
        .join("; ");

      const roleClauses = roles.map((r, i) => `${r.role}: $r${i}`).join(", ");

      const typeql = `match ${matchClauses}; insert (${roleClauses}) isa ${relationType};`;

      const session = await driver.session(cfg.database, "data");
      try {
        const tx = await session.transaction("write");
        try {
          await tx.query.insert(typeql);
          await tx.commit();
        } catch (err) {
          await tx.close();
          throw err;
        }
      } finally {
        await session.close();
      }
    },

    async deleteEntity(type: string, keyAttr: string, keyValue: string): Promise<void> {
      const typeql = `match $e isa ${type}, has ${keyAttr} "${keyValue}"; delete $e isa ${type};`;

      const session = await driver.session(cfg.database, "data");
      try {
        const tx = await session.transaction("write");
        try {
          await tx.query.delete(typeql);
          await tx.commit();
        } catch (err) {
          await tx.close();
          throw err;
        }
      } finally {
        await session.close();
      }
    },

    async close(): Promise<void> {
      await driver.close();
    },
  };

  return client;
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(erp): add TypeDB client wrapper" mabos/erp/db/typedb.ts
```

---

### Task 5: Create audit log writer

**Files:**

- Create: `mabos/erp/shared/audit.ts`

**Step 1: Write the audit module**

```typescript
// mabos/erp/shared/audit.ts

import { query } from "../db/postgres.js";
import type { PgClient } from "../db/postgres.js";

export async function writeAuditLog(
  pg: PgClient,
  entry: {
    domain: string;
    entityType: string;
    entityId: string;
    action: string;
    agentId: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await query(
    pg,
    `INSERT INTO erp.audit_log (domain, entity_type, entity_id, action, agent_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.domain,
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.agentId,
      JSON.stringify(entry.payload ?? {}),
    ],
  );
}

export async function queryAuditLog(
  pg: PgClient,
  filters: {
    domain?: string;
    entityType?: string;
    entityId?: string;
    agentId?: string;
    limit?: number;
  },
): Promise<unknown[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.domain) {
    conditions.push(`domain = $${idx++}`);
    values.push(filters.domain);
  }
  if (filters.entityType) {
    conditions.push(`entity_type = $${idx++}`);
    values.push(filters.entityType);
  }
  if (filters.entityId) {
    conditions.push(`entity_id = $${idx++}`);
    values.push(filters.entityId);
  }
  if (filters.agentId) {
    conditions.push(`agent_id = $${idx++}`);
    values.push(filters.agentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 100;

  return query(pg, `SELECT * FROM erp.audit_log ${where} ORDER BY created_at DESC LIMIT $${idx}`, [
    ...values,
    limit,
  ]);
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(erp): add audit log writer" mabos/erp/shared/audit.ts
```

---

## Phase 2: Schema (Postgres Migrations + TypeDB Schema)

### Task 6: Create Postgres migrations

**Files:**

- Create: `mabos/erp/db/migrations/001_create_erp_schema.sql`
- Create: `mabos/erp/db/migrations/002_finance_tables.sql`
- Create: `mabos/erp/db/migrations/003_ecommerce_tables.sql`
- Create: `mabos/erp/db/migrations/004_customers_tables.sql`
- Create: `mabos/erp/db/migrations/005_projects_tables.sql`
- Create: `mabos/erp/db/migrations/006_marketing_tables.sql`
- Create: `mabos/erp/db/migrations/007_hr_tables.sql`
- Create: `mabos/erp/db/migrations/008_inventory_tables.sql`
- Create: `mabos/erp/db/migrations/009_suppliers_tables.sql`
- Create: `mabos/erp/db/migrations/010_supply_chain_tables.sql`
- Create: `mabos/erp/db/migrations/011_legal_tables.sql`
- Create: `mabos/erp/db/migrations/012_compliance_tables.sql`
- Create: `mabos/erp/db/migrations/013_analytics_tables.sql`
- Create: `mabos/erp/db/migrations/014_workflows_tables.sql`
- Create: `mabos/erp/db/migrations/015_indexes_and_triggers.sql`

Write each SQL file as specified in the design doc (Section 2: Data Layer Design — Postgres Schema). Each migration is idempotent with `CREATE TABLE IF NOT EXISTS`.

Migration 001 creates the schema and audit log. Migrations 002–014 create domain tables. Migration 015 adds indexes on foreign keys, `status` columns, `created_at`, and a trigger for `updated_at`.

**Step 1: Write all 15 migration files**

(Full SQL per the design doc Postgres schema section.)

**Step 2: Commit**

```bash
scripts/committer "feat(erp): add Postgres migration files" mabos/erp/db/migrations/001_create_erp_schema.sql mabos/erp/db/migrations/002_finance_tables.sql mabos/erp/db/migrations/003_ecommerce_tables.sql mabos/erp/db/migrations/004_customers_tables.sql mabos/erp/db/migrations/005_projects_tables.sql mabos/erp/db/migrations/006_marketing_tables.sql mabos/erp/db/migrations/007_hr_tables.sql mabos/erp/db/migrations/008_inventory_tables.sql mabos/erp/db/migrations/009_suppliers_tables.sql mabos/erp/db/migrations/010_supply_chain_tables.sql mabos/erp/db/migrations/011_legal_tables.sql mabos/erp/db/migrations/012_compliance_tables.sql mabos/erp/db/migrations/013_analytics_tables.sql mabos/erp/db/migrations/014_workflows_tables.sql mabos/erp/db/migrations/015_indexes_and_triggers.sql
```

---

### Task 7: Create TypeDB schema

**Files:**

- Create: `mabos/erp/db/schema/erp-knowledge-graph.tql`

Write the full TypeDB schema as specified in the design doc (Section 2: TypeDB Schema).

**Step 1: Write the .tql file**

(Full TQL per the design doc TypeDB schema section.)

**Step 2: Commit**

```bash
scripts/committer "feat(erp): add TypeDB knowledge graph schema" mabos/erp/db/schema/erp-knowledge-graph.tql
```

---

### Task 8: Create migration runner script

**Files:**

- Create: `mabos/erp/db/run-migrations.ts`

**Step 1: Write the migration runner**

```typescript
// mabos/erp/db/run-migrations.ts

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getErpPgPool, query, closeErpPgPool } from "./postgres.js";

async function runMigrations(): Promise<void> {
  const pg = getErpPgPool();

  // Ensure migrations tracking table exists
  await query(
    pg,
    `
    CREATE TABLE IF NOT EXISTS erp_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `,
  );

  // Read applied migrations
  const applied = new Set(
    (await query<{ filename: string }>(pg, "SELECT filename FROM erp_migrations ORDER BY id")).map(
      (r) => r.filename,
    ),
  );

  // Read migration files
  const migrationsDir = join(import.meta.dirname ?? ".", "migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), "utf-8");
    console.log(`Applying: ${file}`);

    await query(pg, sql);
    await query(pg, "INSERT INTO erp_migrations (filename) VALUES ($1)", [file]);
    count++;
  }

  console.log(count > 0 ? `Applied ${count} migrations.` : "No pending migrations.");
  await closeErpPgPool();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

**Step 2: Commit**

```bash
scripts/committer "feat(erp): add migration runner" mabos/erp/db/run-migrations.ts
```

---

## Phase 3: Tool Factory

### Task 9: Create the domain-action tool factory

**Files:**

- Create: `mabos/erp/shared/tool-factory.ts`
- Create: `mabos/erp/shared/tool-factory.test.ts`

**Step 1: Write the failing test**

```typescript
// mabos/erp/shared/tool-factory.test.ts

import { describe, it, expect, vi } from "vitest";
import { createErpDomainTool } from "./tool-factory.js";
import type { ErpDomainDef } from "./tool-factory.js";

describe("createErpDomainTool", () => {
  it("creates a tool with the correct name", () => {
    const def: ErpDomainDef = {
      domain: "finance",
      description: "Financial operations",
      actions: [
        {
          name: "create_invoice",
          description: "Create invoice",
          params: {},
          handler: vi.fn().mockResolvedValue({ success: true }),
        },
      ],
    };
    const tool = createErpDomainTool(def);
    expect(tool.name).toBe("erp_finance");
  });

  it("routes to the correct action handler", async () => {
    const handler = vi.fn().mockResolvedValue({ id: "123" });
    const def: ErpDomainDef = {
      domain: "test",
      description: "Test domain",
      actions: [{ name: "create", description: "Create", params: {}, handler }],
    };
    const tool = createErpDomainTool(def);
    const ctx = {
      agentId: "a1",
      agentDir: "/tmp",
      pg: {},
      typedb: {},
      syncEngine: null,
      logger: { info: vi.fn(), warn: vi.fn() },
    } as any;

    const result = await tool.execute({ action: "create", params: { name: "test" } }, ctx);
    expect(handler).toHaveBeenCalledWith({ name: "test" }, ctx);
    expect(result).toEqual({ id: "123" });
  });

  it("returns error for unknown action", async () => {
    const def: ErpDomainDef = {
      domain: "test",
      description: "Test domain",
      actions: [],
    };
    const tool = createErpDomainTool(def);
    const ctx = {} as any;

    const result = await tool.execute({ action: "nope", params: {} }, ctx);
    expect(result).toHaveProperty("error");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run mabos/erp/shared/tool-factory.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write the tool factory** (full code per design doc Section 3).

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run mabos/erp/shared/tool-factory.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
scripts/committer "feat(erp): add domain-action tool factory" mabos/erp/shared/tool-factory.ts mabos/erp/shared/tool-factory.test.ts
```

---

## Phase 4: Sync Engine

### Task 10: Create the BDI two-way sync engine

**Files:**

- Create: `mabos/erp/shared/bdi-sync.ts`
- Create: `mabos/erp/shared/bdi-sync.test.ts`

**Step 1: Write failing tests**

```typescript
// mabos/erp/shared/bdi-sync.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BdiSyncEngine } from "./bdi-sync.js";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return actual;
});

describe("BdiSyncEngine", () => {
  let tempDir: string;
  let mockPg: any;
  let engine: BdiSyncEngine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bdi-sync-test-"));
    mockPg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    engine = new BdiSyncEngine(mockPg, { info: vi.fn(), warn: vi.fn() });
  });

  describe("syncErpToBdi", () => {
    it("appends a desire when a project is created", async () => {
      await engine.syncErpToBdi({
        agentDir: tempDir,
        agentId: "agent-1",
        domain: "projects",
        entityType: "project",
        trigger: "create",
        record: {
          id: "proj-1",
          name: "Q1 Campaign",
          priority: 0.8,
          budget: 50000,
          start_date: "2026-03-01",
          end_date: "2026-06-01",
          status: "active",
        },
      });

      const desires = await readFile(join(tempDir, "Desires.md"), "utf-8");
      expect(desires).toContain("Q1 Campaign");
      expect(desires).toContain("[erp:projects:proj-1]");
      expect(desires).toContain("priority: 0.8");
    });

    it("deduplicates on re-sync of same entity", async () => {
      const record = {
        id: "proj-1",
        name: "Q1 Campaign",
        priority: 0.8,
        budget: 50000,
        start_date: "2026-03-01",
        end_date: "2026-06-01",
        status: "active",
      };
      await engine.syncErpToBdi({
        agentDir: tempDir,
        agentId: "agent-1",
        domain: "projects",
        entityType: "project",
        trigger: "create",
        record,
      });
      await engine.syncErpToBdi({
        agentDir: tempDir,
        agentId: "agent-1",
        domain: "projects",
        entityType: "project",
        trigger: "create",
        record: { ...record, status: "in_progress" },
      });

      const desires = await readFile(join(tempDir, "Desires.md"), "utf-8");
      const matches = desires.match(/\[erp:projects:proj-1\]/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe("syncBdiToErp", () => {
    it("pushes update when intention status changes", async () => {
      const prev = {
        intentions: "## Task A [erp:projects:task-1]\n- status: active\n",
        desires: "",
        goals: "",
      };
      const curr = {
        intentions: "## Task A [erp:projects:task-1]\n- status: stalled\n",
        desires: "",
        goals: "",
      };

      const updates = await engine.syncBdiToErp({
        agentDir: tempDir,
        agentId: "agent-1",
        previousState: prev,
        currentState: curr,
      });
      expect(updates).toBe(1);
      expect(mockPg.query).toHaveBeenCalled();
    });

    it("returns 0 when no status changes", async () => {
      const state = {
        intentions: "## Task A [erp:projects:task-1]\n- status: active\n",
        desires: "",
        goals: "",
      };
      const updates = await engine.syncBdiToErp({
        agentDir: tempDir,
        agentId: "agent-1",
        previousState: state,
        currentState: state,
      });
      expect(updates).toBe(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run mabos/erp/shared/bdi-sync.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write the sync engine** (full code per design doc Section 5).

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run mabos/erp/shared/bdi-sync.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
scripts/committer "feat(erp): add BDI two-way sync engine" mabos/erp/shared/bdi-sync.ts mabos/erp/shared/bdi-sync.test.ts
```

---

## Phase 5: Domain Modules (13 domains)

For each domain, follow this pattern. The plan shows customers and finance in full as templates — remaining 11 domains follow the same structure.

### Task 11: Customers domain (Tier 1)

**Files:**

- Create: `mabos/erp/customers/entities.ts`
- Create: `mabos/erp/customers/queries.ts`
- Create: `mabos/erp/customers/tools.ts`
- Create: `mabos/erp/customers/queries.test.ts`

**Step 1: Write entities**

```typescript
// mabos/erp/customers/entities.ts

import type { BaseEntity } from "../shared/types.js";

export interface Contact extends BaseEntity {
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  segment: string | null;
  lifecycleStage: string;
  metadata: Record<string, unknown>;
}

export interface Interaction extends BaseEntity {
  contactId: string;
  channel: string;
  type: string;
  summary: string;
  sentiment: number | null;
  agentId: string | null;
}
```

**Step 2: Write failing query tests**

```typescript
// mabos/erp/customers/queries.test.ts

import { describe, it, expect, vi } from "vitest";
import {
  createContact,
  getContact,
  listContacts,
  searchContacts,
  logInteraction,
} from "./queries.js";

const mockPg = {
  query: vi.fn(),
};

describe("customers queries", () => {
  it("createContact inserts and returns contact", async () => {
    const contact = { id: "c1", name: "Alice", email: "a@b.com", created_at: "2026-01-01" };
    mockPg.query.mockResolvedValueOnce({ rows: [contact] });

    const result = await createContact(mockPg as any, { name: "Alice", email: "a@b.com" });
    expect(result).toEqual(contact);
    expect(mockPg.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO erp.contacts"),
      expect.any(Array),
    );
  });
});
```

**Step 3: Run test to verify it fails**

```bash
pnpm vitest run mabos/erp/customers/queries.test.ts
```

**Step 4: Write queries**

```typescript
// mabos/erp/customers/queries.ts

import type { PgClient } from "../db/postgres.js";

export async function createContact(
  pg: PgClient,
  params: {
    name: string;
    email?: string;
    phone?: string;
    company?: string;
    segment?: string;
    lifecycle_stage?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.contacts (id, name, email, phone, company, segment, lifecycle_stage, metadata)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.name,
      params.email ?? null,
      params.phone ?? null,
      params.company ?? null,
      params.segment ?? null,
      params.lifecycle_stage ?? "lead",
      JSON.stringify(params.metadata ?? {}),
    ],
  );
  return result.rows[0];
}

export async function getContact(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.contacts WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listContacts(
  pg: PgClient,
  params: { segment?: string; lifecycle_stage?: string; limit?: number; offset?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.segment) {
    conditions.push(`segment = $${idx++}`);
    values.push(params.segment);
  }
  if (params.lifecycle_stage) {
    conditions.push(`lifecycle_stage = $${idx++}`);
    values.push(params.lifecycle_stage);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const result = await pg.query(
    `SELECT * FROM erp.contacts ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    [...values, limit, offset],
  );
  return result.rows;
}

export async function searchContacts(pg: PgClient, query: string, limit?: number) {
  const result = await pg.query(
    "SELECT * FROM erp.contacts WHERE name ILIKE $1 OR email ILIKE $1 OR company ILIKE $1 ORDER BY created_at DESC LIMIT $2",
    [`%${query}%`, limit ?? 50],
  );
  return result.rows;
}

export async function logInteraction(
  pg: PgClient,
  params: {
    contact_id: string;
    channel: string;
    type: string;
    summary: string;
    sentiment?: number;
    agent_id?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.interactions (id, contact_id, channel, type, summary, sentiment, agent_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.contact_id,
      params.channel,
      params.type,
      params.summary,
      params.sentiment ?? null,
      params.agent_id ?? null,
    ],
  );
  return result.rows[0];
}

export async function updateContact(pg: PgClient, id: string, params: Record<string, unknown>) {
  const setClauses = Object.keys(params)
    .map((k, i) => `${k} = $${i + 2}`)
    .join(", ");
  const result = await pg.query(`UPDATE erp.contacts SET ${setClauses} WHERE id = $1 RETURNING *`, [
    id,
    ...Object.values(params),
  ]);
  return result.rows[0] ?? null;
}

export async function deleteContact(pg: PgClient, id: string) {
  const result = await pg.query(
    "UPDATE erp.contacts SET lifecycle_stage = $2 WHERE id = $1 RETURNING *",
    [id, "archived"],
  );
  return result.rows[0] ?? null;
}
```

**Step 5: Write tools**

```typescript
// mabos/erp/customers/tools.ts

import { createErpDomainTool } from "../shared/tool-factory.js";
import * as q from "./queries.js";
import { writeAuditLog } from "../shared/audit.js";

export const customersTool = createErpDomainTool({
  domain: "customers",
  description: "CRM — contacts, accounts, segments, interactions, lifecycle management",
  actions: [
    {
      name: "create",
      description: "Create a new contact",
      params: {},
      handler: async (params, ctx) => {
        const contact = await q.createContact(ctx.pg, params as any);
        await writeAuditLog(ctx.pg, {
          domain: "customers",
          entityType: "contact",
          entityId: contact.id,
          action: "create",
          agentId: ctx.agentId,
          payload: params as any,
        });
        await ctx.syncEngine?.syncErpToBdi({
          agentDir: ctx.agentDir,
          agentId: ctx.agentId,
          domain: "customers",
          entityType: "contact",
          trigger: "create",
          record: contact,
        });
        return { success: true, data: contact };
      },
    },
    {
      name: "get",
      description: "Get contact by ID",
      params: {},
      handler: async (params, ctx) => {
        const contact = await q.getContact(ctx.pg, (params as any).id);
        return contact ? { success: true, data: contact } : { error: "Contact not found" };
      },
    },
    {
      name: "list",
      description: "List contacts with filters",
      params: {},
      handler: async (params, ctx) => {
        const contacts = await q.listContacts(ctx.pg, params as any);
        return { success: true, data: contacts };
      },
    },
    {
      name: "search",
      description: "Search contacts by name/email/company",
      params: {},
      handler: async (params, ctx) => {
        const contacts = await q.searchContacts(
          ctx.pg,
          (params as any).query,
          (params as any).limit,
        );
        return { success: true, data: contacts };
      },
    },
    {
      name: "update",
      description: "Update contact fields",
      params: {},
      handler: async (params, ctx) => {
        const { id, ...fields } = params as any;
        const contact = await q.updateContact(ctx.pg, id, fields);
        if (!contact) return { error: "Contact not found" };
        await writeAuditLog(ctx.pg, {
          domain: "customers",
          entityType: "contact",
          entityId: id,
          action: "update",
          agentId: ctx.agentId,
          payload: fields,
        });
        return { success: true, data: contact };
      },
    },
    {
      name: "delete",
      description: "Archive a contact (soft delete)",
      params: {},
      handler: async (params, ctx) => {
        const contact = await q.deleteContact(ctx.pg, (params as any).id);
        if (!contact) return { error: "Contact not found" };
        await writeAuditLog(ctx.pg, {
          domain: "customers",
          entityType: "contact",
          entityId: (params as any).id,
          action: "archive",
          agentId: ctx.agentId,
        });
        return { success: true, data: contact };
      },
    },
    {
      name: "log_interaction",
      description: "Log a customer interaction",
      params: {},
      handler: async (params, ctx) => {
        const interaction = await q.logInteraction(ctx.pg, params as any);
        await writeAuditLog(ctx.pg, {
          domain: "customers",
          entityType: "interaction",
          entityId: interaction.id,
          action: "create",
          agentId: ctx.agentId,
          payload: params as any,
        });
        return { success: true, data: interaction };
      },
    },
  ],
});
```

**Step 6: Run tests**

```bash
pnpm vitest run mabos/erp/customers/
```

**Step 7: Commit**

```bash
scripts/committer "feat(erp): add customers domain (entities, queries, tools)" mabos/erp/customers/entities.ts mabos/erp/customers/queries.ts mabos/erp/customers/tools.ts mabos/erp/customers/queries.test.ts
```

---

### Task 12: Finance domain (Tier 1)

Same pattern as Task 11. Entities: Account, Invoice, Payment, LedgerEntry. Queries include `createInvoice`, `recordPayment`, `postLedgerEntry`, `getAccountBalance`, `profitLoss`. Tools include all standard actions plus `record_payment`, `get_balance`, `profit_loss`, `post_ledger_entry`.

**Files:** `mabos/erp/finance/entities.ts`, `queries.ts`, `tools.ts`, `queries.test.ts`

**Commit:** `scripts/committer "feat(erp): add finance domain" mabos/erp/finance/...`

### Task 13: HR domain (Tier 1)

Entities: Employee, PayrollRecord. Queries: CRUD + `runPayroll`. Tools: standard + `run_payroll`, `onboard_employee`.

### Task 14: Ecommerce domain (Tier 2)

Entities: Product, Order, Cart, Return. Queries: CRUD + `trackShipment`. Tools: standard + `create_order`, `track_shipment`.

### Task 15: Suppliers domain (Tier 2)

Entities: Supplier, SupplierContract, Rating. Queries: CRUD + `evaluateSupplier`, `createPo`. Tools: standard + `evaluate_supplier`, `create_po`, `rate_supplier`.

### Task 16: Legal domain (Tier 2)

Entities: Contract, Approval, IPRecord, Document. Queries: CRUD + `requestApproval`, `checkExpiry`. Tools: standard + `draft_contract`, `request_approval`, `check_expiry`.

### Task 17: Compliance domain (Tier 2)

Entities: ComplianceRule, Audit, Violation, Policy, Certification. Queries: CRUD + `runAudit`, `checkViolation`. Tools: standard + `run_audit`, `check_violation`, `certify`, `check_transaction`, `check_vendor`.

### Task 18: Inventory domain (Tier 3)

Entities: Warehouse, StockItem, ProcurementOrder. Queries: CRUD + `checkStock`, `reorder`, `transferStock`, `receive`, `reserve`. Tools: standard + domain-specific.

### Task 19: Supply Chain domain (Tier 3)

Entities: SupplyNode, Route, Shipment, Forecast. Queries: CRUD + `traceRoute`, `forecastDemand`, `optimizeRoute`. Tools: standard + domain-specific.

### Task 20: Projects domain (Tier 3)

Entities: Project, Task, Milestone, Resource. Queries: CRUD + `assignTask`, `updateMilestone`, `getProjectStatus`. Tools: standard + `assign_task`, `update_milestone`, `get_project_status`. Full BDI sync integration (projects → Desires, tasks/milestones → Intentions).

### Task 21: Marketing domain (Tier 3)

Entities: Campaign, Channel, Content, Funnel, ABTest. Queries: CRUD + `launchCampaign`, `createFunnel`, `measureRoi`. Tools: standard + domain-specific. BDI sync (campaigns → Desires).

### Task 22: Analytics domain (Tier 4)

Entities: Report, Dashboard, KPI, Forecast. Queries: `queryKpi`, `generateReport`, `forecast`, `createKpi`. Tools: standard + domain-specific. BDI sync (KPI updates → Beliefs).

### Task 23: Workflows domain (Tier 4)

Entities: Workflow, Step, Trigger, ApprovalChain, WorkflowRun. Queries: CRUD + `triggerWorkflow`, `checkStatus`, `getSyncLog`. Tools: standard + `create_workflow`, `trigger`, `check_status`, `get_sync_log`.

**Each domain task follows the same steps:** entities → failing query test → queries → tools → run tests → commit.

---

## Phase 6: Registration & Heartbeat Integration

### Task 24: Create ERP index (register all tools)

**Files:**

- Create: `mabos/erp/index.ts`

**Step 1: Write the registration module**

```typescript
// mabos/erp/index.ts

import { customersTool } from "./customers/tools.js";
import { financeTool } from "./finance/tools.js";
import { hrTool } from "./hr/tools.js";
import { ecommerceTool } from "./ecommerce/tools.js";
import { suppliersTool } from "./suppliers/tools.js";
import { legalTool } from "./legal/tools.js";
import { complianceTool } from "./compliance/tools.js";
import { inventoryTool } from "./inventory/tools.js";
import { supplyChainTool } from "./supply-chain/tools.js";
import { projectsTool } from "./projects/tools.js";
import { marketingTool } from "./marketing/tools.js";
import { analyticsTool } from "./analytics/tools.js";
import { workflowsTool } from "./workflows/tools.js";
import { BdiSyncEngine } from "./shared/bdi-sync.js";
import type { PgClient } from "./db/postgres.js";

export const ALL_ERP_TOOLS = [
  customersTool,
  financeTool,
  hrTool,
  ecommerceTool,
  suppliersTool,
  legalTool,
  complianceTool,
  inventoryTool,
  supplyChainTool,
  projectsTool,
  marketingTool,
  analyticsTool,
  workflowsTool,
];

export function getErpToolsForRole(role: string) {
  const roleToolMap: Record<string, string[]> = {
    marketing: ["customers", "marketing", "projects", "analytics"],
    finance: ["finance", "compliance", "analytics"],
    operations: ["inventory", "suppliers", "supply_chain", "workflows"],
    legal: ["legal", "compliance"],
    hr: ["hr", "compliance"],
    executive: ALL_ERP_TOOLS.map((t) => t.name.replace("erp_", "")),
  };
  const allowed = roleToolMap[role] ?? roleToolMap.executive;
  return ALL_ERP_TOOLS.filter((t) => allowed.includes(t.name.replace("erp_", "")));
}

export function createErpSyncEngine(
  pg: PgClient,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
) {
  return new BdiSyncEngine(pg, logger);
}

export { BdiSyncEngine } from "./shared/bdi-sync.js";
```

**Step 2: Commit**

```bash
scripts/committer "feat(erp): add ERP tool registration index" mabos/erp/index.ts
```

---

### Task 25: Integrate BDI sync into heartbeat

**Files:**

- Modify: `mabos/bdi-runtime/index.ts`

Add the BDI→ERP sync call after `runMaintenanceCycle()` in the `createBdiService` tick function, capturing state before and after maintenance and calling `syncEngine.syncBdiToErp()`.

**Step 1: Modify bdi-runtime/index.ts** (per design doc Section 5 heartbeat integration).

**Step 2: Run existing tests**

```bash
pnpm vitest run mabos/
```

**Step 3: Commit**

```bash
scripts/committer "feat(erp): integrate BDI→ERP sync into heartbeat" mabos/bdi-runtime/index.ts
```

---

### Task 26: Update tsconfig.json

**Files:**

- Modify: `mabos/tsconfig.json`

Add all new TypeScript files to the `include` array.

**Step 1: Update includes**

Add `"erp/**/*.ts"` to the include array (and exclude test files from compilation).

**Step 2: Run type-check**

```bash
pnpm build:mabos
```

Expected: PASS

**Step 3: Commit**

```bash
scripts/committer "chore(erp): update mabos tsconfig for ERP modules" mabos/tsconfig.json
```

---

## Phase 7: Agent Skills

### Task 27: Write all ERP agent skills

**Files:**

- Create: `skills/erp/erp-overview.md`
- Create: `skills/erp/bdi-sync.md`
- Create: `skills/erp/ecommerce.md`
- Create: `skills/erp/customers.md`
- Create: `skills/erp/finance.md`
- Create: `skills/erp/legal.md`
- Create: `skills/erp/projects.md`
- Create: `skills/erp/marketing.md`
- Create: `skills/erp/hr.md`
- Create: `skills/erp/inventory.md`
- Create: `skills/erp/suppliers.md`
- Create: `skills/erp/supply-chain.md`
- Create: `skills/erp/compliance.md`
- Create: `skills/erp/analytics.md`
- Create: `skills/erp/workflows.md`

Write each skill file per the design doc Section 4 (Agent Skills). Each skill has YAML frontmatter (name, description) and documents available actions, example JSON invocations, patterns, cross-domain workflows, and BDI sync behavior.

**Step 1: Write all 15 skill files**

**Step 2: Commit**

```bash
scripts/committer "feat(erp): add agent skills for all ERP domains" skills/erp/erp-overview.md skills/erp/bdi-sync.md skills/erp/ecommerce.md skills/erp/customers.md skills/erp/finance.md skills/erp/legal.md skills/erp/projects.md skills/erp/marketing.md skills/erp/hr.md skills/erp/inventory.md skills/erp/suppliers.md skills/erp/supply-chain.md skills/erp/compliance.md skills/erp/analytics.md skills/erp/workflows.md
```

---

## Phase 8: Testing

### Task 28: Add integration tests for sync engine

**Files:**

- Create: `mabos/erp/shared/bdi-sync.integration.test.ts`

Test full round-trip: create project via tool → verify Desires.md updated → simulate heartbeat stall → verify Postgres status updated.

### Task 29: Add smoke test for all domain tools

**Files:**

- Create: `mabos/erp/erp-smoke.test.ts`

Verify all 13 tools register, have correct names, expose expected standard actions, and return errors for unknown actions.

**Step 1: Write smoke test**

```typescript
// mabos/erp/erp-smoke.test.ts

import { describe, it, expect } from "vitest";
import { ALL_ERP_TOOLS, getErpToolsForRole } from "./index.js";

describe("ERP tool registration", () => {
  it("registers all 13 domain tools", () => {
    expect(ALL_ERP_TOOLS).toHaveLength(13);
  });

  it("all tools have erp_ prefix", () => {
    for (const tool of ALL_ERP_TOOLS) {
      expect(tool.name).toMatch(/^erp_/);
    }
  });

  it("role-based filtering returns correct tools", () => {
    const financeTools = getErpToolsForRole("finance");
    expect(financeTools.map((t) => t.name)).toContain("erp_finance");
    expect(financeTools.map((t) => t.name)).not.toContain("erp_marketing");
  });

  it("executive role gets all tools", () => {
    const execTools = getErpToolsForRole("executive");
    expect(execTools).toHaveLength(13);
  });
});
```

**Step 2: Run all tests**

```bash
pnpm vitest run mabos/erp/
```

**Step 3: Commit**

```bash
scripts/committer "test(erp): add smoke and integration tests" mabos/erp/erp-smoke.test.ts mabos/erp/shared/bdi-sync.integration.test.ts
```

---

## Final Checklist

- [ ] All 15 Postgres migrations applied
- [ ] TypeDB schema loaded
- [ ] `pnpm build:mabos` passes
- [ ] `pnpm vitest run mabos/erp/` all green
- [ ] All 13 domain tools register in `erp/index.ts`
- [ ] BDI sync fires on ERP mutations (ERP→BDI)
- [ ] BDI heartbeat pushes status changes back (BDI→ERP)
- [ ] All 15 skills present in `skills/erp/`
- [ ] Role-based tool access works
