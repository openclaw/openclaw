import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { waitForQaInboundCompletion } from "./suite-runtime-transport.js";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const scenario = readQaScenarioById("remember-across-conversations");
const guarded = scenario.execution.flow!.steps[0]!.actions.find(
  (action) => isRecord(action) && "try" in action,
);
if (!isRecord(guarded) || !isRecord(guarded.try)) {
  throw new Error("expected memory scenario cleanup boundary");
}
const memoryTry = guarded.try;

describe("memory scenario cleanup", () => {
  it.each([
    { scenarioFails: true, completionTimesOut: true, restorationFails: false },
    { scenarioFails: false, completionTimesOut: true, restorationFails: false },
    { scenarioFails: true, completionTimesOut: true, restorationFails: true },
    { scenarioFails: false, completionTimesOut: true, restorationFails: true },
    { scenarioFails: true, completionTimesOut: false, restorationFails: true },
    { scenarioFails: false, completionTimesOut: false, restorationFails: true },
    { scenarioFails: false, completionTimesOut: false, restorationFails: false },
  ])(
    "restores config and preserves the primary failure: %j",
    async ({ scenarioFails, completionTimesOut, restorationFails }) => {
      const state = createQaBusState();
      const lastInbound = state.addInboundMessage({
        conversation: { id: "remember-disabled", kind: "direct" },
        senderId: "remember-disabled",
        text: "Recall my preference.",
      });
      if (!completionTimesOut) {
        state.resolvePollCursor({ acknowledgedCursor: state.getSnapshot().cursor });
      }
      const before = state.getSnapshot();
      const originalMemorySearch = { rememberAcrossConversations: true, sources: ["sessions"] };
      let memorySearch = { ...originalMemorySearch, rememberAcrossConversations: false };
      const scenarioError = new Error("wrong recalled preference");
      const restorationError = new Error("restored config failed its health check");
      const outcome = runScenarioFlow({
        scenarioTitle: scenario.title,
        // Substitute only the scenario body; execute its authored error and cleanup handlers.
        flow: {
          steps: [
            {
              name: "cleanup",
              actions: [{ try: { ...memoryTry, actions: [{ call: "recall" }] } }],
            },
          ],
        },
        vars: { lastInbound, originalMemorySearch },
        api: {
          scenario,
          config: scenario.execution.config ?? {},
          state,
          env: {},
          liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
          waitForQaInboundCompletion,
          recall: () => {
            if (scenarioFails) {
              throw scenarioError;
            }
          },
          patchConfig: ({ patch }: { patch: { memory: { search: typeof memorySearch } } }) => {
            memorySearch = patch.memory.search;
          },
          waitForGatewayHealthy: () => {
            if (restorationFails) {
              throw restorationError;
            }
          },
          waitForQaChannelReady: () => {},
          runScenario: async (name, steps) => {
            for (const step of steps) {
              await step.run();
            }
            return { name, status: "pass", steps: [] };
          },
        },
      }).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await outcome;
      expect
        .soft(memorySearch)
        .toEqual({ rememberAcrossConversations: true, sources: ["sessions"] });
      expect(state.getSnapshot()).toEqual(before);
      if (scenarioFails) {
        expect(error).toBe(scenarioError);
      } else if (completionTimesOut) {
        expect(error).toEqual(new Error("timed out after 60000ms"));
      } else if (restorationFails) {
        expect(error).toBe(restorationError);
      } else {
        expect(error).toEqual({ name: scenario.title, status: "pass", steps: [] });
      }
    },
  );
});
