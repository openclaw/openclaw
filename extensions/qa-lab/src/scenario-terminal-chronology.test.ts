import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

function chronologyActions() {
  const scenario = readQaScenarioById("subagent-completion-direct-fallback");
  const guarded = scenario.execution.flow?.steps[0]?.actions
    .map((action) => (isRecord(action) ? action.try : undefined))
    .find(isRecord);
  if (!Array.isArray(guarded?.actions)) {
    throw new Error("missing terminal scenario body");
  }
  const start = guarded.actions.findIndex(
    (action) => isRecord(action) && action.set === "privateSpawnReceipts",
  );
  if (start < 0) {
    throw new Error("missing private chronology proof");
  }
  return guarded.actions.slice(start, start + 2);
}

function replay(fault?: string) {
  const wire = "tool_call";
  const calls = ["first", "second"].map((id, index) => ({
    plannedToolName: "sessions_spawn",
    plannedWireToolName: wire,
    plannedToolCallId: id,
    plannedToolItemId: "item-" + id,
    timestamp: index === 0 ? 100 : fault === "early" ? 150 : 300,
  }));
  const events = calls.map((call) => ({
    name: wire,
    timestamp: call.timestamp,
    toolCallId: call.plannedToolCallId + "|" + call.plannedToolItemId,
  }));
  if (fault === "foreign") {
    events[1]!.toolCallId = "foreign";
  }
  return runLoadedScenarioFlow("subagent-completion-direct-fallback", {
    flow: { steps: [{ name: "committed private spawn chronology", actions: chronologyActions() }] },
    api: {
      env: { runtimeId: "openclaw" },
      privateSpawns: calls,
      privateRequests: fault === "message" ? [...calls, { plannedToolName: "message" }] : calls,
      privateTasks: [{ endedAt: 200 }],
      privateTranscript: {
        successfulToolCallCounts: { [wire]: fault === "extra" ? 3 : 2 },
        successfulToolCallEvents: events,
      },
    },
  });
}

describe("terminal private chronology across invocation surfaces", () => {
  it("accepts exactly matched successful dispatcher receipts", async () => {
    await expect(replay()).resolves.toMatchObject({ status: "pass" });
  });
  it.each(["foreign", "early", "message", "extra"])(
    "rejects %s evidence instead of trusting a successful dispatcher count",
    async (fault) => {
      await expect(replay(fault)).rejects.toThrow(
        "private continuation lacks committed tool chronology",
      );
    },
  );
});
