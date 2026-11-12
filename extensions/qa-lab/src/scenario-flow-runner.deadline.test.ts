import { expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaScenarioFlow } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteStepOutcome } from "./suite-types.js";

type QaFlowAction = QaScenarioFlow["steps"][number]["actions"][number];

const delayedSideEffectCases: Array<[name: string, action: QaFlowAction]> = [
  ["generic call", { call: "sideEffect", args: [{ expr: "await resolveInput()" }] }],
  ["sendInbound", { sendInbound: { expr: "await resolveInput()" } }],
];

it.each(delayedSideEffectCases)(
  "does not invoke %s after aborting during async input resolution",
  async (_name, action) => {
    const controller = new AbortController();
    const timeoutError = new Error("scenario deadline expired");
    const sideEffect = vi.fn();
    const { promise: inputStarted, resolve: markInputStarted } = Promise.withResolvers<void>();
    const { promise: input, resolve: releaseInput } = Promise.withResolvers<unknown>();

    const pending = runScenarioFlow({
      api: {
        signal: controller.signal,
        state: createQaBusState(),
        scenario: makeQaSuiteTestScenario("flow-post-resolution-abort-fence"),
        config: {},
        resolveInput: async () => {
          markInputStarted();
          return await input;
        },
        sideEffect,
        transport: { sendInbound: sideEffect },
        runScenario: async (name, [step]) => {
          await step?.run();
          return { name, status: "pass", steps: [] };
        },
      },
      scenarioTitle: "flow-post-resolution-abort-fence",
      flow: { steps: [{ name: "resolve input", actions: [action] }] },
    });

    await inputStarted;
    controller.abort(timeoutError);
    releaseInput({});

    await expect(pending).rejects.toBe(timeoutError);
    expect(sideEffect).not.toHaveBeenCalled();
  },
);

it("runs finally cleanup without advancing other actions after abort", async () => {
  const controller = new AbortController();
  const timeoutError = new Error("scenario deadline expired");
  const blocked = { nested: vi.fn(), caught: vi.fn(), later: vi.fn(), details: vi.fn() };
  const finallyMutation = vi.fn();
  let pendingStep: Promise<QaSuiteStepOutcome | void> | undefined;
  const { promise: actionStarted, resolve: markActionStarted } = Promise.withResolvers<void>();
  const { promise: action, resolve: releaseAction } = Promise.withResolvers<void>();
  const { promise: deadline, reject: expireDeadline } = Promise.withResolvers<never>();
  const actions = [{ call: "delay" }, { call: "nested" }];
  const loop = { forEach: { items: [1], item: "item", actions } };
  const ifAction = Object.fromEntries([
    ["expr", "true"],
    [["th", "en"].join(""), [loop]],
  ]);

  const pending = runScenarioFlow({
    api: {
      signal: controller.signal,
      state: createQaBusState(),
      scenario: makeQaSuiteTestScenario("flow-abort-fence"),
      config: {},
      delay: async () => {
        markActionStarted();
        await action;
      },
      ...blocked,
      finallyMutation,
      runScenario: async (name, steps) => {
        pendingStep = steps[0]?.run();
        await Promise.race([pendingStep, deadline]);
        return { name, status: "pass", steps: [] };
      },
    },
    scenarioTitle: "flow-abort-fence",
    flow: {
      steps: [
        {
          name: "aborted nested flow",
          actions: [
            {
              try: {
                actions: [{ if: ifAction }],
                catch: [{ call: "caught" }],
                finally: [{ call: "finallyMutation" }],
              },
            },
            { call: "later" },
          ],
          detailsExpr: "details()",
        },
      ],
    },
  });

  try {
    await Promise.race([
      actionStarted,
      pending.then(() => {
        throw new Error("flow settled before the delayed action started");
      }),
    ]);
    controller.abort(timeoutError);
    expireDeadline(timeoutError);
    await expect(pending).rejects.toBe(timeoutError);
    // The outer deadline returns while the action is held; cleanup belongs to its late unwind.
    expect(finallyMutation).not.toHaveBeenCalled();
    releaseAction();
    await expect(pendingStep).rejects.toBe(timeoutError);
    for (const mutation of Object.values(blocked)) {
      expect(mutation).not.toHaveBeenCalled();
    }
    expect(finallyMutation).toHaveBeenCalledOnce();
  } finally {
    controller.abort(timeoutError);
    expireDeadline(timeoutError);
    releaseAction();
    await Promise.allSettled([pending, pendingStep, deadline]);
  }
});
