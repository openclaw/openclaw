import * as fixture from "./event-projector.compact.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  createProjector,
} from "./event-projector.test-harness.js";

function execOutput(callId: string, error: string) {
  return {
    type: "custom_tool_call_output",
    call_id: callId,
    output: ["Script failed\nWall time 6.0 seconds\nOutput:\n", error].map((text) => ({
      type: "input_text",
      text,
    })),
  };
}

registerCodexEventProjectorTestLifecycle();

describe("Codex Code Mode transcript projection", () => {
  it("keeps the canonical apply_patch item when it fails", async () => {
    const projector = await createProjector();
    const outerCallId = "code-mode-patch-exec";
    const nativeCallId = "code-mode-patch-file-change";
    const patchInput =
      "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n";

    await fixture.notify(projector, "rawResponseItem/completed", {
      item: {
        type: "custom_tool_call",
        call_id: outerCallId,
        name: "exec",
        input: `const result = await tools.apply_patch(${JSON.stringify(patchInput)});\ntext(result);\n`,
      },
    });
    await fixture.complete(projector, {
      type: "fileChange",
      id: nativeCallId,
      changes: [{ path: "runtime-tool-fixture-patch.txt", kind: { type: "add" } }],
      status: "failed",
    });
    await fixture.notify(projector, "rawResponseItem/completed", {
      item: execOutput(outerCallId, "Script error: patch failed"),
    });

    const result = fixture.result(projector);
    const patchCalls = result.messagesSnapshot.flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return [];
      }
      return message.content.filter(
        (block) => block.type === "toolCall" && "name" in block && block.name === "apply_patch",
      );
    });
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toMatchObject({ id: nativeCallId, name: "apply_patch" });
    expect(
      result.messagesSnapshot.filter(
        (message) => message.role === "toolResult" && message.toolName === "apply_patch",
      ),
    ).toEqual([expect.objectContaining({ toolCallId: nativeCallId, isError: true })]);
    expect(result.messagesSnapshot).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: outerCallId,
        toolName: "exec",
        __openclaw: expect.objectContaining({
          toolOutput: { source: "provider-response", modelInput: "unverified" },
        }),
      }),
    );
    expect(result.toolMetas).toEqual([
      expect.objectContaining({ toolName: "apply_patch", isError: true }),
    ]);
  });

  it.each(["code-mode", "custom", "function"] as const)(
    "retains a rejected %s patch in counts after a successful retry",
    async (mode) => {
      const projector = await createProjector();
      const callId = "rejected-patch";
      const input = "*** Begin Patch\n*** Add File: example.txt\ninvalid hunk\n*** End Patch";
      const rejection = "apply_patch verification failed: invalid hunk at line 3";
      await fixture.notify(projector, "rawResponseItem/completed", {
        item: {
          type: mode === "function" ? "function_call" : "custom_tool_call",
          call_id: callId,
          name: mode === "code-mode" ? "exec" : "apply_patch",
          ...(mode === "function"
            ? { arguments: JSON.stringify({ input }) }
            : {
                input:
                  mode === "code-mode"
                    ? `text(await tools.apply_patch(${JSON.stringify(input)}));`
                    : input,
              }),
        },
      });
      const output =
        mode === "code-mode"
          ? execOutput(callId, `Script error: ${rejection}`)
          : {
              type: mode === "function" ? "function_call_output" : "custom_tool_call_output",
              call_id: callId,
              output: rejection,
            };
      await fixture.notify(projector, "rawResponseItem/completed", { item: output });
      await fixture.notify(projector, "rawResponseItem/completed", { item: output });
      await fixture.complete(projector, {
        type: "fileChange",
        id: "corrected-patch",
        changes: [{ path: "example.txt", kind: { type: "add" } }],
        status: "completed",
      });

      const result = fixture.result(projector);
      expect(result.toolMetas).toEqual([
        expect.objectContaining({ toolName: "apply_patch", isError: true }),
        expect.objectContaining({ toolName: "apply_patch", isError: false }),
      ]);
      expect(
        result.messagesSnapshot.filter(
          (message) => message.role === "toolResult" && message.toolCallId === callId,
        ),
      ).toEqual([expect.objectContaining({ toolName: "apply_patch", isError: true })]);
      expect(result.lastToolError).toBeUndefined();
    },
  );

  it.each([
    {
      label: "a mismatched input variable",
      source: 'const args = {cmd: "exit 1"}; text(await tools.exec_command(other));',
    },
    {
      label: "a command template interpolation",
      source: "text(await tools.exec_command({cmd: `exit ${code}`}));",
    },
    {
      label: "a prototype setter",
      source: 'text(await tools.exec_command({__proto__: null, cmd: "exit 1"}));',
    },
  ])("keeps $label as an outer exec", async ({ source }) => {
    const projector = await createProjector();
    const callId = "not-an-isolated-code-mode-patch";

    await fixture.notify(projector, "rawResponseItem/completed", {
      item: { type: "custom_tool_call", call_id: callId, name: "exec", input: source },
    });
    await fixture.notify(projector, "rawResponseItem/completed", {
      item: execOutput(
        callId,
        "Script error:\npatch rejected: writing outside of the project; rejected by user approval settings",
      ),
    });

    const result = fixture.result(projector);
    expect(result.messagesSnapshot.filter((message) => message.role === "toolResult")).toEqual([
      expect.objectContaining({ toolCallId: callId, toolName: "exec", isError: true }),
    ]);
  });
});
