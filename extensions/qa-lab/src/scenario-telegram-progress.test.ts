import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

async function observeProgress(intermediate: string) {
  const scenario = readQaScenarioById("telegram-progress-tool-visibility");
  const loop = scenario.execution.flow!.steps[0]!.actions.find(
    (action) => isRecord(action) && "forEach" in action,
  );
  if (!isRecord(loop) || !isRecord(loop.forEach) || !Array.isArray(loop.forEach.actions)) {
    throw new Error("missing Telegram progress cases");
  }
  const actions: unknown[] = loop.forEach.actions;
  const start = actions.findIndex((action) => isRecord(action) && action.set === "turnEvents");
  if (start < 0) {
    throw new Error("missing Telegram progress observer");
  }
  const state = createQaBusState();
  const progress = state.addOutboundMessage({
    accountId: "sut",
    to: "dm:progress",
    text: "COMMENTARY",
  });
  state.editMessage({
    accountId: "sut",
    messageId: progress.id,
    text: `COMMENTARY
${intermediate}`,
  });
  state.addOutboundMessage({ accountId: "sut", to: "dm:progress", text: "FINAL" });
  return runLoadedScenarioFlow(scenario.id, {
    state,
    flow: {
      steps: [
        {
          name: "observe quiet progress",
          actions: [
            { set: "startCursor", value: 0 },
            { set: "commentaryMarker", value: "COMMENTARY" },
            { set: "toolMarker", value: "COMMAND_SECRET" },
            { set: "finalMarker", value: "FINAL" },
            { set: "fixture", value: { name: "quiet" } },
            { set: "requests", value: [] },
            { set: "proofs", value: [] },
            ...actions.slice(start),
          ],
        },
      ],
    },
    api: { transport: { accountId: "sut" } },
  });
}

describe("Telegram progress scenario observer", () => {
  it.each(["Exec: running", "Last activity: Exec"])(
    "accepts bounded work status %s",
    async (status) => {
      await expect(observeProgress(status)).resolves.toMatchObject({ status: "pass" });
    },
  );

  it.each([
    "COMMAND_SECRET",
    "🛠️ Exec COMMAND_SECRET",
    "Exec: running COMMAND_SECRET",
    "Exec: completed",
    "Last activity: Exec private-output",
  ])("rejects detailed or unbounded tool text %s", async (status) => {
    await expect(observeProgress(status)).rejects.toThrow("omitted toolProgress");
  });
});
