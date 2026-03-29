import { describe, expect, it } from "vitest";
import { resolveSqlTargets } from "./sql-target-resolution.js";

describe("sql target resolution", () => {
  it("resolves catalog.schema.table references", () => {
    expect(resolveSqlTargets("select * from main.sales.orders")).toEqual([
      {
        catalog: "main",
        schema: "sales",
        table: "orders",
        raw: "main.sales.orders",
      },
    ]);
  });

  it("resolves schema.table references", () => {
    expect(resolveSqlTargets("select * from sales.orders")).toEqual([
      {
        schema: "sales",
        table: "orders",
        raw: "sales.orders",
      },
    ]);
  });

  it("resolves quoted catalog.schema.table references", () => {
    expect(resolveSqlTargets("select * from `main`.`sales`.`orders`")).toEqual([
      {
        catalog: "main",
        schema: "sales",
        table: "orders",
        raw: "main.sales.orders",
      },
    ]);
  });

  it("resolves mixed quoted and bare identifiers when unambiguous", () => {
    expect(resolveSqlTargets("select * from `main`.sales.`orders`")).toEqual([
      {
        catalog: "main",
        schema: "sales",
        table: "orders",
        raw: "main.sales.orders",
      },
    ]);
  });

  it("deduplicates and resolves multiple join targets", () => {
    expect(
      resolveSqlTargets(
        "select * from sales.orders o join core.customers c on o.id = c.id join sales.orders o2 on o2.id = c.id",
      ),
    ).toEqual([
      {
        schema: "sales",
        table: "orders",
        raw: "sales.orders",
      },
      {
        schema: "core",
        table: "customers",
        raw: "core.customers",
      },
    ]);
  });

  it("extracts physical targets from WITH CTE and ignores cte aliases", () => {
    expect(resolveSqlTargets("with c as (select * from sales.orders) select * from c")).toEqual([
      {
        schema: "sales",
        table: "orders",
        raw: "sales.orders",
      },
    ]);
  });

  it("extracts quoted targets from WITH CTE", () => {
    expect(
      resolveSqlTargets("with c as (select * from `main`.`sales`.`orders`) select * from c"),
    ).toEqual([
      {
        catalog: "main",
        schema: "sales",
        table: "orders",
        raw: "main.sales.orders",
      },
    ]);
  });

  it("extracts targets from subquery in FROM", () => {
    expect(resolveSqlTargets("select * from (select * from sales.orders) x")).toEqual([
      {
        schema: "sales",
        table: "orders",
        raw: "sales.orders",
      },
    ]);
  });

  it("extracts targets across multiple CTEs", () => {
    expect(
      resolveSqlTargets(
        "with c as (select * from sales.orders), d as (select * from core.customers) select * from c join d on c.id = d.id",
      ),
    ).toEqual([
      {
        schema: "sales",
        table: "orders",
        raw: "sales.orders",
      },
      {
        schema: "core",
        table: "customers",
        raw: "core.customers",
      },
    ]);
  });

  it("returns empty when CTEs do not reference physical targets", () => {
    expect(resolveSqlTargets("with c as (select 1) select * from c")).toEqual([]);
  });

  it("returns empty when subquery does not reference physical targets", () => {
    expect(resolveSqlTargets("select * from (select 1) x")).toEqual([]);
  });

  it("returns empty for ambiguous single-part references", () => {
    expect(resolveSqlTargets("select * from foo")).toEqual([]);
  });

  it("fails closed on broken quoted identifiers", () => {
    expect(resolveSqlTargets("select * from `main.sales.orders")).toEqual([]);
  });

  it("fails closed on unbalanced parentheses", () => {
    expect(resolveSqlTargets("select * from (select * from sales.orders")).toEqual([]);
  });

  it("ignores fake from/join tokens inside strings and comments", () => {
    expect(
      resolveSqlTargets(
        "select 'from fake.schema.table' as note /* join bad.schema.table */ from sales.orders",
      ),
    ).toEqual([
      {
        schema: "sales",
        table: "orders",
        raw: "sales.orders",
      },
    ]);
  });

  it("returns empty for multi-statement sql", () => {
    expect(resolveSqlTargets("select * from sales.orders; select * from core.customers")).toEqual(
      [],
    );
  });
});
