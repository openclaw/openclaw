import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryDbConfig } from "./types.js";

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn<(...args: unknown[]) => Promise<[unknown[], unknown]>>(),
}));

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: vi.fn(() => ({
      execute: mockExecute,
      end: vi.fn(async () => {}),
    })),
  },
}));

const { TopicResolver } = await import("./topic-resolver.js");

const DB_CONFIG: HistoryDbConfig = {
  host: "127.0.0.1",
  port: 3306,
  user: "tester",
  password: "secret",
  database: "superworker",
};

/** legal_user_role su-flag row (the first query every resolution runs). */
function suRow(su: number | null): [unknown[], unknown] {
  return [su === null ? [] : [{ su }], undefined];
}

/** entity_auth result rows, newest grant first (matches ORDER BY id DESC). */
function authRows(...pairs: Array<[number | null, number | null]>): [unknown[], unknown] {
  return [pairs.map(([masterId, slaveId]) => ({ masterId, slaveId })), undefined];
}

/** research_report id rows for the superuser path. */
function reportRows(...ids: number[]): [unknown[], unknown] {
  return [ids.map((id) => ({ id })), undefined];
}

/** feed_topic id rows (master-topic lookup for the superuser path). */
function topicIdRows(...ids: number[]): [unknown[], unknown] {
  return [ids.map((id) => ({ id })), undefined];
}

/** feed_topic title result rows. */
function titleRows(...pairs: Array<[number, string]>): [unknown[], unknown] {
  return [pairs.map(([id, title]) => ({ id, title })), undefined];
}

describe("TopicResolver.getTopicIdsByUser", () => {
  let resolver: InstanceType<typeof TopicResolver>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T08:00:00Z"));
    resolver = new TopicResolver(DB_CONFIG);
  });

  afterEach(async () => {
    await resolver.close();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("normal user (su = 0)", () => {
    it("looks up the su flag before the entity_auth grants", async () => {
      mockExecute.mockResolvedValueOnce(suRow(0));
      mockExecute.mockResolvedValueOnce(authRows([270, 585]));
      mockExecute.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));

      await resolver.getTopicIdsByUser("42");

      expect(mockExecute).toHaveBeenNthCalledWith(
        1,
        "SELECT su FROM legal_user_role WHERE id = ?",
        ["42"],
      );
      expect(mockExecute).toHaveBeenNthCalledWith(
        2,
        "SELECT masterId, slaveId FROM entity_auth WHERE uid = ? ORDER BY id DESC",
        ["42"],
      );
      expect(mockExecute).toHaveBeenNthCalledWith(
        3,
        "SELECT id, title FROM feed_topic WHERE id IN (?)",
        [585],
      );
    });

    it("returns slaveId as topicId with useSlaveTopic when slaveId > 0", async () => {
      mockExecute.mockResolvedValueOnce(suRow(0));
      mockExecute.mockResolvedValueOnce(authRows([270, 585]));
      mockExecute.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));

      const result = await resolver.getTopicIdsByUser("42");

      expect(result).toEqual({
        topicId: 585,
        useSlaveTopic: true,
        masterId: 270,
        topicName: "广本监测专项",
        topics: [{ topicId: 585, useSlaveTopic: true, masterId: 270, topicName: "广本监测专项" }],
      });
    });

    it("returns masterId as topicId when slaveId is 0 and masterId > 0", async () => {
      mockExecute.mockResolvedValueOnce(suRow(0));
      mockExecute.mockResolvedValueOnce(authRows([270, 0]));
      mockExecute.mockResolvedValueOnce(titleRows([270, "主专题"]));

      const result = await resolver.getTopicIdsByUser("42");

      expect(result).toEqual({
        topicId: 270,
        useSlaveTopic: false,
        masterId: 270,
        topicName: "主专题",
        topics: [{ topicId: 270, useSlaveTopic: false, masterId: 270, topicName: "主专题" }],
      });
    });

    it("keeps every distinct topic the user owns, deduped, primary = most recent grant", async () => {
      // Rows arrive newest-first; 585 repeats and unmapped (0,0) rows are dropped.
      mockExecute.mockResolvedValueOnce(suRow(0));
      mockExecute.mockResolvedValueOnce(authRows([585, 0], [0, 0], [357, 0], [585, 0], [116, 0]));
      mockExecute.mockResolvedValueOnce(titleRows([585, "专题E"], [357, "专题C"], [116, "专题A"]));

      const result = await resolver.getTopicIdsByUser("42");

      // Primary fields = the most recently granted mapping (first row).
      expect(result.topicId).toBe(585);
      expect(result.topicName).toBe("专题E");
      // All distinct topics survive, sorted by topicId for prompt determinism.
      expect(result.topics).toEqual([
        { topicId: 116, useSlaveTopic: false, masterId: 116, topicName: "专题A" },
        { topicId: 357, useSlaveTopic: false, masterId: 357, topicName: "专题C" },
        { topicId: 585, useSlaveTopic: false, masterId: 585, topicName: "专题E" },
      ]);
      // One IN query covers all three titles.
      expect(mockExecute).toHaveBeenNthCalledWith(
        3,
        "SELECT id, title FROM feed_topic WHERE id IN (?,?,?)",
        [585, 357, 116],
      );
    });

    it("treats a missing legal_user_role row as a normal user", async () => {
      mockExecute.mockResolvedValueOnce(suRow(null));
      mockExecute.mockResolvedValueOnce(authRows([270, 0]));
      mockExecute.mockResolvedValueOnce(titleRows([270, "主专题"]));

      const result = await resolver.getTopicIdsByUser("42");

      expect(result.topicId).toBe(270);
      expect(result.useSlaveTopic).toBe(false);
    });
  });

  describe("superuser (su = 1)", () => {
    it("resolves master topics of every Running daily-monitoring report", async () => {
      mockExecute.mockResolvedValueOnce(suRow(1));
      mockExecute.mockResolvedValueOnce(reportRows(3076, 3250));
      mockExecute.mockResolvedValueOnce(topicIdRows(270, 328));
      mockExecute.mockResolvedValueOnce(
        titleRows([270, "广汽本田舆情监测"], [328, "中建四局全局监测"]),
      );

      const result = await resolver.getTopicIdsByUser("962");

      // Primary = lowest topic id; topics list every master topic.
      expect(result.topicId).toBe(270);
      expect(result.useSlaveTopic).toBe(false);
      expect(result.masterId).toBe(270);
      expect(result.topics).toEqual([
        { topicId: 270, useSlaveTopic: false, masterId: 270, topicName: "广汽本田舆情监测" },
        { topicId: 328, useSlaveTopic: false, masterId: 328, topicName: "中建四局全局监测" },
      ]);
      expect(mockExecute).toHaveBeenNthCalledWith(
        2,
        "SELECT id FROM research_report WHERE status = 'Running' AND category = 'DailyMonitoring' AND deleted = 0",
      );
      expect(mockExecute).toHaveBeenNthCalledWith(
        3,
        "SELECT id FROM feed_topic WHERE master = 1 AND reportId IN (?,?) ORDER BY id ASC",
        [3076, 3250],
      );
      // Superusers never touch entity_auth.
      expect(mockExecute).not.toHaveBeenCalledWith(
        expect.stringContaining("entity_auth"),
        expect.anything(),
      );
    });

    it("returns no mapping without querying feed_topic when no reports are running", async () => {
      mockExecute.mockResolvedValueOnce(suRow(1));
      mockExecute.mockResolvedValueOnce(reportRows());

      const result = await resolver.getTopicIdsByUser("962");

      expect(result.topicId).toBeNull();
      expect(result.topics).toEqual([]);
      // su lookup + research_report only.
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it("dedupes topic ids returned for multiple reports", async () => {
      mockExecute.mockResolvedValueOnce(suRow(1));
      mockExecute.mockResolvedValueOnce(reportRows(100, 200));
      mockExecute.mockResolvedValueOnce(topicIdRows(50, 50, 60));
      mockExecute.mockResolvedValueOnce(titleRows([50, "A"], [60, "B"]));

      const result = await resolver.getTopicIdsByUser("962");

      expect(result.topics.map((t) => t.topicId)).toEqual([50, 60]);
    });
  });

  it("degrades topicName to null when the feed_topic lookup fails", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockRejectedValueOnce(new Error("feed_topic unavailable"));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result.topicId).toBe(585);
    expect(result.topicName).toBeNull();
    expect(result.topics).toEqual([
      { topicId: 585, useSlaveTopic: true, masterId: 270, topicName: null },
    ]);
  });

  it("returns topicName null when feed_topic has no row for the topicId", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows());

    const result = await resolver.getTopicIdsByUser("42");

    expect(result.topicName).toBeNull();
  });

  it("normalizes a whitespace-only title to null", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "   "]));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result.topicName).toBeNull();
  });

  it("keeps previously cached topicNames when a TTL refresh's title lookup fails", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([585, 0], [116, 0]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "专题E"], [116, "专题A"]));
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([585, 0], [116, 0]));
    mockExecute.mockRejectedValueOnce(new Error("feed_topic unavailable"));

    const first = await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const refreshed = await resolver.getTopicIdsByUser("42");

    // The title blip must not blank any name (prefix shape stays stable).
    expect(first.topicName).toBe("专题E");
    expect(refreshed).toEqual(first);
    expect(mockExecute).toHaveBeenCalledTimes(6);
  });

  it("does not reuse a stale topicName when the topicId changed on refresh", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "从专题"]));
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([99, 0]));
    mockExecute.mockRejectedValueOnce(new Error("feed_topic unavailable"));

    await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const refreshed = await resolver.getTopicIdsByUser("42");

    expect(refreshed).toEqual({
      topicId: 99,
      useSlaveTopic: false,
      masterId: 99,
      topicName: null,
      topics: [{ topicId: 99, useSlaveTopic: false, masterId: 99, topicName: null }],
    });
  });

  it("returns no mapping when both masterId and slaveId are 0", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([0, 0]));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result).toEqual({
      topicId: null,
      useSlaveTopic: false,
      masterId: 0,
      topicName: null,
      topics: [],
    });
    // su + entity_auth; no topicIds -> the feed_topic title query is skipped.
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("treats null columns as 0 (no mapping)", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([null, null]));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result.topicId).toBeNull();
    expect(result.topics).toEqual([]);
  });

  it("returns no mapping when entity_auth has no row for the uid", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce([[], undefined]);

    const result = await resolver.getTopicIdsByUser("42");

    expect(result.topicId).toBeNull();
    expect(result.topics).toEqual([]);
  });

  it("returns no mapping without querying for an empty userId", async () => {
    const result = await resolver.getTopicIdsByUser("");

    expect(result.topicId).toBeNull();
    expect(result.topics).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("serves a cached resolution within the TTL without re-querying", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));

    const first = await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(4 * 60 * 1000);
    const second = await resolver.getTopicIdsByUser("42");

    expect(second).toEqual(first);
    expect(second.topicName).toBe("广本监测专项");
    // su + entity_auth + feed_topic, once each — the cached entry covers all.
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("re-queries after the TTL expires", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "从专题"]));
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 0]));
    mockExecute.mockResolvedValueOnce(titleRows([270, "主专题"]));

    await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const refreshed = await resolver.getTopicIdsByUser("42");

    expect(refreshed.topicId).toBe(270);
    expect(refreshed.topicName).toBe("主专题");
    expect(mockExecute).toHaveBeenCalledTimes(6);
  });

  it("caches per uid, not globally", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "专题A"]));
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([99, 0]));
    mockExecute.mockResolvedValueOnce(titleRows([99, "专题B"]));

    const userA = await resolver.getTopicIdsByUser("42");
    const userB = await resolver.getTopicIdsByUser("43");

    expect(userA.topicId).toBe(585);
    expect(userA.topicName).toBe("专题A");
    expect(userB.topicId).toBe(99);
    expect(userB.topicName).toBe("专题B");
    expect(mockExecute).toHaveBeenCalledTimes(6);
  });

  it("falls back to the stale cache entry when the DB query fails", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));
    mockExecute.mockRejectedValueOnce(new Error("connection lost"));

    const first = await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const stale = await resolver.getTopicIdsByUser("42");

    expect(stale).toEqual(first);
    // su + entity_auth + feed_topic (cycle 1), then the su lookup fails (cycle 2).
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });

  it("throws on DB failure when no cache entry exists", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connection lost"));

    await expect(resolver.getTopicIdsByUser("42")).rejects.toThrow(
      /Failed to look up topicId for user 42/,
    );
  });

  it("clears the cache on close", async () => {
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "从专题"]));
    mockExecute.mockResolvedValueOnce(suRow(0));
    mockExecute.mockResolvedValueOnce(authRows([270, 0]));
    mockExecute.mockResolvedValueOnce(titleRows([270, "主专题"]));

    await resolver.getTopicIdsByUser("42");
    await resolver.close();
    const afterClose = await resolver.getTopicIdsByUser("42");

    expect(afterClose.topicId).toBe(270);
    expect(afterClose.topicName).toBe("主专题");
    expect(mockExecute).toHaveBeenCalledTimes(6);
  });
});
