/**
 * PR-9 Wave B3: plan-nudge cron scheduler unit tests.
 *
 * Verifies that:
 * - intervals (10/30/60 min by default) become absolute ISO `at`
 *   timestamps relative to the injected `now`.
 * - the resulting cron job has `sessionTarget: session:<key>` so the
 *   wake-up turn fires INTO the originating session.
 * - cleanup helper iterates ids and tolerates per-id failures.
 * - schedule failures don't throw (returns partial success list).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupPlanNudges,
  PLAN_NUDGE_NAME_PREFIX_FOR_TEST,
  schedulePlanNudges,
} from "./plan-nudge-crons.js";

describe("schedulePlanNudges (Wave B3)", () => {
  const FIXED_NOW = Date.parse("2026-04-18T12:00:00Z");
  let calls: Array<{ method: string; opts: object; params: unknown }>;
  let mockCallGatewayTool: (method: string, opts: object, params: unknown) => Promise<unknown>;

  beforeEach(() => {
    calls = [];
    mockCallGatewayTool = vi.fn(async (method, opts, params) => {
      calls.push({ method, opts, params });
      // Return a synthetic { jobId } shape that schedulePlanNudges accepts.
      const p = params as { name?: string };
      return { jobId: `test-job-id:${p.name ?? "unnamed"}` };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules 3 nudges at default intervals (10/30/60 min)", async () => {
    const result = await schedulePlanNudges({
      sessionKey: "agent:main:user:abc",
      deps: { callGatewayTool: mockCallGatewayTool, now: () => FIXED_NOW },
    });
    expect(result).toHaveLength(3);
    const fireTimes = result.map((r) => r.fireAtMs - FIXED_NOW);
    expect(fireTimes).toEqual([10 * 60_000, 30 * 60_000, 60 * 60_000]);
  });

  it("each scheduled cron has sessionTarget bound to the originating session", async () => {
    await schedulePlanNudges({
      sessionKey: "agent:main:user:abc",
      deps: { callGatewayTool: mockCallGatewayTool, now: () => FIXED_NOW },
    });
    for (const call of calls) {
      expect(call.method).toBe("cron.add");
      expect(call.params).toMatchObject({ sessionTarget: "session:agent:main:user:abc" });
    }
  });

  it("scheduled crons are one-shot (deleteAfterRun: true) and 'at' kind", async () => {
    await schedulePlanNudges({
      sessionKey: "agent:main:user:abc",
      deps: { callGatewayTool: mockCallGatewayTool, now: () => FIXED_NOW },
    });
    for (const call of calls) {
      expect(call.params).toMatchObject({
        deleteAfterRun: true,
        schedule: { kind: "at" },
      });
    }
  });

  it("scheduled crons use payload.kind=agentTurn with a self-describing message", async () => {
    await schedulePlanNudges({
      sessionKey: "agent:main:user:abc",
      deps: { callGatewayTool: mockCallGatewayTool, now: () => FIXED_NOW },
    });
    for (const call of calls) {
      const params = call.params as {
        payload?: { kind?: string; message?: string };
      };
      expect(params.payload?.kind).toBe("agentTurn");
      expect(params.payload?.message).toMatch(/Plan-nudge wake-up/);
    }
  });

  it("cron job name includes the marker prefix for safe cleanup", async () => {
    await schedulePlanNudges({
      sessionKey: "agent:main:user:abc",
      deps: { callGatewayTool: mockCallGatewayTool, now: () => FIXED_NOW },
    });
    for (const call of calls) {
      const name = (call.params as { name?: string }).name ?? "";
      expect(name).toContain(PLAN_NUDGE_NAME_PREFIX_FOR_TEST);
    }
  });

  it("custom intervals override the default", async () => {
    const result = await schedulePlanNudges({
      sessionKey: "agent:main:user:abc",
      intervals: [5, 15],
      deps: { callGatewayTool: mockCallGatewayTool, now: () => FIXED_NOW },
    });
    expect(result).toHaveLength(2);
    expect(result[0].fireAtMs - FIXED_NOW).toBe(5 * 60_000);
    expect(result[1].fireAtMs - FIXED_NOW).toBe(15 * 60_000);
  });

  it("non-positive / non-finite intervals are skipped", async () => {
    const result = await schedulePlanNudges({
      sessionKey: "agent:main:user:abc",
      intervals: [0, -5, NaN, Infinity, 10],
      deps: { callGatewayTool: mockCallGatewayTool, now: () => FIXED_NOW },
    });
    expect(result).toHaveLength(1);
    expect(result[0].fireAtMs - FIXED_NOW).toBe(10 * 60_000);
  });

  it("per-cron schedule failures are tolerated (returns partial success)", async () => {
    let attempt = 0;
    const flaky: typeof mockCallGatewayTool = vi.fn(async (_method, _opts, params) => {
      attempt += 1;
      if (attempt === 2) {
        throw new Error("simulated cron.add failure");
      }
      const p = params as { name?: string };
      return { jobId: `id-${attempt}:${p.name ?? ""}` };
    });
    const warnings: string[] = [];
    const result = await schedulePlanNudges({
      sessionKey: "k",
      deps: { callGatewayTool: flaky, now: () => FIXED_NOW },
      log: { warn: (m) => warnings.push(m) },
    });
    expect(result).toHaveLength(2); // 1st + 3rd succeeded; 2nd failed
    expect(warnings.some((w) => w.includes("simulated cron.add failure"))).toBe(true);
  });

  it("missing jobId in response is logged and skipped", async () => {
    const noId: typeof mockCallGatewayTool = vi.fn(async () => ({
      /* no jobId */
    }));
    const warnings: string[] = [];
    const result = await schedulePlanNudges({
      sessionKey: "k",
      intervals: [10],
      deps: { callGatewayTool: noId, now: () => FIXED_NOW },
      log: { warn: (m) => warnings.push(m) },
    });
    expect(result).toHaveLength(0);
    expect(warnings.some((w) => w.includes("jobId missing"))).toBe(true);
  });

  it("accepts cron.add responses shaped as { id }", async () => {
    const idShape: typeof mockCallGatewayTool = vi.fn(async () => ({ id: "job-id-direct" }));
    const result = await schedulePlanNudges({
      sessionKey: "k",
      intervals: [10],
      deps: { callGatewayTool: idShape, now: () => FIXED_NOW },
    });
    expect(result).toEqual([{ jobId: "job-id-direct", fireAtMs: FIXED_NOW + 10 * 60_000 }]);
  });

  it("accepts cron.add responses shaped as { job: { id } }", async () => {
    const nestedShape: typeof mockCallGatewayTool = vi.fn(async () => ({
      job: { id: "job-id-nested" },
    }));
    const result = await schedulePlanNudges({
      sessionKey: "k",
      intervals: [10],
      deps: { callGatewayTool: nestedShape, now: () => FIXED_NOW },
    });
    expect(result).toEqual([{ jobId: "job-id-nested", fireAtMs: FIXED_NOW + 10 * 60_000 }]);
  });

  it("agentId is forwarded when provided", async () => {
    await schedulePlanNudges({
      sessionKey: "k",
      agentId: "main",
      intervals: [10],
      deps: { callGatewayTool: mockCallGatewayTool, now: () => FIXED_NOW },
    });
    expect(calls[0]?.params).toMatchObject({ agentId: "main" });
  });

  it("forwards the active planCycleId into the cron payload when provided", async () => {
    await schedulePlanNudges({
      sessionKey: "k",
      planCycleId: "cycle-123",
      intervals: [10],
      deps: { callGatewayTool: mockCallGatewayTool, now: () => FIXED_NOW },
    });

    expect(calls[0]?.params).toMatchObject({
      payload: {
        kind: "agentTurn",
        planCycleId: "cycle-123",
      },
    });
  });

  it("skips scheduling when the sessionKey fails cron sessionTarget validation", async () => {
    const warnings: string[] = [];
    const result = await schedulePlanNudges({
      sessionKey: "bad/session/key",
      intervals: [10],
      deps: { callGatewayTool: mockCallGatewayTool, now: () => FIXED_NOW },
      log: { warn: (message) => warnings.push(message) },
    });

    expect(result).toEqual([]);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(
      warnings.some((message) => message.includes("fails cron sessionTarget validation")),
    ).toBe(true);
  });
});

describe("cleanupPlanNudges (Wave B3)", () => {
  it("removes each id via cron.remove", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const mock = vi.fn(async (method, _opts, params) => {
      calls.push({ method, params });
      return {};
    });
    const result = await cleanupPlanNudges({
      jobIds: ["a", "b", "c"],
      deps: { callGatewayTool: mock },
    });
    expect(result).toEqual({ removed: 3, failed: 0 });
    expect(calls).toEqual([
      { method: "cron.remove", params: { id: "a" } },
      { method: "cron.remove", params: { id: "b" } },
      { method: "cron.remove", params: { id: "c" } },
    ]);
  });

  it("tolerates per-id failures and returns counts", async () => {
    let attempt = 0;
    const mock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 2) {
        throw new Error("nope");
      }
      return {};
    });
    const warnings: string[] = [];
    const result = await cleanupPlanNudges({
      jobIds: ["a", "b", "c"],
      deps: { callGatewayTool: mock },
      log: { warn: (m) => warnings.push(m) },
    });
    expect(result).toEqual({ removed: 2, failed: 1 });
    expect(warnings).toHaveLength(1);
  });

  it("empty jobIds is a no-op", async () => {
    const mock = vi.fn();
    const result = await cleanupPlanNudges({
      jobIds: [],
      deps: { callGatewayTool: mock as never },
    });
    expect(result).toEqual({ removed: 0, failed: 0 });
    expect(mock).not.toHaveBeenCalled();
  });
});
