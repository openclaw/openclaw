import {
  buildEmptyToolTelemetry,
  createProjector,
  describe,
  expect,
  forCurrentTurn,
  it,
  registerCodexEventProjectorTestLifecycle,
  requireArray,
  requireRecord,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

function toolResult(projector: Awaited<ReturnType<typeof createProjector>>) {
  const results = projector
    .buildResult(buildEmptyToolTelemetry())
    .messagesSnapshot.filter((message) => message.role === "toolResult");
  expect(results).toHaveLength(1);
  return requireRecord(results[0], "result");
}

function outputText(result: Record<string, unknown>) {
  return requireRecord(requireArray(result.content, "content")[0], "output").text;
}

async function projectCodeModeOutput(output: string, input: string) {
  const projector = await createProjector();
  for (const item of [
    { type: "custom_tool_call", call_id: "outer-exec", name: "exec", input },
    { type: "custom_tool_call_output", call_id: "outer-exec", output },
  ]) {
    await projector.handleNotification(forCurrentTurn("rawResponseItem/completed", { item }));
  }
  await projector.handleNotification(turnCompleted());
  return toolResult(projector);
}

// The response notification is distinct from the command's raw stdout. Codex
// may further truncate history after constructing this response; do not claim
// exact model-input fidelity from this notification alone.
describe("Codex tool response fidelity", () => {
  it("preserves structured text boundaries without moving private media into plaintext", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call",
          call_id: "structured",
          name: "exec",
          input: "text('result')",
        },
      }),
    );
    const text = " \r\n" + "x".repeat(34_766) + "TAIL\r\n ";
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: "structured",
          output: [
            { type: "input_text", text },
            { type: "input_image", image_url: "data:image/png;base64,PRIVATE_PAYLOAD" },
            { type: "input_text", text: "" },
          ],
        },
      }),
    );
    expect(outputText(toolResult(projector))).toBe(
      JSON.stringify(
        [
          { type: "input_text", text },
          { type: "input_image", omitted: true },
          { type: "input_text", text: "" },
        ],
        null,
        2,
      ),
    );
  });

  it("keeps execution-only output inspectable without claiming model-input fidelity", async () => {
    const projector = await createProjector();
    const output = " \n" + "x".repeat(34_766) + "TAIL\n ";
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "raw-only",
          command: "transcript",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          commandActions: [],
          durationMs: 1,
          status: "completed",
          aggregatedOutput: output,
          exitCode: 0,
        },
      ]),
    );
    const result = toolResult(projector);
    expect(outputText(result)).toBe(output);
    expect(result["__openclaw"]).toMatchObject({
      toolOutput: { source: "execution", modelInput: "unverified" },
    });
  });

  it.each([
    { label: "empty", output: "", isError: false, outcome: "unknown" },
    { label: "whitespace", output: " \r\n", isError: false, outcome: "unknown" },
    {
      label: "completed",
      output: "Script completed\nWall time 0.1 seconds\nOutput:\n" + "x".repeat(34_766),
      isError: false,
      outcome: undefined,
    },
    {
      label: "failed",
      output: "Script failed\nWall time 0.1 seconds\nOutput:\nScript error: fixture failure",
      isError: true,
      outcome: undefined,
    },
  ])(
    "retains $label outer code-mode output under its own call ID",
    async ({ output, isError, outcome }) => {
      const result = await projectCodeModeOutput(
        output,
        "text(await tools.exec_command({cmd: 'transcript'}))",
      );
      expect(result.toolCallId).toBe("outer-exec");
      expect(result.isError).toBe(isError);
      expect(
        requireRecord(requireRecord(result["__openclaw"], "metadata").toolOutput, "provenance")
          .outcome,
      ).toBe(outcome);
      expect(outputText(result)).toBe(output);
    },
  );

  it("retains unrecognized code-mode patch responses without inventing patch success", async () => {
    const output = "  Future patch execution failure\r\n" + "details\n".repeat(2_000);
    const patchInput = "*** Begin Patch\n*** Add File: fixture.txt\n+fixture\n*** End Patch\n";
    const result = await projectCodeModeOutput(
      output,
      `const result = await tools.apply_patch(${JSON.stringify(patchInput)});\ntext(result);\n`,
    );
    expect(result).toMatchObject({
      toolCallId: "outer-exec",
      toolName: "exec",
      content: [{ type: "text", text: output }],
      __openclaw: { toolOutput: { source: "provider-response", modelInput: "unverified" } },
    });
    const metadata = requireRecord(result["__openclaw"], "metadata");
    expect(requireRecord(metadata.toolOutput, "provenance").outcome).toBe("unknown");
  });

  it.each([
    {
      order: "before",
      aggregate: "available",
      aggregatedOutput: "raw execution output is not the response",
    },
    { order: "after", aggregate: "null", aggregatedOutput: null },
  ])(
    "preserves the complete response $order the terminal item with $aggregate aggregate",
    async ({ order, aggregatedOutput }) => {
      const projector = await createProjector();
      const output = " \n" + "transcript 😀\n".repeat(2_700) + "END OF TRANSCRIPT\n ";
      const command = {
        type: "commandExecution",
        id: "call-long",
        command: "transcript",
        status: "completed",
        aggregatedOutput,
        exitCode: 0,
      };
      await projector.handleNotification(
        forCurrentTurn("item/started", { item: { ...command, status: "inProgress" } }),
      );
      const response = forCurrentTurn("rawResponseItem/completed", {
        item: { type: "function_call_output", call_id: command.id, output },
      });
      if (order === "before") {
        await projector.handleNotification(response);
      }
      await projector.handleNotification(forCurrentTurn("item/completed", { item: command }));
      if (order === "after") {
        await projector.handleNotification(response);
      }
      await projector.handleNotification(turnCompleted([command]));
      const result = toolResult(projector);
      expect(outputText(result)).toBe(output);
      expect(result["__openclaw"]).toMatchObject({
        toolOutput: { source: "provider-response", modelInput: "unverified" },
      });
    },
  );
});
