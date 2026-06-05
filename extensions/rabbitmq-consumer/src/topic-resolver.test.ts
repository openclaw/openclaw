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

/** entity_auth result rows, newest grant first (matches ORDER BY id DESC). */
function authRows(...pairs: Array<[number | null, number | null]>): [unknown[], unknown] {
  return [pairs.map(([masterId, slaveId]) => ({ masterId, slaveId })), undefined];
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

  it("returns slaveId as topicId with useSlaveTopic when slaveId > 0", async () => {
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
    expect(mockExecute).toHaveBeenNthCalledWith(
      1,
      "SELECT masterId, slaveId FROM entity_auth WHERE uid = ? ORDER BY id DESC",
      ["42"],
    );
    expect(mockExecute).toHaveBeenNthCalledWith(
      2,
      "SELECT id, title FROM feed_topic WHERE id IN (?)",
      [585],
    );
  });

  it("returns masterId as topicId when slaveId is 0 and masterId > 0", async () => {
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
      2,
      "SELECT id, title FROM feed_topic WHERE id IN (?,?,?)",
      [585, 357, 116],
    );
  });

  it("degrades topicName to null when the feed_topic lookup fails", async () => {
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
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows());

    const result = await resolver.getTopicIdsByUser("42");

    expect(result.topicName).toBeNull();
  });

  it("normalizes a whitespace-only title to null", async () => {
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "   "]));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result.topicName).toBeNull();
  });

  it("keeps previously cached topicNames when a TTL refresh's title lookup fails", async () => {
    mockExecute.mockResolvedValueOnce(authRows([585, 0], [116, 0]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "专题E"], [116, "专题A"]));
    mockExecute.mockResolvedValueOnce(authRows([585, 0], [116, 0]));
    mockExecute.mockRejectedValueOnce(new Error("feed_topic unavailable"));

    const first = await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const refreshed = await resolver.getTopicIdsByUser("42");

    // The title blip must not blank any name (prefix shape stays stable).
    expect(first.topicName).toBe("专题E");
    expect(refreshed).toEqual(first);
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });

  it("does not reuse a stale topicName when the topicId changed on refresh", async () => {
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "从专题"]));
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
    mockExecute.mockResolvedValueOnce(authRows([0, 0]));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result).toEqual({
      topicId: null,
      useSlaveTopic: false,
      masterId: 0,
      topicName: null,
      topics: [],
    });
    // No topicIds -> the feed_topic title query is skipped entirely.
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("treats null columns as 0 (no mapping)", async () => {
    mockExecute.mockResolvedValueOnce(authRows([null, null]));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result.topicId).toBeNull();
    expect(result.topics).toEqual([]);
  });

  it("returns no mapping when entity_auth has no row for the uid", async () => {
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
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));

    const first = await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(4 * 60 * 1000);
    const second = await resolver.getTopicIdsByUser("42");

    expect(second).toEqual(first);
    expect(second.topicName).toBe("广本监测专项");
    // entity_auth + feed_topic, once each — the cached entry covers both.
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("re-queries after the TTL expires", async () => {
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "从专题"]));
    mockExecute.mockResolvedValueOnce(authRows([270, 0]));
    mockExecute.mockResolvedValueOnce(titleRows([270, "主专题"]));

    await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const refreshed = await resolver.getTopicIdsByUser("42");

    expect(refreshed.topicId).toBe(270);
    expect(refreshed.topicName).toBe("主专题");
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });

  it("caches per uid, not globally", async () => {
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "专题A"]));
    mockExecute.mockResolvedValueOnce(authRows([99, 0]));
    mockExecute.mockResolvedValueOnce(titleRows([99, "专题B"]));

    const userA = await resolver.getTopicIdsByUser("42");
    const userB = await resolver.getTopicIdsByUser("43");

    expect(userA.topicId).toBe(585);
    expect(userA.topicName).toBe("专题A");
    expect(userB.topicId).toBe(99);
    expect(userB.topicName).toBe("专题B");
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });

  it("falls back to the stale cache entry when the DB query fails", async () => {
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "广本监测专项"]));
    mockExecute.mockRejectedValueOnce(new Error("connection lost"));

    const first = await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const stale = await resolver.getTopicIdsByUser("42");

    expect(stale).toEqual(first);
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("throws on DB failure when no cache entry exists", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connection lost"));

    await expect(resolver.getTopicIdsByUser("42")).rejects.toThrow(
      /Failed to look up topicId for user 42/,
    );
  });

  it("clears the cache on close", async () => {
    mockExecute.mockResolvedValueOnce(authRows([270, 585]));
    mockExecute.mockResolvedValueOnce(titleRows([585, "从专题"]));
    mockExecute.mockResolvedValueOnce(authRows([270, 0]));
    mockExecute.mockResolvedValueOnce(titleRows([270, "主专题"]));

    await resolver.getTopicIdsByUser("42");
    await resolver.close();
    const afterClose = await resolver.getTopicIdsByUser("42");

    expect(afterClose.topicId).toBe(270);
    expect(afterClose.topicName).toBe("主专题");
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });
});
