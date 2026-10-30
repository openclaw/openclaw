/** Ambiguous host correlation must stay unknown in recorded CLI trajectories. */
import { expect, it } from "vitest";
import {
  assistant,
  captureContext,
  captureToolEvents,
  expectToolEvents,
  installCliCaptureFixture,
  messageUse,
  mockCaptureSpawn,
  recordToolOutcome,
  terminal,
  toolResult,
  user,
} from "./execute.capture.test-support.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import { wrapPreparedCliRunWithTestAdmission } from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
installCliCaptureFixture();

it("keeps identical parallel outcomes unknown with first tool finishes before second CLI identity", async () => {
  const toolEvents = captureToolEvents();
  const recordedResults: Array<Record<string, unknown> | undefined> = [];
  mockCaptureSpawn((input, captureKey) => {
    const toolArgs = { action: "react", emoji: "same" };
    const emitToolStarts = (...ids: string[]) =>
      input.onStdout?.(assistant(...ids.map((id) => messageUse(id, toolArgs))));
    const recordOutcome = (outcome: "completed" | "failed") =>
      recordToolOutcome(captureKey, "message", toolArgs, outcome);
    const emitToolResults = (...ids: string[]) =>
      input.onStdout?.(user(...ids.map((id) => toolResult(id, "ok"))));
    emitToolStarts("call-identical-a");
    recordOutcome("failed");
    recordOutcome("completed");
    emitToolResults("call-identical-a");
    emitToolStarts("call-identical-b");
    emitToolResults("call-identical-b");
    emitToolStarts("call-identical-later");
    recordOutcome("completed");
    input.onStdout?.(`${user(toolResult("call-identical-later", "ok"))}${terminal()}`);
  });
  const context = captureContext();
  context.trajectoryRecorder = {
    recordEvent(type, data) {
      if (type === "tool.result") {
        recordedResults.push(data);
      }
    },
  };

  await executePreparedCliRun(context);

  expect(recordedResults).toEqual([
    { toolCallId: "call-identical-a", name: "message", status: "unknown", result: "ok" },
    { toolCallId: "call-identical-b", name: "message", status: "unknown", result: "ok" },
    {
      toolCallId: "call-identical-later",
      name: "message",
      status: "completed",
      success: true,
      result: "ok",
    },
  ]);
  expect(toolEvents).toHaveLength(6);
  expectToolEvents(
    toolEvents,
    [
      ["started", "call-identical-a"],
      ["started", "call-identical-b"],
      ["error", "call-identical-a", { errorCode: "tool_outcome_unknown" }],
      ["error", "call-identical-b", { errorCode: "tool_outcome_unknown" }],
      ["started", "call-identical-later"],
      ["completed", "call-identical-later"],
    ],
    true,
  );
});
