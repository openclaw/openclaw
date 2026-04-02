import { describe, expect, it } from "vitest";
import { resolveSqlTargets } from "./sql-target-resolution.js";

describe("sql target resolution", () => {
  it("resolves catalog.schema.table references", () => {
    expect(resolveSqlTargets("select * from main.sales.orders")).toEqual({
      ambiguous: false,
      targets: [
        {
          catalog: "main",
          schema: "sales",
          table: "orders",
          raw: "main.sales.orders",
        },
      ],
    });
  });

  it("resolves schema.table references", () => {
    expect(resolveSqlTargets("select * from sales.orders")).toEqual({
      ambiguous: false,
      targets: [
        {
          schema: "sales",
          table: "orders",
          raw: "sales.orders",
        },
      ],
    });
  });

  it("deduplicates targets across joins", () => {
    expect(
      resolveSqlTargets(
        "select * from sales.orders o join core.customers c on o.id = c.id join sales.orders o2 on o2.id = c.id",
      ),
    ).toEqual({
      ambiguous: false,
      targets: [
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
      ],
    });
  });

  it("resolves physical targets from WITH and ignores cte aliases", () => {
    expect(resolveSqlTargets("with c as (select * from sales.orders) select * from c")).toEqual({
      ambiguous: false,
      targets: [
        {
          schema: "sales",
          table: "orders",
          raw: "sales.orders",
        },
      ],
    });
  });

  it("marks single-part table references as ambiguous", () => {
    expect(resolveSqlTargets("select * from orders")).toEqual({
      ambiguous: true,
      targets: [],
    });
  });

  it("marks malformed quoted identifiers as ambiguous", () => {
    expect(resolveSqlTargets("select * from `main.sales.orders")).toEqual({
      ambiguous: true,
      targets: [],
    });
  });

  it("marks invalid cross join syntax as ambiguous", () => {
    expect(resolveSqlTargets("select * from sales.orders cross apply foo.bar")).toEqual({
      ambiguous: true,
      targets: [],
    });
  });

  it("marks multi-statement sql as ambiguous", () => {
    expect(resolveSqlTargets("select * from sales.orders; select * from core.customers")).toEqual({
      ambiguous: true,
      targets: [],
    });
  });
});
