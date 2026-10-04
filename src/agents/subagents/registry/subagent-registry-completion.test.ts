/**
 * Regression coverage for subagent completion bookkeeping.
 * Verifies outcome comparison and exactly-once lifecycle hook emission.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const lifecycleMocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
  runSubagentEnded: vi.fn(async () => {}),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
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
    execution: { status: "running" },
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
      inFlightOwners: new Set<object>(),
      recordEmitted: vi.fn(() => {
        entry.endedHookEmittedAt = Date.now();
      }),
      ...overrides,
    };
  };

  beforeAll(async () => {
    mod = await import("./subagent-registry-completion.js");
  });

  beforeEach(() => {
    lifecycleMocks.getGlobalHookRunner.mockClear();
    lifecycleMocks.runSubagentEnded.mockClear();
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
    expect(params.recordEmitted).toHaveBeenCalledTimes(1);
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
    expect(params.recordEmitted).toHaveBeenCalledTimes(1);
  });

  it("returns false when the global hook runner is not initialized yet", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue(null);

    const params = createEmitParams();
    const emitted = await mod.emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(false);
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(params.recordEmitted).not.toHaveBeenCalled();
    expect(params.entry.endedHookEmittedAt).toBeUndefined();
  });

  it("returns false when runId is blank", async () => {
    const params = createEmitParams({
      entry: { ...createRunEntry(), runId: "   " },
    });
    const emitted = await mod.emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.recordEmitted).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when ended hook marker already exists", async () => {
    const params = createEmitParams({
      entry: { ...createRunEntry(), endedHookEmittedAt: Date.now() },
    });
    const emitted = await mod.emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.recordEmitted).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when the execution owner is already in flight", async () => {
    const entry = createRunEntry();
    const inFlightOwners = new Set<object>([getSubagentRunRuntimeKey(entry)]);
    const params = createEmitParams({ entry, inFlightOwners });
    const emitted = await mod.emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.recordEmitted).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when subagent hook execution throws", async () => {
    lifecycleMocks.runSubagentEnded.mockRejectedValueOnce(new Error("boom"));
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const entry = createRunEntry();
    const inFlightOwners = new Set<object>();
    const params = createEmitParams({ entry, inFlightOwners });
    const emitted = await mod.emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(false);
    expect(params.recordEmitted).not.toHaveBeenCalled();
    expect(inFlightOwners.has(getSubagentRunRuntimeKey(entry))).toBe(false);
    expect(entry.endedHookEmittedAt).toBeUndefined();
  });

  it.each(["committed", "refused", "unknown"] as const)(
    "joins the ended-hook stamp and retains the emitted fact when %s",
    async (outcome) => {
      lifecycleMocks.getGlobalHookRunner.mockReturnValue({
        hasHooks: () => true,
        runSubagentEnded: lifecycleMocks.runSubagentEnded,
      });
      const entered = createDeferred();
      const write = createDeferred();
      const failure =
        outcome === "unknown"
          ? new SqliteWorkerError("Hook stamp acknowledgement lost", "outcome-unknown")
          : new Error("Hook stamp refused before commit");
      const params = createEmitParams({
        recordEmitted: vi.fn(() => {
          params.entry.endedHookEmittedAt = Date.now();
          entered.resolve();
          return write.promise;
        }),
      });
      const pending = mod.emitSubagentEndedHookOnce(params).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      expect(params.inFlightOwners.has(getSubagentRunRuntimeKey(params.entry))).toBe(true);
      expect(params.entry.endedHookEmittedAt).toEqual(expect.any(Number));
      await expect(mod.emitSubagentEndedHookOnce(params)).resolves.toBe(false);
      if (outcome === "committed") {
        write.resolve();
      } else {
        write.reject(failure);
      }
      expect(await pending).toEqual(
        outcome === "unknown" ? { error: failure } : { result: outcome === "committed" },
      );
      expect(params.inFlightOwners.has(getSubagentRunRuntimeKey(params.entry))).toBe(false);
      expect(params.entry.endedHookEmittedAt).toEqual(expect.any(Number));
      await expect(mod.emitSubagentEndedHookOnce(params)).resolves.toBe(false);
      expect(lifecycleMocks.runSubagentEnded).toHaveBeenCalledOnce();
      expect(params.recordEmitted).toHaveBeenCalledOnce();
    },
  );
});
