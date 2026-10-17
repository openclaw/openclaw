import { describe, expect, it, vi } from "vitest";
import type { QaScenarioFlow } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { createFlowTestApi } from "./scenario-flow-runner.test-support.js";
import type { QaSuiteStepOutcome } from "./suite-types.js";

type QaFlowAction = QaScenarioFlow["steps"][number]["actions"][number];
const timeoutError = new Error("scenario deadline expired");

const delayedSideEffectCases: Array<[name: string, action: QaFlowAction]> = [
  ["generic call", { call: "sideEffect", args: [{ expr: "await resolveInput()" }] }],
  ["sendInbound", { sendInbound: { expr: "await resolveInput()" } }],
];

describe("scenario flow deadline", () => {
  it.each(delayedSideEffectCases)(
    "does not invoke %s after aborting during async input resolution",
    async (_name, action) => {
      const controller = new AbortController();
      const sideEffect = vi.fn();
      const inputStarted = Promise.withResolvers<void>();
      const input = Promise.withResolvers<unknown>();

      const pending = runScenarioFlow({
        api: createFlowTestApi("flow-post-resolution-abort-fence", {
          signal: controller.signal,
          resolveInput: async () => {
            inputStarted.resolve();
            return await input.promise;
          },
          sideEffect,
          transport: {
            sendInbound: sideEffect,
          },
        }),
        scenarioTitle: "flow-post-resolution-abort-fence",
        flow: { steps: [{ name: "resolve input", actions: [action] }] },
      });

      await inputStarted.promise;
      controller.abort(timeoutError);
      input.resolve({});

      await expect(pending).rejects.toBe(timeoutError);
      expect(sideEffect).not.toHaveBeenCalled();
    },
  );

  it("runs finally cleanup without advancing other actions after abort", async () => {
    const controller = new AbortController();
    const nestedMutation = vi.fn();
    const catchMutation = vi.fn();
    const finallyMutation = vi.fn();
    const laterMutation = vi.fn();
    const detailsMutation = vi.fn(() => "details");
    let pendingStep: Promise<QaSuiteStepOutcome | void> | undefined;
    const actionStarted = Promise.withResolvers<void>();
    const action = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<never>();
    const nestedActions = [
      {
        forEach: {
          items: [1],
          item: "item",
          actions: [{ call: "delayedAction" }, { call: "nestedMutation" }],
        },
      },
    ];
    const ifAction = Object.fromEntries([
      ["expr", "true"],
      [["th", "en"].join(""), nestedActions],
    ]);

    const pending = runScenarioFlow({
      api: createFlowTestApi("flow-abort-fence", {
        signal: controller.signal,
        delayedAction: async () => {
          actionStarted.resolve();
          await action.promise;
        },
        nestedMutation,
        catchMutation,
        finallyMutation,
        laterMutation,
        detailsMutation,
        runScenario: async (name, steps) => {
          try {
            pendingStep = steps[0]?.run();
            await Promise.race([pendingStep, deadline.promise]);
            return { name, status: "pass", steps: [] };
          } catch (error) {
            return {
              name,
              status: "fail",
              details: error instanceof Error ? error.message : String(error),
              steps: [],
            };
          }
        },
      }),
      scenarioTitle: "flow-abort-fence",
      flow: {
        steps: [
          {
            name: "aborted nested flow",
            actions: [
              {
                try: {
                  actions: [{ if: ifAction }],
                  catch: [{ call: "catchMutation" }],
                  finally: [{ call: "finallyMutation" }],
                },
              },
              { call: "laterMutation" },
            ],
            detailsExpr: "detailsMutation()",
          },
        ],
      },
    });

    try {
      await Promise.race([
        actionStarted.promise,
        pending.then(() => {
          throw new Error("flow settled before the delayed action started");
        }),
      ]);
      controller.abort(timeoutError);
      deadline.reject(timeoutError);
      const result = await pending;

      expect(result).toMatchObject({ status: "fail", details: timeoutError.message });
      // The outer deadline returns while the action is held; cleanup belongs to its late unwind.
      expect(finallyMutation).not.toHaveBeenCalled();
      action.resolve();
      await expect(pendingStep).rejects.toBe(timeoutError);
      expect(nestedMutation).not.toHaveBeenCalled();
      expect(catchMutation).not.toHaveBeenCalled();
      expect(finallyMutation).toHaveBeenCalledOnce();
      expect(laterMutation).not.toHaveBeenCalled();
      expect(detailsMutation).not.toHaveBeenCalled();
    } finally {
      controller.abort(timeoutError);
      deadline.reject(timeoutError);
      action.resolve();
      await Promise.allSettled([pending, pendingStep, deadline.promise]);
    }
  });
});
