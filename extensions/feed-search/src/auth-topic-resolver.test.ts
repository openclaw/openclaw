import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MySqlConfig } from "./types.js";

const { mockExecuteQuery } = vi.hoisted(() => ({
  mockExecuteQuery: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
}));

vi.mock("./mysql-client.js", () => ({
  executeQuery: mockExecuteQuery,
}));

const { AuthTopicResolver } = await import("./auth-topic-resolver.js");

const DB_CONFIG: MySqlConfig = {
  host: "127.0.0.1",
  port: 3306,
  user: "tester",
  password: "secret",
  database: "superworker",
};

/** legal_user_role result row for the su lookup (the first query every call makes). */
function suRow(su: number | null): unknown[] {
  return su === null ? [] : [{ su }];
}

/** entity_auth result rows, newest grant first (matches ORDER BY id DESC). */
function authRows(...pairs: Array<[number | null, number | null]>): unknown[] {
  return pairs.map(([masterId, slaveId]) => ({ masterId, slaveId }));
}

/** research_report id rows for the superuser path. */
function reportRows(...ids: number[]): unknown[] {
  return ids.map((id) => ({ id }));
}

/** feed_topic id rows (master-topic lookup for the superuser path). */
function topicIdRows(...ids: number[]): unknown[] {
  return ids.map((id) => ({ id }));
}

/** feed_topic title result rows. */
function titleRows(...pairs: Array<[number, string]>): unknown[] {
  return pairs.map(([id, title]) => ({ id, title }));
}

describe("AuthTopicResolver.getAuthorizedTopics", () => {
  let resolver: InstanceType<typeof AuthTopicResolver>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T08:00:00Z"));
    resolver = new AuthTopicResolver(DB_CONFIG);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("normal user (su = 0)", () => {
    it("looks up the su flag before the entity_auth grants", async () => {
      mockExecuteQuery.mockResolvedValueOnce(suRow(0));
      mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
      mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));

      await resolver.getAuthorizedTopics("42");

      expect(mockExecuteQuery).toHaveBeenNthCalledWith(
        1,
        DB_CONFIG,
        "SELECT su FROM legal_user_role WHERE id = ?",
        ["42"],
      );
      expect(mockExecuteQuery).toHaveBeenNthCalledWith(
        2,
        DB_CONFIG,
        "SELECT masterId, slaveId FROM entity_auth WHERE uid = ? ORDER BY id DESC",
        ["42"],
      );
      expect(mockExecuteQuery).toHaveBeenNthCalledWith(
        3,
        DB_CONFIG,
        "SELECT id, title FROM feed_topic WHERE id IN (?)",
        [585],
      );
    });

    it("maps slaveId > 0 to a slave topic", async () => {
      mockExecuteQuery.mockResolvedValueOnce(suRow(0));
      mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
      mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));

      const topics = await resolver.getAuthorizedTopics("42");

      expect(topics).toEqual([{ topicId: 585, useSlaveTopic: true, topicName: "广本监测专项" }]);
    });

    it("maps masterId > 0 with slaveId = 0 to a master topic", async () => {
      mockExecuteQuery.mockResolvedValueOnce(suRow(0));
      mockExecuteQuery.mockResolvedValueOnce(authRows([270, 0]));
      mockExecuteQuery.mockResolvedValueOnce(titleRows([270, "主专题"]));

      const topics = await resolver.getAuthorizedTopics("42");

      expect(topics).toEqual([{ topicId: 270, useSlaveTopic: false, topicName: "主专题" }]);
    });

    it("keeps the most recent grant first and dedupes repeated topics", async () => {
      mockExecuteQuery.mockResolvedValueOnce(suRow(0));
      mockExecuteQuery.mockResolvedValueOnce(authRows([0, 624], [270, 585], [270, 585], [116, 0]));
      mockExecuteQuery.mockResolvedValueOnce(titleRows([624, "备份"], [585, "广本"], [116, "专题A"]));

      const topics = await resolver.getAuthorizedTopics("42");

      expect(topics.map((t) => t.topicId)).toEqual([624, 585, 116]);
      expect(topics[0]).toEqual({ topicId: 624, useSlaveTopic: true, topicName: "备份" });
    });

    it("skips rows with no usable mapping", async () => {
      mockExecuteQuery.mockResolvedValueOnce(suRow(0));
      mockExecuteQuery.mockResolvedValueOnce(authRows([0, 0], [null, null]));

      const topics = await resolver.getAuthorizedTopics("42");

      expect(topics).toEqual([]);
      // su lookup + entity_auth, but no mapped topicIds -> no feed_topic lookup.
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
    });

    it("treats a missing legal_user_role row as a normal user", async () => {
      mockExecuteQuery.mockResolvedValueOnce(suRow(null));
      mockExecuteQuery.mockResolvedValueOnce(authRows([270, 0]));
      mockExecuteQuery.mockResolvedValueOnce(titleRows([270, "主专题"]));

      const topics = await resolver.getAuthorizedTopics("42");

      expect(topics).toEqual([{ topicId: 270, useSlaveTopic: false, topicName: "主专题" }]);
    });
  });

  describe("superuser (su = 1)", () => {
    it("resolves master topics of every Running daily-monitoring report", async () => {
      mockExecuteQuery.mockResolvedValueOnce(suRow(1));
      mockExecuteQuery.mockResolvedValueOnce(reportRows(3076, 3250));
      mockExecuteQuery.mockResolvedValueOnce(topicIdRows(270, 328));
      mockExecuteQuery.mockResolvedValueOnce(titleRows([270, "广汽本田舆情监测"], [328, "中建四局全局监测"]));

      const topics = await resolver.getAuthorizedTopics("962");

      expect(topics).toEqual([
        { topicId: 270, useSlaveTopic: false, topicName: "广汽本田舆情监测" },
        { topicId: 328, useSlaveTopic: false, topicName: "中建四局全局监测" },
      ]);
      expect(mockExecuteQuery).toHaveBeenNthCalledWith(
        2,
        DB_CONFIG,
        "SELECT id FROM research_report WHERE status = 'Running' AND category = 'DailyMonitoring' AND deleted = 0",
      );
      expect(mockExecuteQuery).toHaveBeenNthCalledWith(
        3,
        DB_CONFIG,
        "SELECT id FROM feed_topic WHERE master = 1 AND reportId IN (?,?) ORDER BY id ASC",
        [3076, 3250],
      );
      // Superusers never touch entity_auth.
      expect(mockExecuteQuery).not.toHaveBeenCalledWith(
        DB_CONFIG,
        expect.stringContaining("entity_auth"),
        expect.anything(),
      );
    });

    it("returns empty without querying feed_topic when no reports are running", async () => {
      mockExecuteQuery.mockResolvedValueOnce(suRow(1));
      mockExecuteQuery.mockResolvedValueOnce(reportRows());

      const topics = await resolver.getAuthorizedTopics("962");

      expect(topics).toEqual([]);
      // su lookup + research_report only.
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
    });

    it("dedupes topic ids returned for multiple reports", async () => {
      mockExecuteQuery.mockResolvedValueOnce(suRow(1));
      mockExecuteQuery.mockResolvedValueOnce(reportRows(100, 200));
      mockExecuteQuery.mockResolvedValueOnce(topicIdRows(50, 50, 60));
      mockExecuteQuery.mockResolvedValueOnce(titleRows([50, "A"], [60, "B"]));

      const topics = await resolver.getAuthorizedTopics("962");

      expect(topics.map((t) => t.topicId)).toEqual([50, 60]);
    });
  });

  it("returns empty for an empty userId without querying", async () => {
    const topics = await resolver.getAuthorizedTopics("");

    expect(topics).toEqual([]);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it("degrades to null topicName when the title lookup fails", async () => {
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockRejectedValueOnce(new Error("title lookup down"));

    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics).toEqual([{ topicId: 585, useSlaveTopic: true, topicName: null }]);
  });

  it("serves the cached result within the TTL", async () => {
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));

    await resolver.getAuthorizedTopics("42");
    vi.advanceTimersByTime(4 * 60 * 1000);
    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics[0]?.topicId).toBe(585);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(3);
  });

  it("re-queries after the TTL expires", async () => {
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([0, 624]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([624, "备份"]));

    await resolver.getAuthorizedTopics("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics[0]?.topicId).toBe(624);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(6);
  });

  it("backfills topic names from the previous cache entry on a title-lookup blip", async () => {
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));
    await resolver.getAuthorizedTopics("42");

    vi.advanceTimersByTime(6 * 60 * 1000);
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockRejectedValueOnce(new Error("feed_topic blip"));

    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics).toEqual([{ topicId: 585, useSlaveTopic: true, topicName: "广本监测专项" }]);
  });

  it("serves a stale cache entry when the DB fails", async () => {
    mockExecuteQuery.mockResolvedValueOnce(suRow(0));
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));
    await resolver.getAuthorizedTopics("42");

    vi.advanceTimersByTime(6 * 60 * 1000);
    mockExecuteQuery.mockRejectedValueOnce(new Error("db down"));

    const topics = await resolver.getAuthorizedTopics("42");
    expect(topics[0]?.topicId).toBe(585);
  });

  it("throws when the DB fails and no cache entry exists", async () => {
    mockExecuteQuery.mockRejectedValueOnce(new Error("db down"));

    await expect(resolver.getAuthorizedTopics("42")).rejects.toThrow(/Failed to resolve/);
  });
});
