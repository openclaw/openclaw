import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionsSpawnDedupKey,
  getSpawnDedupMinuteEpoch,
  peekSessionsSpawnDedup,
  recordSessionsSpawnDedup,
  resetSessionsSpawnDedupForTests,
  SESSIONS_SPAWN_DEDUP_TTL_MS,
} from "./sessions-spawn-dedup.js";

describe("sessions-spawn-dedup", () => {
  afterEach(() => {
    resetSessionsSpawnDedupForTests();
    vi.useRealTimers();
  });

  it("buildSessionsSpawnDedupKey is stable for identical inputs", () => {
    const a = buildSessionsSpawnDedupKey({
      requesterInternalKey: "agent:tony:main",
      targetAgentId: "scout",
      objectiveText: "sync upstream",
      minuteEpoch: 9_000_000,
      variant: "subagent|mode:run|thread:false|sandbox:inherit|label:",
    });
    const b = buildSessionsSpawnDedupKey({
      requesterInternalKey: "agent:tony:main",
      targetAgentId: "scout",
      objectiveText: "sync upstream",
      minuteEpoch: 9_000_000,
      variant: "subagent|mode:run|thread:false|sandbox:inherit|label:",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("buildSessionsSpawnDedupKey changes when objective text changes", () => {
    const base = {
      requesterInternalKey: "agent:tony:main",
      targetAgentId: "scout",
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
      requesterInternalKey: "agent:x:main",
      targetAgentId: "y",
      objectiveText: "z",
      minuteEpoch: getSpawnDedupMinuteEpoch(),
      variant: "subagent|mode:run|thread:false|sandbox:inherit|label:",
    });
    expect(peekSessionsSpawnDedup({ dedupKey: key })).toBeUndefined();

    recordSessionsSpawnDedup({
      dedupKey: key,
      childSessionKey: "agent:y:subagent:abc",
      runId: "run-1",
    });

    expect(peekSessionsSpawnDedup({ dedupKey: key })).toMatchObject({
      childSessionKey: "agent:y:subagent:abc",
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
