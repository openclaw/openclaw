import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionsSpawnDedupKey,
  getSpawnDedupMinuteEpoch,
  peekSessionsSpawnDedup,
  recordSessionsSpawnDedup,
  resetSessionsSpawnDedupForTests,
  SESSIONS_SPAWN_DEDUP_TTL_MS,
} from "./sessions-spawn-dedup.js";

const REQUESTER_KEY = "agent:test-requester:main";
const TARGET_ID = "test-target";

describe("sessions-spawn-dedup", () => {
  afterEach(() => {
    resetSessionsSpawnDedupForTests();
    vi.useRealTimers();
  });

  it("buildSessionsSpawnDedupKey is stable for identical inputs", () => {
    const params = {
      requesterInternalKey: REQUESTER_KEY,
      targetAgentId: TARGET_ID,
      objectiveText: "sync upstream",
      minuteEpoch: 9_000_000,
      variant: "subagent|mode:run|thread:false|sandbox:inherit|label:",
    };
    const a = buildSessionsSpawnDedupKey(params);
    const b = buildSessionsSpawnDedupKey(params);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("buildSessionsSpawnDedupKey changes when objective text changes", () => {
    const base = {
      requesterInternalKey: REQUESTER_KEY,
      targetAgentId: TARGET_ID,
      minuteEpoch: 9_000_000,
      variant: "v1",
    };
    const k1 = buildSessionsSpawnDedupKey({ ...base, objectiveText: "task a" });
    const k2 = buildSessionsSpawnDedupKey({ ...base, objectiveText: "task b" });
    expect(k1).not.toBe(k2);
  });

  it("peek returns recorded child until TTL expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const key = buildSessionsSpawnDedupKey({
      requesterInternalKey: REQUESTER_KEY,
      targetAgentId: TARGET_ID,
      objectiveText: "test objective",
      minuteEpoch: getSpawnDedupMinuteEpoch(),
      variant: "subagent|mode:run|thread:false|sandbox:inherit|label:",
    });
    expect(peekSessionsSpawnDedup({ dedupKey: key })).toBeUndefined();

    const childSessionKey = `agent:${TARGET_ID}:subagent:abc`;
    recordSessionsSpawnDedup({
      dedupKey: key,
      childSessionKey,
      runId: "run-1",
    });

    expect(peekSessionsSpawnDedup({ dedupKey: key })).toMatchObject({
      childSessionKey,
      runId: "run-1",
    });

    vi.advanceTimersByTime(SESSIONS_SPAWN_DEDUP_TTL_MS - 1);
    expect(peekSessionsSpawnDedup({ dedupKey: key })).toMatchObject({
      runId: "run-1",
    });

    vi.advanceTimersByTime(2);
    expect(peekSessionsSpawnDedup({ dedupKey: key })).toBeUndefined();
  });
});
