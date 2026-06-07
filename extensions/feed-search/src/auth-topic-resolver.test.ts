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

/** entity_auth result rows, newest grant first (matches ORDER BY id DESC). */
function authRows(...pairs: Array<[number | null, number | null]>): unknown[] {
  return pairs.map(([masterId, slaveId]) => ({ masterId, slaveId }));
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

  it("maps slaveId > 0 to a slave topic", async () => {
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));

    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics).toEqual([{ topicId: 585, useSlaveTopic: true, topicName: "广本监测专项" }]);
    expect(mockExecuteQuery).toHaveBeenNthCalledWith(
      1,
      DB_CONFIG,
      "SELECT masterId, slaveId FROM entity_auth WHERE uid = ? ORDER BY id DESC",
      ["42"],
    );
    expect(mockExecuteQuery).toHaveBeenNthCalledWith(
      2,
      DB_CONFIG,
      "SELECT id, title FROM feed_topic WHERE id IN (?)",
      [585],
    );
  });

  it("maps masterId > 0 with slaveId = 0 to a master topic", async () => {
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 0]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([270, "主专题"]));

    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics).toEqual([{ topicId: 270, useSlaveTopic: false, topicName: "主专题" }]);
  });

  it("keeps the most recent grant first and dedupes repeated topics", async () => {
    mockExecuteQuery.mockResolvedValueOnce(authRows([0, 624], [270, 585], [270, 585], [116, 0]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([624, "备份"], [585, "广本"], [116, "专题A"]));

    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics.map((t) => t.topicId)).toEqual([624, 585, 116]);
    expect(topics[0]).toEqual({ topicId: 624, useSlaveTopic: true, topicName: "备份" });
  });

  it("skips rows with no usable mapping", async () => {
    mockExecuteQuery.mockResolvedValueOnce(authRows([0, 0], [null, null]));

    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics).toEqual([]);
    // No mapped topicIds -> no feed_topic lookup.
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
  });

  it("returns empty for an empty userId without querying", async () => {
    const topics = await resolver.getAuthorizedTopics("");

    expect(topics).toEqual([]);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it("degrades to null topicName when the title lookup fails", async () => {
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockRejectedValueOnce(new Error("title lookup down"));

    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics).toEqual([{ topicId: 585, useSlaveTopic: true, topicName: null }]);
  });

  it("serves the cached result within the TTL", async () => {
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));

    await resolver.getAuthorizedTopics("42");
    vi.advanceTimersByTime(4 * 60 * 1000);
    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics[0]?.topicId).toBe(585);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
  });

  it("re-queries after the TTL expires", async () => {
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本"]));
    mockExecuteQuery.mockResolvedValueOnce(authRows([0, 624]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([624, "备份"]));

    await resolver.getAuthorizedTopics("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics[0]?.topicId).toBe(624);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(4);
  });

  it("backfills topic names from the previous cache entry on a title-lookup blip", async () => {
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));
    await resolver.getAuthorizedTopics("42");

    vi.advanceTimersByTime(6 * 60 * 1000);
    mockExecuteQuery.mockResolvedValueOnce(authRows([270, 585]));
    mockExecuteQuery.mockRejectedValueOnce(new Error("feed_topic blip"));

    const topics = await resolver.getAuthorizedTopics("42");

    expect(topics).toEqual([{ topicId: 585, useSlaveTopic: true, topicName: "广本监测专项" }]);
  });

  it("serves a stale cache entry when the DB fails", async () => {
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
