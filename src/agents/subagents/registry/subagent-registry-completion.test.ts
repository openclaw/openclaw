import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { emitSubagentEndedHookOnce } from "./subagent-registry-completion.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const lifecycleMocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
  runSubagentEnded: vi.fn(async () => {}),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: lifecycleMocks.getGlobalHookRunner,
}));

const createEmitParams = (overrides?: Partial<Parameters<typeof emitSubagentEndedHookOnce>[0]>) => {
  const entry = overrides?.entry ?? createSubagentRunRecord({ runId: "run-1" });
  return {
    entry,
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    inFlightOwners: new Set<object>(),
    recordEmitted: vi.fn(() => {
      entry.endedHookEmittedAt = Date.now();
    }),
    ...overrides,
  };
};

beforeEach(() => {
  lifecycleMocks.getGlobalHookRunner.mockClear();
  lifecycleMocks.runSubagentEnded.mockClear();
});

it.each([null, { hasHooks: () => false, runSubagentEnded: lifecycleMocks.runSubagentEnded }])(
  "leaves completion unmarked with an unavailable hook runner: %j",
  async (runner) => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue(runner);
    const params = createEmitParams();
    expect(await emitSubagentEndedHookOnce(params)).toBe(false);
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(params.recordEmitted).not.toHaveBeenCalled();
    expect(params.entry.endedHookEmittedAt).toBeUndefined();
  },
);

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
    const pending = emitSubagentEndedHookOnce(params).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await entered.promise;
    expect(params.inFlightOwners.has(getSubagentRunRuntimeKey(params.entry))).toBe(true);
    expect(params.entry.endedHookEmittedAt).toEqual(expect.any(Number));
    await expect(emitSubagentEndedHookOnce(params)).resolves.toBe(false);
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
    await expect(emitSubagentEndedHookOnce(params)).resolves.toBe(false);
    expect(lifecycleMocks.runSubagentEnded).toHaveBeenCalledOnce();
    expect(params.recordEmitted).toHaveBeenCalledOnce();
  },
);
