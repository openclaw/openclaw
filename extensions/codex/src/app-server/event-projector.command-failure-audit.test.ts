import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  flushDiagnosticEvents,
  createParams,
  createProjector,
  forCurrentTurn,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("native command outcome diagnostics", () => {
  it.each([0, 7])(
    "records the process outcome when a completed command exits %s",
    async (exitCode) => {
      const projector = await createProjector(await createParams());
      const events: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => events.push(event));
      const item = {
        type: "commandExecution" as const,
        id: "command-outcome",
        command: "private command arguments",
        cwd: "/private/workspace",
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "private command output",
        exitCode,
        durationMs: 12,
      };
      try {
        await projector.handleNotification(
          forCurrentTurn("item/started", {
            item: { ...item, status: "inProgress", exitCode: null, aggregatedOutput: null },
          }),
        );
        await projector.handleNotification(forCurrentTurn("item/completed", { item }));
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }
      const toolEvents = events.filter(
        (event) => "toolCallId" in event && event.toolCallId === item.id,
      );
      expect(toolEvents.map((event) => event.type)).toEqual([
        "tool.execution.started",
        exitCode === 0 ? "tool.execution.completed" : "tool.execution.error",
      ]);
      if (exitCode !== 0) {
        expect(toolEvents[1]).toMatchObject({ terminalReason: "failed" });
      }
      expect(JSON.stringify(toolEvents)).not.toContain("private");
    },
  );
});
