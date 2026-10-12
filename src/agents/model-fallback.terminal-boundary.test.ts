import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteTranscriptMutationConflictError } from "../config/sessions/session-mutation-conflict-error.js";
import {
  AgentRunTerminalOutcomeError,
  findAgentRunTerminalOutcome,
} from "./agent-run-terminal-error.js";
import { createCliOutputFailoverError } from "./cli-runner/output-error.js";
import {
  FailoverError,
  findCliTerminalStopError,
  findCliTimeoutError,
  resolveModelFallbackError,
} from "./failover-error.js";
import { AgentHarnessPreflightError, recordAgentHarnessPreflightOwner } from "./harness/errors.js";
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

it("does not replay an unscoped preflight subclass on another model", async () => {
  class PolicyRefusal extends AgentHarnessPreflightError {}
  await expectTerminalStop(
    new PolicyRefusal("handoff refused", {
      cause: new FailoverError("529 overloaded", { reason: "overloaded", status: 529 }),
    }),
  );
});

it.each([PreparedModelRuntimePublicationSupersededError])(
  "does not rotate providers after %s",
  async (ErrorType) => {
    await expectTerminalStop(new ErrorType("fixture prepared runtime publication failed"));
  },
);

it("does not consult provider policy or rotate models for a transcript conflict", async () => {
  const error = new SqliteTranscriptMutationConflictError("conflicting-session");
  await expectTerminalStop(error);
  await expectTerminalStop(new Error("worker operation failed", { cause: error }));
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

it.each([
  {
    name: "lightweight stop in a cyclic aggregate",
    make: () => {
      const error = {
        message: "wrapper",
        cause: undefined as unknown,
        errors: [{ error: recordedStop() }],
      };
      error.cause = error;
      return error;
    },
  },
  { name: "recorded supersession", make: createAgentRunSupersededAbortError },
])("does not replay $name", async ({ make }) => {
  const error = make();
  expect(resolveModelFallbackError(error)).toEqual({ kind: "terminal", error });
  await expectTerminalStop(error);
});

it("records a CLI max-turn stop before provider policy can replace it with a retryable error", async () => {
  const run = vi.fn(async () => {
    const error = createCliOutputFailoverError({
      output: {
        text: "",
        errorText: "Reached maximum number of turns (1)",
        terminalFailure: { reason: "max_turns", limit: 1 },
      },
      provider: "fixture-provider",
      model: "fixture-model",
    });
    assert(error instanceof FailoverError);
    throw error;
  });
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

it("preserves the typed marker behind a hostile sibling accessor", async () => {
  const wrapper = Object.defineProperty(
    { errors: [createSessionPlacementSettlementClosedAbortError()] },
    "cause",
    {
      get() {
        throw new Error("opaque cause");
      },
    },
  );
  expect(isSessionPlacementSettlementClosedError(wrapper)).toBe(true);
  expect(shouldDiscardDeferredSessionSuspension({ error: wrapper })).toBe(true);
  await expectTerminalStop(wrapper);
});

it("discovers a canonical timeout beside an opaque cause and a settlement closure", async () => {
  const timeout = new AgentRunTerminalOutcomeError(new Error("timeout"), {
    status: "timeout",
    reason: "hard_timeout",
  });
  const wrapper = Object.defineProperty(
    { errors: [createSessionPlacementSettlementClosedAbortError(), timeout] },
    "cause",
    {
      get() {
        throw new Error("opaque cause");
      },
    },
  );
  expect(findAgentRunTerminalOutcome(wrapper)).toBe(timeout.terminalOutcome);
  expect(shouldDiscardDeferredSessionSuspension({ error: wrapper })).toBe(true);
  await expectTerminalStop(wrapper);
});
