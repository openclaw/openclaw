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

function rows(masterId: number | null, slaveId: number | null): [unknown[], unknown] {
  return [[{ masterId, slaveId }], undefined];
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
    mockExecute.mockResolvedValueOnce(rows(270, 585));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result).toEqual({ topicId: 585, useSlaveTopic: true, masterId: 270 });
    expect(mockExecute).toHaveBeenCalledWith(
      "SELECT masterId, slaveId FROM entity_auth WHERE uid = ? LIMIT 1",
      ["42"],
    );
  });

  it("returns masterId as topicId when slaveId is 0 and masterId > 0", async () => {
    mockExecute.mockResolvedValueOnce(rows(270, 0));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result).toEqual({ topicId: 270, useSlaveTopic: false, masterId: 270 });
  });

  it("returns no mapping when both masterId and slaveId are 0", async () => {
    mockExecute.mockResolvedValueOnce(rows(0, 0));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result).toEqual({ topicId: null, useSlaveTopic: false, masterId: 0 });
  });

  it("treats null columns as 0 (no mapping)", async () => {
    mockExecute.mockResolvedValueOnce(rows(null, null));

    const result = await resolver.getTopicIdsByUser("42");

    expect(result).toEqual({ topicId: null, useSlaveTopic: false, masterId: 0 });
  });

  it("returns no mapping when entity_auth has no row for the uid", async () => {
    mockExecute.mockResolvedValueOnce([[], undefined]);

    const result = await resolver.getTopicIdsByUser("42");

    expect(result).toEqual({ topicId: null, useSlaveTopic: false, masterId: 0 });
  });

  it("returns no mapping without querying for an empty userId", async () => {
    const result = await resolver.getTopicIdsByUser("");

    expect(result).toEqual({ topicId: null, useSlaveTopic: false, masterId: 0 });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("serves a cached resolution within the TTL without re-querying", async () => {
    mockExecute.mockResolvedValueOnce(rows(270, 585));

    const first = await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(4 * 60 * 1000);
    const second = await resolver.getTopicIdsByUser("42");

    expect(second).toEqual(first);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("re-queries after the TTL expires", async () => {
    mockExecute.mockResolvedValueOnce(rows(270, 585));
    mockExecute.mockResolvedValueOnce(rows(270, 0));

    await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const refreshed = await resolver.getTopicIdsByUser("42");

    expect(refreshed).toEqual({ topicId: 270, useSlaveTopic: false, masterId: 270 });
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("caches per uid, not globally", async () => {
    mockExecute.mockResolvedValueOnce(rows(270, 585));
    mockExecute.mockResolvedValueOnce(rows(99, 0));

    const userA = await resolver.getTopicIdsByUser("42");
    const userB = await resolver.getTopicIdsByUser("43");

    expect(userA).toEqual({ topicId: 585, useSlaveTopic: true, masterId: 270 });
    expect(userB).toEqual({ topicId: 99, useSlaveTopic: false, masterId: 99 });
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("falls back to the stale cache entry when the DB query fails", async () => {
    mockExecute.mockResolvedValueOnce(rows(270, 585));
    mockExecute.mockRejectedValueOnce(new Error("connection lost"));

    const first = await resolver.getTopicIdsByUser("42");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const stale = await resolver.getTopicIdsByUser("42");

    expect(stale).toEqual(first);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("throws on DB failure when no cache entry exists", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connection lost"));

    await expect(resolver.getTopicIdsByUser("42")).rejects.toThrow(
      /Failed to look up topicId for user 42/,
    );
  });

  it("clears the cache on close", async () => {
    mockExecute.mockResolvedValueOnce(rows(270, 585));
    mockExecute.mockResolvedValueOnce(rows(270, 0));

    await resolver.getTopicIdsByUser("42");
    await resolver.close();
    const afterClose = await resolver.getTopicIdsByUser("42");

    expect(afterClose).toEqual({ topicId: 270, useSlaveTopic: false, masterId: 270 });
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});
