import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  createProjector,
  buildEmptyToolTelemetry,
  forCurrentTurn,
} from "./event-projector.test-harness.js";

function notify(
  projector: Awaited<ReturnType<typeof createProjector>>,
  method: Parameters<typeof forCurrentTurn>[0],
  params: Record<string, unknown>,
) {
  return projector.handleNotification(forCurrentTurn(method, params));
}

registerCodexEventProjectorTestLifecycle();

describe("Codex native patch and Code Mode transcript projection", () => {
  it.each([
    { nativeItem: true, failed: true, directCall: undefined },
    { nativeItem: true, failed: false, directCall: undefined },
    { nativeItem: false, failed: true, directCall: undefined },
    { nativeItem: false, failed: true, directCall: "custom" },
    { nativeItem: false, failed: true, directCall: "function" },
  ])(
    "counts a patch once with nativeItem=$nativeItem, failed=$failed and directCall=$directCall",
    async ({ nativeItem, failed, directCall }) => {
      const projector = await createProjector();
      const outerCallId = "code-mode-patch-exec";
      const nativeCallId = "code-mode-patch-file-change";
      const callId = nativeItem ? nativeCallId : outerCallId;
      const patchInput = nativeItem
        ? "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n"
        : "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+# Inventory audit\n\n- **Data records:** 8\n*** End Patch";

      await notify(projector, "rawResponseItem/completed", {
        item: {
          type: directCall === "function" ? "function_call" : "custom_tool_call",
          call_id: outerCallId,
          name: directCall ? "apply_patch" : "exec",
          ...(directCall === "function"
            ? { arguments: JSON.stringify({ input: patchInput }) }
            : {
                input: directCall
                  ? patchInput
                  : `const patch = ${JSON.stringify(patchInput)};\ntext(await tools.apply_patch(patch));`,
              }),
        },
      });
      if (nativeItem) {
        await notify(projector, "item/completed", {
          item: {
            type: "fileChange",
            id: nativeCallId,
            changes: [{ path: "runtime-tool-fixture-patch.txt", kind: { type: "add" } }],
            status: failed ? "failed" : "completed",
          },
        });
      }
      const output = {
        item: {
          type: directCall === "function" ? "function_call_output" : "custom_tool_call_output",
          call_id: outerCallId,
          output: directCall
            ? "apply_patch verification failed: invalid hunk at line 4, '' is not a valid hunk header."
            : [
                {
                  type: "input_text",
                  text: `Script ${failed ? "failed" : "completed"}\nWall time 0.0 seconds\nOutput:\n`,
                },
                {
                  type: "input_text",
                  text: failed
                    ? nativeItem
                      ? "Script error: patch failed"
                      : "Script error:\napply_patch verification failed: invalid hunk at line 4, '' is not a valid hunk header."
                    : "{}",
                },
              ],
        },
      };
      await notify(projector, "rawResponseItem/completed", output);
      await notify(projector, "rawResponseItem/completed", output);

      if (!nativeItem) {
        await notify(projector, "item/completed", {
          item: {
            type: "fileChange",
            id: "corrected-patch",
            changes: [{ path: "runtime-tool-fixture-patch.txt", kind: { type: "add" } }],
            status: "completed",
          },
        });
      }

      const result = projector.buildResult(buildEmptyToolTelemetry());
      const patchCalls = result.messagesSnapshot.flatMap((message) => {
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
          return [];
        }
        return message.content.filter(
          (block) =>
            block.type === "toolCall" &&
            "name" in block &&
            block.name === "apply_patch" &&
            block.id === callId,
        );
      });
      expect(patchCalls).toHaveLength(1);
      expect(patchCalls[0]).toMatchObject({ id: callId, name: "apply_patch" });
      expect(
        result.messagesSnapshot.filter(
          (message) => message.role === "toolResult" && message.toolCallId === callId,
        ),
      ).toEqual([expect.objectContaining({ toolCallId: callId, isError: failed })]);
      expect(result.toolMetas).toEqual([
        expect.objectContaining({ toolName: "apply_patch", isError: failed }),
        ...(!nativeItem
          ? [expect.objectContaining({ toolName: "apply_patch", isError: false })]
          : []),
      ]);
      if (!nativeItem) {
        expect(result.lastToolError).toBeUndefined();
      }
      if (nativeItem) {
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
      }
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

    await notify(projector, "rawResponseItem/completed", {
      item: { type: "custom_tool_call", call_id: callId, name: "exec", input: source },
    });
    await notify(projector, "rawResponseItem/completed", {
      item: {
        type: "custom_tool_call_output",
        call_id: callId,
        output: [
          { type: "input_text", text: "Script failed\nWall time 6.0 seconds\nOutput:\n" },
          {
            type: "input_text",
            text: "Script error:\npatch rejected: writing outside of the project; rejected by user approval settings",
          },
        ],
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.messagesSnapshot.filter((message) => message.role === "toolResult")).toEqual([
      expect.objectContaining({ toolCallId: callId, toolName: "exec", isError: true }),
    ]);
  });
});
