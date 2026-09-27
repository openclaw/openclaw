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
    const result = requireRecord(
      projector
        .buildResult(buildEmptyToolTelemetry())
        .messagesSnapshot.find((message) => message.role === "toolResult"),
      "result",
    );
    const output = requireRecord(requireArray(result.content, "content")[0], "output").text;
    expect(output).toBe(
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
    const result = requireRecord(
      projector
        .buildResult(buildEmptyToolTelemetry())
        .messagesSnapshot.find((message) => message.role === "toolResult"),
      "result",
    );
    expect(requireRecord(requireArray(result.content, "content")[0], "output").text).toBe(output);
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
      const projector = await createProjector();
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "custom_tool_call",
            call_id: "outer-exec",
            name: "exec",
            input: "text(await tools.exec_command({cmd: 'transcript'}))",
          },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: { type: "custom_tool_call_output", call_id: "outer-exec", output },
        }),
      );
      await projector.handleNotification(turnCompleted());
      const result = requireRecord(
        projector
          .buildResult(buildEmptyToolTelemetry())
          .messagesSnapshot.find((message) => message.role === "toolResult"),
        "result",
      );
      expect(result.toolCallId).toBe("outer-exec");
      expect(result.isError).toBe(isError);
      expect(
        requireRecord(requireRecord(result["__openclaw"], "metadata").toolOutput, "provenance")
          .outcome,
      ).toBe(outcome);
      expect(requireRecord(requireArray(result.content, "content")[0], "output").text).toBe(output);
    },
  );

  it.each([
    {
      label: "unrecognized",
      output: "  Future patch execution failure\r\n" + "details\n".repeat(2_000),
      outcome: "unknown",
    },
    {
      label: "nonempty completed",
      output: "Script completed\nWall time 0.1 seconds\nOutput:\npatch details\n",
      outcome: undefined,
    },
  ])(
    "retains $label code-mode patch responses without inventing patch success",
    async ({ output, outcome }) => {
      const projector = await createProjector();
      const patchInput = "*** Begin Patch\n*** Add File: fixture.txt\n+fixture\n*** End Patch\n";
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "custom_tool_call",
            call_id: "outer-patch-exec",
            name: "exec",
            input: `const result = await tools.apply_patch(${JSON.stringify(patchInput)});\ntext(result);\n`,
          },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: { type: "custom_tool_call_output", call_id: "outer-patch-exec", output },
        }),
      );
      await projector.handleNotification(turnCompleted());
      const results = projector
        .buildResult(buildEmptyToolTelemetry())
        .messagesSnapshot.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        toolCallId: "outer-patch-exec",
        toolName: "exec",
        content: [{ type: "text", text: output }],
        __openclaw: { toolOutput: { source: "provider-response", modelInput: "unverified" } },
      });
      const metadata = requireRecord(requireRecord(results[0], "result")["__openclaw"], "metadata");
      expect(requireRecord(metadata.toolOutput, "provenance").outcome).toBe(outcome);
    },
  );

  it.each([
    {
      order: "before",
      aggregate: "available",
      aggregatedOutput: "raw execution output is not the response",
    },
    {
      order: "after",
      aggregate: "available",
      aggregatedOutput: "raw execution output is not the response",
    },
    { order: "before", aggregate: "null", aggregatedOutput: null },
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
      const messages = projector.buildResult(buildEmptyToolTelemetry()).messagesSnapshot;
      const results = messages.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(1);
      const result = requireRecord(results[0], "result");
      const block = requireRecord(requireArray(result.content, "content")[0], "output");
      expect(block.text).toBe(output);
      expect(result["__openclaw"]).toMatchObject({
        toolOutput: { source: "provider-response", modelInput: "unverified" },
      });
    },
  );

  it("preserves provider truncation verbatim instead of substituting raw command output", async () => {
    const projector = await createProjector();
    const command = {
      type: "commandExecution",
      id: "call-truncated",
      command: "transcript",
      status: "completed",
      aggregatedOutput: "untruncated raw stdout",
      exitCode: 0,
    };
    await projector.handleNotification(forCurrentTurn("item/completed", { item: command }));
    const output =
      "Chunk ID: abc\nWall time: 0.1000 seconds\nProcess exited with code 0\nOutput:\nWarning: truncated output (original token count: 8693)\nhead…12345 chars truncated…tail\n";
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: { type: "function_call_output", call_id: command.id, output },
      }),
    );
    await projector.handleNotification(turnCompleted([command]));
    const result = requireRecord(
      projector
        .buildResult(buildEmptyToolTelemetry())
        .messagesSnapshot.find((message) => message.role === "toolResult"),
      "result",
    );
    expect(requireRecord(requireArray(result.content, "content")[0], "output").text).toBe(output);
  });
});
