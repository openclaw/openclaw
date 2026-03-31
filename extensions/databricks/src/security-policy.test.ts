import { describe, expect, it } from "vitest";
import { DatabricksPolicyError } from "./errors.js";
import { assertReadOnlySqlStatement } from "./security-policy.js";

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
});
