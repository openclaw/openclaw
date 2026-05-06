import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const lifecycleMocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
  runSubagentEnded: vi.fn(async () => {}),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: lifecycleMocks.getGlobalHookRunner,
}));
function createRunEntry(): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child-1",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "task",
    cleanup: "keep",
    createdAt: Date.now(),
  };
}

describe("emitSubagentEndedHookOnce", () => {
  let mod: typeof import("./subagent-registry-completion.js");

  const createEmitParams = (
    overrides?: Partial<Parameters<typeof mod.emitSubagentEndedHookOnce>[0]>,
  ) => {
    const entry = overrides?.entry ?? createRunEntry();
    return {
      entry,
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      accountId: "acct-1",
      inFlightRunIds: new Set<string>(),
      persist: vi.fn(),
      ...overrides,
    };
  };

  const readLastSubagentEndedEvent = () => {
    const calls = lifecycleMocks.runSubagentEnded.mock.calls as unknown as Array<
      [
        {
          final?: {
            frozenResultTextAvailable: true;
            textSha256: string;
            byteLength: number;
            capturedAt?: number;
          };
        },
      ]
    >;
    const event = calls.at(-1)?.[0];
    expect(event).toBeDefined();
    return event!;
  };

  beforeAll(async () => {
    mod = await import("./subagent-registry-completion.js");
  });

  beforeEach(() => {
    lifecycleMocks.getGlobalHookRunner.mockClear();
    lifecycleMocks.runSubagentEnded.mockClear();
  });

  it("treats timing differences as different only after both outcomes have timing", () => {
    expect(
      mod.runOutcomesEqual(
        { status: "timeout", startedAt: 1_000, endedAt: 2_000, elapsedMs: 1_000 },
        { status: "timeout", startedAt: 1_000, endedAt: 2_500, elapsedMs: 1_500 },
      ),
    ).toBe(false);
    expect(
      mod.runOutcomesEqual(
        { status: "error", error: "boom", startedAt: 1_000, endedAt: 2_000, elapsedMs: 1_000 },
        { status: "error", error: "boom", startedAt: 1_000, endedAt: 2_000, elapsedMs: 1_000 },
      ),
    ).toBe(true);
    expect(
      mod.runOutcomesEqual(
        { status: "ok", startedAt: 1_000, endedAt: 2_000, elapsedMs: 1_000 },
        { status: "ok" },
      ),
    ).toBe(true);
    expect(
      mod.shouldUpdateRunOutcome(
        { status: "ok" },
        { status: "ok", startedAt: 1_000, endedAt: 2_000, elapsedMs: 1_000 },
      ),
    ).toBe(true);
    expect(
      mod.shouldUpdateRunOutcome(
        { status: "ok", startedAt: 1_000, endedAt: 2_000, elapsedMs: 1_000 },
        { status: "ok" },
      ),
    ).toBe(false);
  });

  it("records ended hook marker even when no subagent_ended hooks are registered", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => false,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const params = createEmitParams();
    const emitted = await mod.emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(typeof params.entry.endedHookEmittedAt).toBe("number");
    expect(params.persist).toHaveBeenCalledTimes(1);
  });

  it("runs subagent_ended hooks when available", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const params = createEmitParams();
    const emitted = await mod.emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(lifecycleMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(typeof params.entry.endedHookEmittedAt).toBe("number");
    expect(params.persist).toHaveBeenCalledTimes(1);
  });

  it("includes privacy-minimal frozen final metadata on subagent_ended", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const finalText = "  child final answer 雪🚀  \n";
    const capturedAt = Date.now() - 100;
    const entry = {
      ...createRunEntry(),
      frozenResultText: finalText,
      frozenResultCapturedAt: capturedAt,
    };
    const params = createEmitParams({ entry });
    const emitted = await mod.emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(lifecycleMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const event = readLastSubagentEndedEvent();
    expect(event).toMatchObject({
      final: {
        frozenResultTextAvailable: true,
        textSha256: createHash("sha256").update(finalText, "utf8").digest("hex"),
        byteLength: Buffer.byteLength(finalText, "utf8"),
        capturedAt,
      },
    });
    expect(event?.final?.textSha256).not.toBe(
      createHash("sha256").update(finalText.trim(), "utf8").digest("hex"),
    );
    expect(JSON.stringify(event)).not.toContain(finalText);
  });

  it("includes frozen final metadata when capture timestamp is missing", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const finalText = "final without timestamp";
    const entry = {
      ...createRunEntry(),
      frozenResultText: finalText,
    };
    const params = createEmitParams({ entry });
    const emitted = await mod.emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    const event = readLastSubagentEndedEvent();
    expect(event.final).toEqual({
      frozenResultTextAvailable: true,
      textSha256: createHash("sha256").update(finalText, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(finalText, "utf8"),
    });
  });

  it("omits frozen final metadata when no useful final text was captured", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const params = createEmitParams({
      entry: {
        ...createRunEntry(),
        frozenResultText: "   ",
        frozenResultCapturedAt: Date.now(),
      },
    });
    const emitted = await mod.emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    const event = readLastSubagentEndedEvent();
    expect(event.final).toBeUndefined();
  });

  it("returns false when the global hook runner is not initialized yet", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue(null);

    const params = createEmitParams();
    const emitted = await mod.emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(false);
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(params.persist).not.toHaveBeenCalled();
    expect(params.entry.endedHookEmittedAt).toBeUndefined();
  });

  it("returns false when runId is blank", async () => {
    const params = createEmitParams({
      entry: { ...createRunEntry(), runId: "   " },
    });
    const emitted = await mod.emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when ended hook marker already exists", async () => {
    const params = createEmitParams({
      entry: { ...createRunEntry(), endedHookEmittedAt: Date.now() },
    });
    const emitted = await mod.emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when runId is already in flight", async () => {
    const entry = createRunEntry();
    const inFlightRunIds = new Set<string>([entry.runId]);
    const params = createEmitParams({ entry, inFlightRunIds });
    const emitted = await mod.emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when subagent hook execution throws", async () => {
    lifecycleMocks.runSubagentEnded.mockRejectedValueOnce(new Error("boom"));
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const entry = createRunEntry();
    const inFlightRunIds = new Set<string>();
    const params = createEmitParams({ entry, inFlightRunIds });
    const emitted = await mod.emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(inFlightRunIds.has(entry.runId)).toBe(false);
    expect(entry.endedHookEmittedAt).toBeUndefined();
  });
});
