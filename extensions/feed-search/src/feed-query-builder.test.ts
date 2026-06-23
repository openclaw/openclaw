import { describe, expect, it } from "vitest";
import type { AuthorizedTopic } from "./auth-topic-resolver.js";
import {
  buildSearchQuery,
  buildStatsQueries,
  UnauthorizedTopicError,
} from "./feed-query-builder.js";
import {
  AGGREGATION_DIMENSIONS,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
} from "./feed-query-fields.js";

const MASTER_TOPIC: AuthorizedTopic = { topicId: 116, useSlaveTopic: false, topicName: "专题A" };
const SLAVE_TOPIC: AuthorizedTopic = { topicId: 585, useSlaveTopic: true, topicName: "广本" };
const AUTH = [SLAVE_TOPIC, MASTER_TOPIC];

/** Count `?` placeholders in a SQL string. */
function placeholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

describe("buildSearchQuery", () => {
  it("defaults to the primary (most recent) topic when topicId is omitted", () => {
    const { sql, values, topic } = buildSearchQuery({}, AUTH);

    expect(topic).toBe(SLAVE_TOPIC);
    expect(sql).toContain("WHERE f.slaveTopicId = ? AND f.skip = 0");
    expect(values).toEqual([585]);
  });

  it("uses topicId vs slaveTopicId based on the topic's useSlaveTopic flag", () => {
    const { sql, values, topic } = buildSearchQuery({ topicId: 116 }, AUTH);

    expect(topic).toBe(MASTER_TOPIC);
    expect(sql).toContain("WHERE f.topicId = ? AND f.skip = 0");
    expect(values).toEqual([116]);
  });

  it("throws UnauthorizedTopicError for a topic outside the authorized set", () => {
    expect(() => buildSearchQuery({ topicId: 999 }, AUTH)).toThrow(UnauthorizedTopicError);
  });

  it("throws UnauthorizedTopicError when the user has no topics", () => {
    expect(() => buildSearchQuery({}, [])).toThrow(UnauthorizedTopicError);
  });

  it("always enforces skip = 0 and never interpolates user strings", () => {
    const { sql } = buildSearchQuery(
      { keyword: "'; DROP TABLE feed_monitor_item; --", platform: "微博%" },
      AUTH,
    );

    expect(sql).toContain("f.skip = 0");
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain("微博");
  });

  it("keeps placeholder count in lockstep with values", () => {
    const { sql, values } = buildSearchQuery(
      {
        topicId: 585,
        startDate: "2026-06-01",
        endDate: "2026-06-06",
        level: ["Red", "Orange"],
        emotion: ["Negative"],
        platform: "微博",
        keyword: "裁员",
      },
      AUTH,
    );

    expect(placeholders(sql)).toBe(values.length);
    expect(values).toEqual([
      585,
      "2026-06-01",
      "2026-06-06",
      "Red",
      "Orange",
      "Negative",
      "微博",
      "%裁员%",
      "%裁员%",
      "%裁员%",
    ]);
  });

  it("builds an inclusive date range with index-friendly bounds", () => {
    const { sql } = buildSearchQuery({ startDate: "2026-06-01", endDate: "2026-06-06" }, AUTH);

    expect(sql).toContain("f.date >= ?");
    expect(sql).toContain("f.date < DATE_ADD(?, INTERVAL 1 DAY)");
  });

  it("rejects malformed dates", () => {
    expect(() => buildSearchQuery({ startDate: "06/01/2026" }, AUTH)).toThrow(/date/i);
    expect(() => buildSearchQuery({ endDate: "2026-6-1" }, AUTH)).toThrow(/date/i);
  });

  it("drops non-whitelisted level and emotion values", () => {
    const { sql, values } = buildSearchQuery(
      { level: ["Red", "Purple"], emotion: ["Angry"] },
      AUTH,
    );

    expect(sql).toContain("f.level IN (?)");
    expect(sql).not.toContain("f.emotion IN");
    expect(values).toEqual([585, "Red"]);
  });

  it("escapes LIKE wildcards in keywords", () => {
    const { values } = buildSearchQuery({ keyword: "100%_增长\\" }, AUTH);

    expect(values).toContain("%100\\%\\_增长\\\\%");
  });

  it("clamps limit into [1, SEARCH_LIMIT_MAX] with a default", () => {
    expect(buildSearchQuery({}, AUTH).sql).toContain(`LIMIT ${SEARCH_LIMIT_DEFAULT}`);
    expect(buildSearchQuery({ limit: SEARCH_LIMIT_MAX + 1 }, AUTH).sql).toContain(
      `LIMIT ${SEARCH_LIMIT_MAX}`,
    );
    expect(buildSearchQuery({ limit: 0 }, AUTH).sql).toContain(`LIMIT ${SEARCH_LIMIT_DEFAULT}`);
    expect(buildSearchQuery({ limit: 5 }, AUTH).sql).toContain("LIMIT 5");
    expect(buildSearchQuery({ limit: Number.NaN }, AUTH).sql).toContain(
      `LIMIT ${SEARCH_LIMIT_DEFAULT}`,
    );
  });

  it("orders deterministically by date then id", () => {
    const { sql } = buildSearchQuery({}, AUTH);

    expect(sql).toContain("ORDER BY f.date DESC, f.id DESC");
  });
});

describe("buildStatsQueries", () => {
  it("produces a total count plus one query per whitelisted dimension", () => {
    const { totalQuery, dimensionQueries } = buildStatsQueries(
      { groupBy: ["level", "emotion", "bogus"] },
      AUTH,
    );

    expect(totalQuery.sql).toContain("SELECT COUNT(*) AS cnt FROM feed_monitor_item f");
    expect(totalQuery.sql).toContain("WHERE f.slaveTopicId = ? AND f.skip = 0");
    expect(dimensionQueries.map((q) => q.dimension)).toEqual(["level", "emotion"]);
  });

  it("falls back to default dimensions when groupBy is empty or all invalid", () => {
    const { dimensionQueries } = buildStatsQueries({ groupBy: ["bogus"] }, AUTH);

    expect(dimensionQueries.length).toBeGreaterThan(0);
    for (const q of dimensionQueries) {
      expect(AGGREGATION_DIMENSIONS[q.dimension]).toBeDefined();
    }
  });

  it("uses only whitelist SQL expressions for GROUP BY", () => {
    const { dimensionQueries } = buildStatsQueries({ groupBy: ["day"] }, AUTH);

    expect(dimensionQueries[0].sql).toContain(`GROUP BY ${AGGREGATION_DIMENSIONS.day}`);
    expect(dimensionQueries[0].sql).toContain("ORDER BY cnt DESC");
  });

  it("applies shared filters with matching placeholders", () => {
    const { totalQuery, dimensionQueries } = buildStatsQueries(
      { startDate: "2026-06-01", level: ["Red"], groupBy: ["platform"] },
      AUTH,
    );

    expect(placeholders(totalQuery.sql)).toBe(totalQuery.values.length);
    expect(totalQuery.values).toEqual([585, "2026-06-01", "Red"]);
    expect(placeholders(dimensionQueries[0].sql)).toBe(dimensionQueries[0].values.length);
  });

  it("joins the data table only when a keyword filter is present", () => {
    const without = buildStatsQueries({ groupBy: ["level"] }, AUTH);
    const withKeyword = buildStatsQueries({ groupBy: ["level"], keyword: "裁员" }, AUTH);

    expect(without.totalQuery.sql).not.toContain("JOIN feed_monitor_item_data");
    expect(withKeyword.totalQuery.sql).toContain("JOIN feed_monitor_item_data d ON d.id = f.id");
  });

  it("enforces topic authorization the same as search", () => {
    expect(() => buildStatsQueries({ topicId: 999 }, AUTH)).toThrow(UnauthorizedTopicError);
  });
});
