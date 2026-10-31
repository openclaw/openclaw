import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaNativeSubagentRun } from "./execution-identity-storage-inspection.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

it("selects the current empty child in both completion modes despite earlier matching runs", async () => {
  const scenario = readQaScenarioById("subagent-empty-completion-recovery");
  const step = scenario.execution.flow!.steps[0]!;
  const loopIndex = step.actions.findIndex((action) => isRecord(action) && "forEach" in action);
  const loop = step.actions[loopIndex];
  if (!isRecord(loop) || !isRecord(loop.forEach) || !Array.isArray(loop.forEach.actions)) {
    throw new Error("expected empty completion modes");
  }
  const actions: unknown[] = loop.forEach.actions;
  const noticeIndex = actions.findIndex(
    (action) => isRecord(action) && action.saveAs === "requesterNotices",
  );
  if (noticeIndex < 0) {
    throw new Error("expected empty completion lifecycle checks before notice observation");
  }

  const createRun = (runId: string): QaNativeSubagentRun => ({
    runId,
    label: "qa-terminal-empty",
    childSessionKey: `child:${runId}`,
    requesterSessionKey: "parent",
    createdAt: 1,
    execution: { status: "terminal", outcome: { status: "error" } },
    delivery: { status: "delivered" },
  });
  const state = createQaBusState();
  const runs = [createRun("earlier-empty-run")];
  const selectedRunIds: string[] = [];
  const result = await runLoadedScenarioFlow(scenario.id, {
    state,
    // Execute the real loop through agent.wait; delivery and write checks are
    // independent of the lookup's per-iteration variable capture.
    flow: {
      steps: [
        {
          name: step.name,
          actions: [
            ...step.actions.slice(0, loopIndex),
            { forEach: { ...loop.forEach, actions: actions.slice(0, noticeIndex) } },
          ],
        },
      ],
    },
    api: {
      path,
      readNativeQaSubagentRuns: async () => [...runs],
      env: {
        providerMode: "mock-openai",
        gateway: {
          workspaceDir: "/qa-empty-completion",
          call: async (method: string, args: { runId: string }) => {
            expect(method).toBe("agent.wait");
            selectedRunIds.push(args.runId);
            return {
              status: "error",
              error: "No answer was returned.",
              stopReason: "error",
              livenessState: "abandoned",
              terminalReply: { disposition: "empty" },
              terminalReceipt: { terminalDisposition: "not-visible" },
            };
          },
        },
      },
      transport: {
        sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) => {
          const mode = input.text.includes("yield until the worker finishes")
            ? "yielded"
            : "fallback";
          // Older matching runs stay first, just as they do in persisted state.
          runs.push(createRun(`${mode}-empty-run`));
          return state.addInboundMessage(input);
        },
      },
    },
  });

  expect(result.status).toBe("pass");
  expect(selectedRunIds).toEqual(["fallback-empty-run", "yielded-empty-run"]);
  expect(runs.map((run) => run.runId)).toEqual([
    "earlier-empty-run",
    "fallback-empty-run",
    "yielded-empty-run",
  ]);
});
