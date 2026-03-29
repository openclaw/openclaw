import { describe, expect, it } from "vitest";
import { DatabricksAllowlistError, DatabricksPolicyError } from "./errors.js";
import { assertAllowlistTarget, assertReadOnlySqlStatement } from "./security-policy.js";

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

  it("rejects insert keyword even when prefixed by with", () => {
    expect(() =>
      assertReadOnlySqlStatement("WITH x AS (SELECT 1) INSERT INTO t VALUES (1)"),
    ).toThrow("disallowed keyword: INSERT");
  });

  it("accepts sql with comments and unusual whitespace", () => {
    const sql = assertReadOnlySqlStatement(
      "  /* lead */\nWITH t AS (\n  SELECT 1 AS id -- row\n)\nSELECT\t*\nFROM t  ; ",
    );
    expect(sql).toContain("WITH t AS");
  });

  it("ignores mutating keywords inside string literals", () => {
    const sql = assertReadOnlySqlStatement("SELECT 'drop table users' AS note");
    expect(sql).toBe("SELECT 'drop table users' AS note");
  });

  it("rejects multiple statements with comments", () => {
    expect(() => assertReadOnlySqlStatement("SELECT 1; -- comment\nSELECT 2")).toThrow(
      "single SQL statement",
    );
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
      }),
    ).not.toThrow();
  });

  it("fails closed when catalog is required but missing", () => {
    expect(() =>
      assertAllowlistTarget({
        allowedCatalogs: ["main"],
        allowedSchemas: [],
        targets: [],
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
      }),
    ).toThrow('Schema "private" is not in the configured allowlist');
  });

  it("rejects schema.table target when catalog allowlist is configured", () => {
    expect(() =>
      assertAllowlistTarget({
        allowedCatalogs: ["main"],
        allowedSchemas: [],
        targets: [
          {
            schema: "public",
            table: "events",
            raw: "public.events",
          },
        ],
      }),
    ).toThrow("has no explicit catalog");
  });
});
