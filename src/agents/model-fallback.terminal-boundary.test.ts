import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteTranscriptMutationConflictError } from "../config/sessions/session-mutation-conflict-error.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { GatewayDrainingError } from "../process/gateway-work-admission.js";
import {
  AgentRunTerminalOutcomeError,
  findAgentRunTerminalOutcome,
} from "./agent-run-terminal-error.js";
import { createCliOutputFailoverError } from "./cli-runner/output-error.js";
import {
  FailoverError,
  coerceToFailoverError,
  describeFailoverError,
  findCliTerminalStopError,
  findCliTimeoutError,
  resolveModelFallbackError,
} from "./failover-error.js";
import { GitHubCredentialLookupError } from "./github-read-identity.js";
import { AgentHarnessPreflightError, recordAgentHarnessPreflightOwner } from "./harness/errors.js";
import {
  type ModelFallbackStepHandler,
  runFallbackAttempt,
  shouldDiscardDeferredSessionSuspension,
} from "./model-fallback-attempt.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { recordModelFallbackStop as recordLightweightStop } from "./model-fallback-stop.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";
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

it.each([
  PreparedModelRuntimePublicationSupersededError,
  PreparedModelRuntimeOwnerNotPublishedError,
])("does not rotate providers after %s", async (ErrorType) => {
  await expectTerminalStop(new ErrorType("fixture prepared runtime publication failed"));
});

it("does not rotate providers when SQLite worker capacity is exhausted", async () => {
  await expectTerminalStop(
    new SqliteWorkerError("SQLite worker store capacity reached", "overloaded"),
  );
});

it("does not consult provider policy or rotate models for a transcript conflict", async () => {
  const error = new SqliteTranscriptMutationConflictError("conflicting-session");
  await expectTerminalStop(error);
  await expectTerminalStop(new Error("worker operation failed", { cause: error }));
});

it.each([
  { status: 503, wrapper: "direct", configured: false },
  { status: 503, wrapper: "direct", configured: true },
  { status: 403, wrapper: "direct", configured: true },
  { status: 503, wrapper: "aggregate", configured: true },
] as const)(
  "preserves credential lookup $status/$wrapper with fallbacks configured=$configured",
  async ({ status, wrapper, configured }) => {
    providerHook.mockReturnValue(undefined);
    const lookup = new GitHubCredentialLookupError({
      lookupId: "11111111-1111-4111-8111-111111111111",
      clientStage: "broker",
      clientCode: "http_rejected",
      httpStatus: status,
    });
    const error = wrapper === "direct" ? lookup : new AggregateError([lookup], "intent failed");
    await expectTerminalStop(error, {
      fallbacksOverride: configured ? fallbackOptions.fallbacksOverride : [],
    });
    expect(resolveModelFallbackError(error)).toEqual({ kind: "coordination", error });
    expect(
      coerceToFailoverError(error, { provider: "fixture-provider", model: "fixture-model" }),
    ).toBeNull();
    expect(describeFailoverError(error).reason).toBeUndefined();
    expect(lookup.diagnostic.httpStatus).toBe(status);
  },
);

it.each([
  { status: 408, reason: "timeout" },
  { status: 503, reason: "server_error" },
  { status: 503, reason: "server_error", name: "GitHubCredentialLookupError" },
  { status: 429, reason: "rate_limit" },
  { status: 403, reason: "auth" },
] as const)("retains genuine provider $status fallback as $reason", async (fixture) => {
  const { status, reason } = fixture;
  providerHook.mockReturnValue(undefined);
  const error = Object.assign(new Error(`HTTP ${status}`), { status });
  if ("name" in fixture && fixture.name !== undefined) {
    error.name = fixture.name;
  }
  const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("recovered");
  const onError = vi.fn();
  await expect(runWithModelFallback({ ...fallbackOptions, run, onError })).resolves.toMatchObject({
    outcome: "completed",
    result: "recovered",
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledOnce();
  expect(onError.mock.calls[0]?.[0].error).toMatchObject({ reason, status });
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

it("does not replay a recorded stop returned by result classification", async () => {
  const error = new AggregateError([recordedStop()], "wrapper");
  const run = vi.fn().mockResolvedValue("partial result");
  await expectTerminalStop(error, { classifyResult: () => ({ error }) }, run);
});

it("stops image fallback after a recorded stop", async () => {
  const error = new AggregateError([recordedStop()], "wrapper");
  const run = vi.fn().mockRejectedValue(error);
  const imageModel = {
    primary: "fixture-provider/fixture-model",
    fallbacks: fallbackOptions.fallbacksOverride,
  };
  await expect(
    runWithImageModelFallback({
      cfg: { agents: { defaults: { imageModel } } },
      run,
    }),
  ).rejects.toBe(error);
  expect(run).toHaveBeenCalledOnce();
  expect(providerHook).not.toHaveBeenCalled();
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

it("preserves coordination precedence over a recorded terminal stop", () => {
  const error = new AggregateError([maxTurns(), new GatewayDrainingError()], "wrapper");
  expect(resolveModelFallbackError(error)).toEqual({ kind: "coordination", error });
  expect(shouldDiscardDeferredSessionSuspension({ error })).toBe(true);
  expect(providerHook).not.toHaveBeenCalled();
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

it("does not infer settlement ownership from display text", () => {
  expect(
    isSessionPlacementSettlementClosedError(
      new Error("session placement turn settlement is closed"),
    ),
  ).toBe(false);
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

it("does not infer terminal outcomes from untyped fields or cyclic wrappers", () => {
  const wrapper = { cause: undefined as unknown, terminalOutcome: { status: "timeout" } };
  wrapper.cause = wrapper;
  expect(findAgentRunTerminalOutcome(wrapper)).toBeUndefined();
  expect(findAgentRunTerminalOutcome(null)).toBeUndefined();
});
