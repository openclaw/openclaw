import { describe, expect, it } from "vitest";
import {
  buildAccountLinksQuery,
  buildCaseListQuery,
  buildCaseRowQuery,
  buildKpiQuery,
} from "./infringement-query-builder.js";

function placeholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

describe("buildCaseListQuery", () => {
  it("restricts to status=1 and secret=0 for non-superusers", () => {
    const { sql, values } = buildCaseListQuery({}, false);
    expect(sql).toContain("WHERE status = 1 AND secret = 0");
    expect(sql).toContain("ORDER BY updated_at DESC LIMIT ?");
    // only the limit placeholder
    expect(values).toEqual([20]);
  });

  it("drops the secret filter for superusers", () => {
    const { sql } = buildCaseListQuery({}, true);
    expect(sql).toContain("WHERE status = 1 ");
    expect(sql).not.toContain("secret = 0");
  });

  it("appends filters with matching placeholder values, in order", () => {
    const { sql, values } = buildCaseListQuery(
      {
        stage: "analyzing",
        acceptConclusion: "accept",
        archived: true,
        minScore: 6,
        keyword: "腾讯",
        limit: 5,
      },
      false,
    );
    expect(sql).toContain("stage = ?");
    expect(sql).toContain("accept_conclusion = ?");
    expect(sql).toContain("archived = ?");
    expect(sql).toContain("overall_score >= ?");
    expect(sql).toContain("(reporter LIKE ? OR target LIKE ? OR case_no LIKE ?)");
    expect(values).toEqual(["analyzing", "accept", 1, 6, "%腾讯%", "%腾讯%", "%腾讯%", 5]);
    expect(placeholders(sql)).toBe(values.length);
  });

  it("converts dates to Asia/Shanghai unix-second bounds (end is exclusive next-day)", () => {
    const { values } = buildCaseListQuery(
      { startDate: "2026-06-07", endDate: "2026-06-07" },
      false,
    );
    const start = Math.floor(Date.parse("2026-06-07T00:00:00+08:00") / 1000);
    expect(values[0]).toBe(start);
    expect(values[1]).toBe(start + 86400);
  });

  it("clamps the limit to [1, 50]", () => {
    expect(buildCaseListQuery({ limit: 999 }, false).values.at(-1)).toBe(50);
    expect(buildCaseListQuery({ limit: 0 }, false).values.at(-1)).toBe(1);
  });

  it("rejects an invalid stage", () => {
    expect(() => buildCaseListQuery({ stage: "bogus" as never }, false)).toThrow(RangeError);
  });
});

describe("buildCaseRowQuery", () => {
  it("selects phone and email (for downstream masking) and binds caseId", () => {
    const { sql, values } = buildCaseRowQuery(42, false);
    expect(sql).toContain("phone");
    expect(sql).toContain("email");
    expect(sql).toContain("AND id = ? LIMIT 1");
    expect(values).toEqual([42]);
  });
});

describe("buildAccountLinksQuery", () => {
  it("filters by account only when platform is omitted", () => {
    const { sql, values } = buildAccountLinksQuery("某账号", undefined);
    expect(sql).toContain("WHERE account = ? AND status = 1");
    expect(sql).not.toContain("platform = ?");
    expect(values).toEqual(["某账号"]);
  });

  it("adds a platform filter when provided", () => {
    const { sql, values } = buildAccountLinksQuery("某账号", "微博");
    expect(sql).toContain("platform = ?");
    expect(values).toEqual(["某账号", "微博"]);
  });
});

describe("buildKpiQuery", () => {
  it("builds distinct WHERE clauses per bucket", () => {
    expect(buildKpiQuery("pending", false).sql).toContain(
      "handler = '' AND stage IN ('draft','accepted')",
    );
    expect(buildKpiQuery("processing", false).sql).toContain(
      "archived = 0 AND stage IN ('analyzing','analyzed')",
    );
    expect(buildKpiQuery("done", false).sql).toContain("archived = 1");
  });

  it("honors the secret gate", () => {
    expect(buildKpiQuery("done", false).sql).toContain("secret = 0");
    expect(buildKpiQuery("done", true).sql).not.toContain("secret = 0");
  });
});
