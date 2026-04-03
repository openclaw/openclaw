import { describe, expect, it } from "vitest";
import { DatabricksAllowlistError, DatabricksPolicyError } from "./errors.js";
import { assertAllowlistTarget, assertReadOnlySqlStatement } from "./security-policy.js";
import { resolveSqlTargets } from "./sql-target-resolution.js";

describe("databricks read-only sql policy", () => {
  it("accepts SELECT", () => {
    const sql = assertReadOnlySqlStatement("SELECT id, name FROM analytics.users;");
    expect(sql).toBe("SELECT id, name FROM analytics.users");
  });

  it("accepts WITH ... SELECT", () => {
    const sql = assertReadOnlySqlStatement(
      "WITH recent AS (SELECT * FROM events) SELECT * FROM recent",
    );
    expect(sql).toContain("WITH recent");
  });

  it("rejects mutating statement", () => {
    expect(() => assertReadOnlySqlStatement("SELECT * FROM users; DELETE FROM users")).toThrow(
      DatabricksPolicyError,
    );
  });

  it("rejects non-select statement", () => {
    expect(() => assertReadOnlySqlStatement("SHOW TABLES")).toThrow(
      "Read-only SQL must start with SELECT or WITH ... SELECT",
    );
  });

  it("accepts SELECT expression with immediate parenthesis", () => {
    expect(assertReadOnlySqlStatement("SELECT(1+1)")).toBe("SELECT(1+1)");
  });

  it("accepts SELECT(column) with FROM clause", () => {
    expect(assertReadOnlySqlStatement("SELECT(col) FROM main.sales.orders")).toBe(
      "SELECT(col) FROM main.sales.orders",
    );
  });

  it("rejects invalid SELECT-prefixed identifier", () => {
    expect(() => assertReadOnlySqlStatement("SELECTFOO FROM main.sales.orders")).toThrow(
      DatabricksPolicyError,
    );
  });

  it("ignores mutating keywords inside string literals", () => {
    const sql = assertReadOnlySqlStatement("SELECT 'drop table users' AS note");
    expect(sql).toBe("SELECT 'drop table users' AS note");
  });
});

describe("databricks allowlist policy", () => {
  it("accepts targets inside allowlist", () => {
    expect(() =>
      assertAllowlistTarget({
        allowedCatalogs: ["main"],
        allowedSchemas: ["public"],
        targets: [
          {
            catalog: "main",
            schema: "public",
            table: "orders",
            raw: "main.public.orders",
          },
        ],
        ambiguousTargets: false,
      }),
    ).not.toThrow();
  });

  it("fails closed when targets are ambiguous", () => {
    expect(() =>
      assertAllowlistTarget({
        allowedCatalogs: ["main"],
        allowedSchemas: [],
        targets: [],
        ambiguousTargets: true,
      }),
    ).toThrow(DatabricksAllowlistError);
  });

  it("rejects non-allowlisted schema", () => {
    expect(() =>
      assertAllowlistTarget({
        allowedCatalogs: [],
        allowedSchemas: ["public"],
        targets: [
          {
            schema: "private",
            table: "events",
            raw: "private.events",
          },
        ],
        ambiguousTargets: false,
      }),
    ).toThrow('Schema "private" is not in the configured allowlist');
  });

  it("accepts LEFT OUTER JOIN targets when allowlists match", () => {
    const resolution = resolveSqlTargets(
      "SELECT * FROM main.sales.orders LEFT OUTER JOIN main.sales.customers ON orders.id = customers.id",
    );
    expect(() =>
      assertAllowlistTarget({
        allowedCatalogs: ["main"],
        allowedSchemas: ["sales"],
        targets: resolution.targets,
        ambiguousTargets: resolution.ambiguous,
      }),
    ).not.toThrow();
  });

  it("accepts RIGHT OUTER JOIN targets when allowlists match", () => {
    const resolution = resolveSqlTargets(
      "SELECT * FROM main.sales.orders RIGHT OUTER JOIN main.sales.customers ON orders.id = customers.id",
    );
    expect(() =>
      assertAllowlistTarget({
        allowedCatalogs: ["main"],
        allowedSchemas: ["sales"],
        targets: resolution.targets,
        ambiguousTargets: resolution.ambiguous,
      }),
    ).not.toThrow();
  });

  it("accepts FULL OUTER JOIN targets when allowlists match", () => {
    const resolution = resolveSqlTargets(
      "SELECT * FROM main.sales.orders FULL OUTER JOIN main.sales.customers ON orders.id = customers.id",
    );
    expect(() =>
      assertAllowlistTarget({
        allowedCatalogs: ["main"],
        allowedSchemas: ["sales"],
        targets: resolution.targets,
        ambiguousTargets: resolution.ambiguous,
      }),
    ).not.toThrow();
  });
});
