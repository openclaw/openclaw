import { setImmediate as yieldImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE } from "./protocol.js";
import {
  createTerminalReleaseHarness,
  dynamicToolResult,
  rawCall,
  scope,
  terminalYieldResult,
} from "./run-attempt-lifecycle-controller.test-harness.js";

it.each(["direct", "nested"] as const)(
  "records the %s yield output before interrupting its native turn",
  async (route) => {
    await using h = createTerminalReleaseHarness();
    const callId = route === "direct" ? "call-yield" : "outer-exec";
    const outputType = route === "direct" ? "function_call_output" : "custom_tool_call_output";
    await h.notifyRawItem(
      route === "direct"
        ? rawCall(callId, "sessions_yield", CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE)
        : {
            type: "custom_tool_call",
            call_id: callId,
            name: "exec",
            namespace: "functions",
            input: "yield()",
          },
    );
    await h.finishResponse();
    h.controller.recordDynamicToolResult(terminalYieldResult(true));
    // The native handler's item completion precedes recording the model-visible output.
    await h.notify({
      method: "item/completed",
      params: {
        ...scope,
        item: { id: "call-yield", type: "dynamicToolCall", success: true, contentItems: [] },
      },
    });
    await yieldImmediate();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.state.completed).toBe(false);

    const output = { type: outputType, call_id: callId, output: '{"status":"yielded"}' };
    await h.notifyRawItem({ ...output, call_id: "unrelated" });
    await yieldImmediate();
    expect(h.request).not.toHaveBeenCalled();

    await h.notifyRawItem(output);
    await yieldImmediate();
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.request.mock.calls[0]?.[0]).toBe("turn/interrupt");
    expect(h.resolveCompletion).toHaveBeenCalledOnce();
    await h.notifyRawItem(output);
    await yieldImmediate();
    expect(h.request).toHaveBeenCalledOnce();
  },
);

it.each([
  {
    label: "a later authored batch after native-only work",
    toolAuthored: true,
    sameBatch: false,
  },
  { label: "an ordinary terminal tool beside native work", toolAuthored: false, sameBatch: true },
])("preserves $label", async ({ toolAuthored, sameBatch }) => {
  await using harness = createTerminalReleaseHarness();
  await harness.observeResponse(sameBatch ? ["native", "reply"] : ["native"]);
  if (sameBatch) {
    harness.pendingOpenClawDynamicToolCompletionIds.add("reply");
  }
  await harness.notifyNativeItem("item/started", "inProgress");
  await harness.notifyNativeItem("item/completed", "failed", 1);
  await harness.notifyRawItem({
    type: "function_call_output",
    call_id: "native",
    output: "failed",
  });
  await yieldImmediate();
  harness.pendingOpenClawDynamicToolCompletionIds.delete("reply");
  if (!sameBatch) {
    await harness.observeResponse(["reply"]);
  }
  harness.recordCommittedToolResult(
    dynamicToolResult("reply", {
      success: true,
      terminate: true,
      ...(toolAuthored
        ? {
            toolAuthoredSourceReply: {
              text: "Final reply.",
              toolAuthored: true as const,
              sourceReplyFinal: true,
            },
          }
        : {}),
    }),
  );
  await yieldImmediate();
  expect(harness.state.completed).toBe(true);
  expect(harness.sourceReplies.map((reply) => reply.text)).toEqual(
    toolAuthored ? ["Final reply."] : [],
  );
});
