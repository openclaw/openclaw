import { parseModelRef } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toQaError } from "./errors.js";
import type { runScenarioFlow as RunScenarioFlow } from "./scenario-flow-runner.js";
import {
  createQaSuiteRuntimeFlowTestEnv,
  qaSuiteRuntimeFlowTestConstants,
} from "./suite-runtime-flow.test-support.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

const createQaScenarioRuntimeApi = vi.hoisted(() => vi.fn());
const runScenarioFlow = vi.hoisted(() =>
  vi.fn<typeof RunScenarioFlow>(async ({ scenarioTitle }) => ({
    name: scenarioTitle,
    status: "pass",
    steps: [],
  })),
);

vi.mock("./scenario-runtime-api.js", () => ({ createQaScenarioRuntimeApi }));
vi.mock("./scenario-flow-runner.js", () => ({ runScenarioFlow }));

import { runQaSuiteScenarioDefinition, runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("qa suite runtime flow cancellation", () => {
  it.each(["preparation", "action"])(
    "joins held %s cleanup after parent cancellation before returning",
    async (phase) => {
      const controller = new AbortController();
      const entered = createDeferred<void>();
      const cleaning = createDeferred<void>();
      const released = createDeferred<void>();
      const laterAction = vi.fn();
      const ownedOperation = async (signal: AbortSignal) => {
        try {
          entered.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(toQaError(signal.reason)), {
              once: true,
            });
          });
        } finally {
          cleaning.resolve();
          await released.promise;
        }
      };
      const env = {
        ...createQaSuiteRuntimeFlowTestEnv({
          prepareFlow: async ({ signal }) => {
            if (phase === "preparation") {
              await ownedOperation(signal!);
            }
          },
        }),
        signal: controller.signal,
      };
      createQaScenarioRuntimeApi.mockImplementationOnce(
        (params: { deps: { runScenario: typeof runQaSuiteScenarioSteps } }) => ({
          runScenario: params.deps.runScenario,
        }),
      );
      runScenarioFlow.mockImplementationOnce(async (params) => {
        const api = params.api as {
          runScenario: typeof runQaSuiteScenarioSteps;
          signal: AbortSignal;
        };
        return api.runScenario("Parent cancellation", [
          { name: "Pending action", run: () => ownedOperation(api.signal) },
          { name: "Must not send", run: laterAction },
        ]);
      });
      const pending = runQaSuiteScenarioDefinition({
        env,
        scenario: makeQaSuiteTestScenario("parent-cancellation", { config: {} }),
        runScenario: runQaSuiteScenarioSteps,
        splitModelRef: (raw) => parseModelRef(raw, "openai"),
        formatErrorMessage: String,
        liveTurnTimeoutMs: () => 60_000,
        resolveQaLiveTurnTimeoutMs: () => 60_000,
        constants: qaSuiteRuntimeFlowTestConstants,
      });
      const settled = vi.fn();
      void pending.then(settled, settled);
      try {
        await entered.promise;
        controller.abort(new Error("Lab stopping"));
        await cleaning.promise;
        expect(settled).not.toHaveBeenCalled();
        expect(laterAction).not.toHaveBeenCalled();
        released.resolve();
        await expect(pending).resolves.toMatchObject({ status: "fail", details: "Lab stopping" });
        expect(laterAction).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        released.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );

  it.each([false, true])(
    "preserves the operation failure with parent cancellation=%s",
    async (cancelled) => {
      const controller = new AbortController();
      const entered = createDeferred<void>();
      const released = createDeferred<void>();
      const operationFailure = new Error("cleanup failed");
      const cancellation = new Error("Lab stopping");
      const env = { ...createQaSuiteRuntimeFlowTestEnv(), signal: controller.signal };
      createQaScenarioRuntimeApi.mockImplementationOnce(
        (params: { deps: { runScenario: typeof runQaSuiteScenarioSteps } }) => ({
          runScenario: params.deps.runScenario,
        }),
      );
      runScenarioFlow.mockImplementationOnce(async (params) => {
        const api = params.api as { runScenario: typeof runQaSuiteScenarioSteps };
        return api.runScenario("Failed operation", [
          {
            name: "Held operation",
            run: async () => {
              entered.resolve();
              await released.promise;
              throw operationFailure;
            },
          },
        ]);
      });
      const pending = runQaSuiteScenarioDefinition({
        env,
        scenario: makeQaSuiteTestScenario("failed-operation", { config: {} }),
        runScenario: async (name, steps) => {
          for (const step of steps) {
            await step.run();
          }
          return { name, status: "pass", steps: [] };
        },
        splitModelRef: (raw) => parseModelRef(raw, "openai"),
        formatErrorMessage: String,
        liveTurnTimeoutMs: () => 60_000,
        resolveQaLiveTurnTimeoutMs: () => 60_000,
        constants: qaSuiteRuntimeFlowTestConstants,
      }).catch((error: unknown) => error);
      await entered.promise;
      if (cancelled) {
        controller.abort(cancellation);
      }
      released.resolve();
      const failure = await pending;
      if (cancelled) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({
          cause: cancellation,
          errors: [cancellation, operationFailure],
        });
      } else {
        expect(failure).toBe(operationFailure);
      }
    },
  );

  it("observes late transport rejection without aborting a completed flow", async () => {
    const health = createDeferred<Error>();
    const env = createQaSuiteRuntimeFlowTestEnv({ whenUnhealthy: health.promise });
    createQaScenarioRuntimeApi.mockReturnValueOnce({});
    await runQaSuiteScenarioDefinition({
      env,
      scenario: makeQaSuiteTestScenario("completed-flow", { config: {} }),
      runScenario: runQaSuiteScenarioSteps,
      splitModelRef: (raw) => parseModelRef(raw, "openai"),
      formatErrorMessage: String,
      liveTurnTimeoutMs: () => 60_000,
      resolveQaLiveTurnTimeoutMs: () => 60_000,
      constants: qaSuiteRuntimeFlowTestConstants,
    });
    const signal = runScenarioFlow.mock.calls[0]?.[0].api.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    health.reject(new Error("transport stopped after completion"));
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
  });
});
