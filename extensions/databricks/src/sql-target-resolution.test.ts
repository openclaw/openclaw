import { describe, expect, it } from "vitest";
import { resolveSqlTargets } from "./sql-target-resolution.js";

describe("sql target resolution", () => {
  it("resolves catalog.schema.table references", () => {
    const targets = resolveSqlTargets(
      "SELECT * FROM main.analytics.orders o JOIN main.analytics.customers c ON o.id = c.id",
    );
    expect(targets).toEqual([
      {
        catalog: "main",
        schema: "analytics",
        table: "orders",
        raw: "main.analytics.orders",
      },
      {
        catalog: "main",
        schema: "analytics",
        table: "customers",
        raw: "main.analytics.customers",
      },
    ]);
  });

  it("resolves schema.table references with odd whitespace", () => {
    const targets = resolveSqlTargets("SELECT * FROM analytics   .   events");
    expect(targets).toEqual([
      {
        schema: "analytics",
        table: "events",
        raw: "analytics.events",
      },
    ]);
  });

  it("handles CTEs and subqueries without breaking extraction", () => {
    const targets = resolveSqlTargets(
      "WITH x AS (SELECT * FROM main.sales.orders) SELECT * FROM x JOIN main.sales.customers c ON x.id = c.id",
    );
    expect(targets).toEqual([
      {
        catalog: "main",
        schema: "sales",
        table: "orders",
        raw: "main.sales.orders",
      },
      {
        catalog: "main",
        schema: "sales",
        table: "customers",
        raw: "main.sales.customers",
      },
    ]);
  });

  it("ignores strings and comments with fake table references", () => {
    const targets = resolveSqlTargets(
      "SELECT 'from x.y.z' AS note /* from bad.schema.table */ FROM main.prod.logs",
    );
    expect(targets).toEqual([
      {
        catalog: "main",
        schema: "prod",
        table: "logs",
        raw: "main.prod.logs",
      },
    ]);
  });

  it("fails closed naturally by returning empty when references are ambiguous", () => {
    const targets = resolveSqlTargets("SELECT * FROM orders");
    expect(targets).toEqual([]);
  });
});
