import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
// Replace only the body, preserving the authored catch/finally cleanup boundary.
const actions = [{ try: { ...guarded.try, actions: [{ call: "recall" }] } }];
const errors = {
  scenario: new Error("wrong recalled preference"),
  completion: new Error("timed out after 60000ms"),
  restoration: new Error("restored config failed its health check"),
};
function fail(error?: Error) {
  if (error) {
    throw error;
  }
}

it.each([
  [true, true, false, "scenario"],
  [false, true, false, "completion"],
  [true, true, true, "scenario"],
  [false, true, true, "completion"],
  [true, false, true, "scenario"],
  [false, false, true, "restoration"],
  [false, false, false, "pass"],
] as const)(
  "cleanup: body fails=%s, pending=%s, restore fails=%s → %s",
  async (scenarioFails, completionTimesOut, restorationFails, expected) => {
    const state = createQaBusState();
    const lastInbound = state.addInboundMessage({
      conversation: { id: "remember-disabled", kind: "direct" },
      senderId: "remember-disabled",
      text: "Recall my preference.",
    });
    if (!completionTimesOut) {
      state.recordPollReceipts({ completedEventCursors: [state.getSnapshot().cursor] });
    }
    const before = state.getSnapshot();
    const originalMemorySearch = { rememberAcrossConversations: true, sources: ["sessions"] };
    let memorySearch = { ...originalMemorySearch, rememberAcrossConversations: false };
    const outcome = runScenarioFlow({
      scenarioTitle: scenario.title,
      flow: { steps: [{ name: "cleanup", actions }] },
      vars: { lastInbound, originalMemorySearch },
      api: {
        scenario,
        config: scenario.execution.config ?? {},
        state,
        env: {},
        liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
        waitForQaInboundCompletion,
        recall: () => fail(scenarioFails ? errors.scenario : undefined),
        patchConfig: ({ patch }: { patch: { memory: { search: typeof memorySearch } } }) => {
          memorySearch = patch.memory.search;
        },
        waitForGatewayHealthy: () => fail(restorationFails ? errors.restoration : undefined),
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
    expect.soft(memorySearch).toEqual({ rememberAcrossConversations: true, sources: ["sessions"] });
    expect(state.getSnapshot()).toEqual(before);
    if (expected === "pass") {
      expect(error).toEqual({ name: scenario.title, status: "pass", steps: [] });
    } else if (expected === "completion") {
      expect(error).toEqual(errors.completion);
    } else {
      expect(error).toBe(errors[expected]);
    }
  },
);
