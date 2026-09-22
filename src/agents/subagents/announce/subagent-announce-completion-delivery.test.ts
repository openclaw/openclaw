// Completion predicates read recorded facts, not rendered placeholder wording.
import { describe, expect, it, vi } from "vitest";
import { hasFailedSubagentNoOutputCompletion } from "../../internal-event-contract.js";
import { runAnnounceAgentCall } from "./subagent-announce-completion-delivery.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-delivery.runtime.js";

const failedChild = { type: "task_completion", source: "subagent", status: "error" } as const;

it("does not dispatch a private handoff after its caller has already cancelled", async () => {
  const caller = new AbortController();
  caller.abort(new Error("requester stopped"));
  const dispatch = vi.fn(async () => {
    throw new Error("cancelled dispatch must not start");
  });
  setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
  try {
    await expect(
      runAnnounceAgentCall({
        agentParams: {},
        privateCompletion: true,
        signal: caller.signal,
        isExecutionAllowed: () => true,
      }),
    ).rejects.toThrow("requester stopped");
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    setSubagentAnnounceDeliveryDepsForTest();
  }
});

describe("hasFailedSubagentNoOutputCompletion", () => {
  it.each([
    [
      "recorded no visible result",
      { ...failedChild, result: "(no output)", noVisibleResult: true },
      true,
    ],
    [
      "reworded placeholder",
      { ...failedChild, result: "(nothing to report)", noVisibleResult: true },
      true,
    ],
    ["real result resembling placeholder", { ...failedChild, result: "(no output)" }, false],
    [
      "successful child",
      { ...failedChild, status: "ok", result: "(no output)", noVisibleResult: true },
      false,
    ],
    [
      "non-subagent source",
      { ...failedChild, source: "image_generation", result: "(no output)", noVisibleResult: true },
      false,
    ],
  ] as const)("classifies %s from the recorded result fact", (_label, event, expected) => {
    expect(hasFailedSubagentNoOutputCompletion([event])).toBe(expected);
  });

  it("reports nothing for an absent or empty event list", () => {
    expect(hasFailedSubagentNoOutputCompletion(undefined)).toBe(false);
    expect(hasFailedSubagentNoOutputCompletion([])).toBe(false);
  });
});
