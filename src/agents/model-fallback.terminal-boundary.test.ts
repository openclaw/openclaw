import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEntryChangedDuringReadError } from "../config/sessions/session-entry-read-errors.js";
import {
  decodeSessionTranscriptWorkerReadError,
  encodeSessionTranscriptWorkerError,
  sessionHistoryCleanupError,
} from "../config/sessions/session-history-worker-errors.js";
import { SqliteTranscriptMutationConflictError } from "../config/sessions/session-mutation-conflict-error.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence-error.js";
import { SessionWorkStartChangedError } from "../config/sessions/work-start-error.js";
import { WorkerNodeLostError } from "../worker/worker-node-loss.js";
import {
  AgentRunTerminalOutcomeError,
  findAgentRunTerminalOutcome,
} from "./agent-run-terminal-error.js";
import {
  FailoverError,
  findCliTerminalStopError,
  findCliTimeoutError,
  resolveModelFallbackError,
} from "./failover-error.js";
import {
  AgentHarnessPreflightError,
  recordAgentHarnessPreflightOwner,
  SessionControllerAdmissionRequiredError,
} from "./harness/errors.js";
import {
  type ModelFallbackStepHandler,
  runFallbackAttempt,
  shouldDiscardDeferredSessionSuspension,
} from "./model-fallback-attempt.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { recordModelFallbackStop as recordLightweightStop } from "./model-fallback-stop.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  createSessionPlacementSettlementClosedAbortError,
  isSessionPlacementSettlementClosedError,
  createAgentRunSupersededAbortError,
} from "./run-termination.js";

const { providerHook } = vi.hoisted(() => ({
  providerHook: vi.fn<() => "overloaded" | undefined>(),
}));
vi.mock("../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: providerHook,
}));
beforeEach(() => {
  providerHook.mockReset().mockImplementation(() => {
    throw new Error("unexpected provider policy consultation");
  });
});
const fallbackOptions = {
  cfg: undefined,
  provider: "fixture-provider",
  model: "fixture-model",
  manifestPlugins: [],
  fallbacksOverride: ["fixture-next/fixture-model"],
};
function maxTurns() {
  return new FailoverError("recorded terminal stop", { reason: "unknown", code: "cli_max_turns" });
}
function recordedStop() {
  const error = Object.freeze(new Error("401 invalid API key"));
  recordLightweightStop(error);
  return error;
}
function cyclicRecordedStop() {
  const wrapper = { cause: undefined as unknown, errors: [{ error: recordedStop() }] };
  wrapper.cause = wrapper;
  return wrapper;
}
function withOpaqueCause(errors: unknown[]) {
  return Object.defineProperty({ errors }, "cause", {
    get() {
      throw new Error("opaque cause");
    },
  });
}
async function expectTerminalStop(
  error: unknown,
  options: Partial<Parameters<typeof runWithModelFallback>[0]> = {},
  run = vi.fn().mockRejectedValue(error),
) {
  const onError = vi.fn();
  const onFallbackStep = vi.fn();
  await expect(
    runWithModelFallback({ ...fallbackOptions, run, onError, onFallbackStep, ...options }),
  ).rejects.toBe(error);
  expect(run).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(onFallbackStep).not.toHaveBeenCalled();
  expect(providerHook).not.toHaveBeenCalled();
}

class PolicyRefusal extends AgentHarnessPreflightError {}
const transcriptConflict = () => new SqliteTranscriptMutationConflictError("conflicting-session");
function transportedSessionReadFailure() {
  const failure = encodeSessionTranscriptWorkerError(
    sessionHistoryCleanupError(
      new SessionEntryChangedDuringReadError(),
      new Error("reader cleanup failed"),
      "worker retirement",
    ),
  );
  if (!failure) {
    throw new Error("Expected a serializable session read failure");
  }
  return decodeSessionTranscriptWorkerReadError(failure);
}
it.each([
  [
    "unscoped preflight",
    () =>
      new PolicyRefusal("handoff refused", {
        cause: new FailoverError("529 overloaded", { reason: "overloaded", status: 529 }),
      }),
    false,
  ],
  ["missing controller admission", () => new SessionControllerAdmissionRequiredError(), false],
  [
    "superseded publication",
    () => new PreparedModelRuntimePublicationSupersededError("publication failed"),
    false,
  ],
  ["transcript conflict", transcriptConflict, false],
  ["session read failure through worker cleanup transport", transportedSessionReadFailure, false],
  [
    "transcript admission identity change",
    () =>
      new SessionTranscriptReadFenceError(
        "Current-turn transcript admission identity changed: fixture",
      ),
    false,
  ],
  [
    "session reader invalidation",
    () =>
      new SessionWorkStartChangedError(
        "Session reader operation is no longer current. Retry the turn.",
      ),
    false,
  ],
  [
    "wrapped serialized session invalidation",
    () =>
      new Error("503 overloaded", {
        cause: { code: "SESSION_WORK_START_INVALIDATED", message: "Session work invalidated" },
      }),
    false,
  ],
  [
    "wrapped transcript conflict",
    () => new Error("worker operation failed", { cause: transcriptConflict() }),
    false,
  ],
  ["cyclic recorded stop", cyclicRecordedStop, true],
  ["recorded supersession", createAgentRunSupersededAbortError, true],
  ["node loss with unknown tool effects", () => new WorkerNodeLostError(), true],
] as const)("does not replay %s", async (_name, make, terminal) => {
  const error = make();
  if (terminal) {
    expect(resolveModelFallbackError(error)).toEqual({ kind: "terminal", error });
  }
  await expectTerminalStop(error);
});

it("retains closed ownership when async disposal also fails", async () => {
  const closed = createSessionPlacementSettlementClosedAbortError();
  const produceError = async () => {
    await using lease = {
      [Symbol.asyncDispose]: async () => {
        throw new Error("cleanup failed");
      },
    };
    void lease;
    throw closed;
  };
  const error: unknown = await produceError().catch((caught: unknown) => caught);
  expect(isSessionPlacementSettlementClosedError(error)).toBe(true);
  expect(shouldDiscardDeferredSessionSuspension({ error })).toBe(true);
  await expectTerminalStop(error);
});

it("honors a recorded CLI max-turn stop without consulting provider policy", async () => {
  const run = vi.fn().mockRejectedValue(maxTurns());
  await expect(runWithModelFallback({ ...fallbackOptions, run })).rejects.toMatchObject({
    code: "cli_max_turns",
    reason: "unknown",
  });
  expect(run).toHaveBeenCalledOnce();
  expect(providerHook).not.toHaveBeenCalled();
});

it("honors cancellation before advancing past a captured harness preflight failure", async () => {
  const controller = new AbortController();
  const error = new AgentHarnessPreflightError("harness failed after cancellation", {
    scope: "harness",
  });
  recordAgentHarnessPreflightOwner(error, "fixture-harness");
  const run = vi.fn(async () => {
    controller.abort();
    throw error;
  });
  await expectTerminalStop(error, { abortSignal: controller.signal }, run);
});

it("honors cancellation in the failure callback before starting another candidate", async () => {
  const controller = new AbortController();
  const cancellation = new Error("caller canceled between attempts");
  const run = vi
    .fn()
    .mockRejectedValueOnce(new FailoverError("provider overloaded", { reason: "overloaded" }))
    .mockResolvedValueOnce("unexpected fallback");
  const onError = vi.fn(() => {
    controller.abort(cancellation);
  });
  await expect(
    runWithModelFallback({ ...fallbackOptions, abortSignal: controller.signal, run, onError }),
  ).rejects.toBe(cancellation);
  expect(run).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledOnce();
  expect(providerHook).not.toHaveBeenCalled();
});

it("preserves recovery when its fallback observer rejects", async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce(new FailoverError("provider overloaded", { reason: "overloaded" }))
    .mockResolvedValueOnce("recovered");
  const onError = vi.fn();
  const onFallbackStep = vi.fn<ModelFallbackStepHandler>(() =>
    Promise.reject(new Error("fallback observer failed")),
  );
  await expect(
    runWithModelFallback({ ...fallbackOptions, run, onError, onFallbackStep }),
  ).resolves.toMatchObject({ outcome: "completed", result: "recovered" });
  expect(run).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledOnce();
  expect(onFallbackStep.mock.calls.map(([step]) => step.fallbackStepFinalOutcome)).toEqual([
    "next_fallback",
    "succeeded",
  ]);
});

it("still classifies a genuine provider failure through its hook", async () => {
  providerHook.mockReturnValue("overloaded");
  const result = await runFallbackAttempt({
    run: async () => {
      throw new Error("fixture provider refusal");
    },
    provider: "fixture-provider",
    model: "fixture-model",
    attempts: [],
    attempt: 1,
    total: 2,
  });
  expect(result).toMatchObject({
    error: {
      name: "FailoverError",
      reason: "overloaded",
      provider: "fixture-provider",
      model: "fixture-model",
    },
  });
  expect(providerHook).toHaveBeenCalledOnce();
});

it.each(["throw", "reject"] as const)(
  "propagates a result classifier %s without provider fallback",
  async (kind) => {
    const failure = new Error("result classifier failed");
    const run = vi.fn().mockResolvedValue("provider-result");
    const classifyResult = vi.fn(() => {
      if (kind === "throw") {
        throw failure;
      }
      return Promise.reject(failure);
    });
    await expect(
      runFallbackAttempt({
        run,
        classifyResult,
        provider: "fixture-provider",
        model: "fixture-model",
        attempts: [],
        attempt: 1,
        total: 2,
      }),
    ).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
    expect(classifyResult).toHaveBeenCalledExactlyOnceWith({
      result: "provider-result",
      provider: "fixture-provider",
      model: "fixture-model",
      attempt: 1,
      total: 2,
    });
    expect(providerHook).not.toHaveBeenCalled();
  },
);

describe.each([
  { name: "max turns", find: findCliTerminalStopError, make: maxTurns },
  {
    name: "CLI timeout",
    find: findCliTimeoutError,
    make: () =>
      new FailoverError("timeout", {
        reason: "timeout",
        cliTimeout: {
          mode: "overall",
          timeoutSeconds: 1,
          observedActivity: true,
          activeToolCount: 0,
          backgroundTaskCount: 0,
        },
      }),
  },
])("$name finder", ({ find, make }) => {
  it("preserves depth-first error, cause, then aggregate order through cycles", () => {
    const first = make();
    const second = make();
    const third = make();
    const wrapper = { error: { cause: first }, cause: second, errors: [third] };
    expect(find(wrapper)).toBe(first);
    const cycle = { error: undefined as unknown, cause: wrapper, errors: [third] };
    cycle.error = cycle;
    expect(find(cycle)).toBe(first);
    expect(find({ cause: null, errors: [null, { error: third }] })).toBe(third);
  });
});

it.each([false, true])(
  "preserves an opaque settlement closure with timeout=%s",
  async (withTimeout) => {
    const timeout = new AgentRunTerminalOutcomeError(new Error("timeout"), {
      status: "timeout",
      reason: "hard_timeout",
    });
    const wrapper = withOpaqueCause([
      createSessionPlacementSettlementClosedAbortError(),
      ...(withTimeout ? [timeout] : []),
    ]);
    expect(isSessionPlacementSettlementClosedError(wrapper)).toBe(true);
    if (withTimeout) {
      expect(findAgentRunTerminalOutcome(wrapper)).toBe(timeout.terminalOutcome);
    }
    expect(shouldDiscardDeferredSessionSuspension({ error: wrapper })).toBe(true);
    await expectTerminalStop(wrapper);
  },
);
