import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { driver, result } from "./commands.test-helpers.js";
import { callWindowTool } from "./driver-result.js";
import {
  adoptGeneration,
  issueElementRef,
  issueObservation,
  issueWindowRef,
  resolveElementRef,
  resolveObservation,
  resolveWindowRef,
  type CuaFrameState,
} from "./frame.js";

const contract = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/computer-ref-lifecycle-contract.json", import.meta.url),
    "utf8",
  ),
) as {
  staleErrorCode: string;
  cases: Array<{
    id: string;
    scenario: keyof ReturnType<typeof lifecycleCases>;
    expected: "valid" | "stale";
  }>;
};

function lifecycleCases() {
  const state: CuaFrameState = { generation: "generation-1" };
  const windowRef = issueWindowRef(state, { pid: 100, windowId: 10 });
  const observation = issueObservation(state, windowRef);
  const elementRef = issueElementRef(observation, { elementIndex: 0 });

  return {
    fresh_window: () => resolveWindowRef(state, windowRef),
    fresh_element() {
      resolveElementRef(resolveObservation(state, observation.id, windowRef), elementRef);
    },
    window_moved() {
      // Rediscovery retains the stable identity even after the window moves.
      const moved = { pid: 100, windowId: 10 };
      expect(issueWindowRef(state, moved)).toBe(windowRef);
      expect(resolveWindowRef(state, windowRef)).toEqual(moved);
    },
    generation_rotation() {
      adoptGeneration(state, "generation-2");
      resolveWindowRef(state, windowRef);
    },
    async in_flight_generation_change() {
      // Exercise the post-await generation guard, not just pre-call validation.
      const session = driver();
      session.callTool.mockImplementationOnce(async () => {
        session.setGeneration("execution-2");
        return result({});
      });
      const callState = { generation: session.session.generation };
      await callWindowTool(session.session, callState, "get_window_state", {});
    },
    superseded_observation() {
      issueObservation(state, windowRef);
      resolveObservation(state, observation.id, windowRef);
    },
    unrelated_discovery() {
      issueWindowRef(state, { pid: 200, windowId: 20 });
      resolveWindowRef(state, windowRef);
    },
    unknown_ref: () => resolveWindowRef(state, "cua:v2:window:unknown"),
  };
}

it.each(contract.cases)("Computer Use ref lifecycle: $id", async ({ scenario, expected }) => {
  const runCase = async () => {
    await lifecycleCases()[scenario]();
  };
  if (expected === "valid") {
    await expect(runCase()).resolves.toBeUndefined();
  } else {
    await expect(runCase()).rejects.toThrow(new RegExp(`^${contract.staleErrorCode}:`, "u"));
  }
});
