import { describe, expect, it, vi } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import { createConfiguredProjection } from "./event-projector-projection.test-support.js";
import {
  notify,
  result as snapshot,
  rawAssistant,
} from "./event-projector.compact.test-support.js";
import * as h from "./event-projector.test-harness.js";

h.registerCodexEventProjectorTestLifecycle();

type Projector = Awaited<ReturnType<typeof h.createProjector>>;
type Item = Record<string, unknown>;
function raw(projector: Projector, item: Item) {
  return notify(projector, "rawResponseItem/completed", { item });
}
function itemEvent(projector: Projector, phase: "started" | "completed", item: Item) {
  return notify(projector, `item/${phase}`, { item });
}
function delta(projector: Projector, itemId: string, text: string) {
  return notify(projector, "item/commandExecution/outputDelta", { itemId, delta: text });
}
function startCommand(projector: Projector, item: Item) {
  return itemEvent(projector, "started", {
    ...item,
    status: "inProgress",
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  });
}
async function createVerboseProjector(
  overrides: Partial<Awaited<ReturnType<typeof h.createParams>>> = {},
) {
  return (await createConfiguredProjection({ verboseLevel: "full", ...overrides })).projector;
}

describe("Codex tool response fidelity", () => {
  function toolResult(projector: Awaited<ReturnType<typeof h.createProjector>>) {
    const results = snapshot(projector).messagesSnapshot.filter(
      (message) => message.role === "toolResult",
    );
    expect(results).toHaveLength(1);
    return h.requireRecord(results[0], "result");
  }

  function outputText(result: Record<string, unknown>) {
    return h.requireRecord(h.requireArray(result.content, "content")[0], "output").text;
  }
  function outcome(result: Record<string, unknown>) {
    const metadata = h.requireRecord(result["__openclaw"], "metadata");
    return h.requireRecord(metadata.toolOutput, "provenance").outcome;
  }

  async function projectExec(output: unknown, input: string, callId = "outer-exec") {
    const projector = await h.createProjector();
    for (const item of [
      { type: "custom_tool_call", call_id: callId, name: "exec", input },
      { type: "custom_tool_call_output", call_id: callId, output },
    ]) {
      await raw(projector, item);
    }
    return projector;
  }

  // Provider responses differ from raw stdout and may still be truncated before model input.

  it("preserves structured text boundaries without moving private media into plaintext", async () => {
    const text = " \r\n" + "x".repeat(34_766) + "TAIL\r\n ";
    const projector = await projectExec(
      [
        { type: "input_text", text },
        { type: "input_image", image_url: "data:image/png;base64,PRIVATE_PAYLOAD" },
        { type: "input_text", text: "" },
      ],
      "text('result')",
      "structured",
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

  it("retains completed outer code-mode output under its own call ID", async () => {
    const output = "Script completed\nWall time 0.1 seconds\nOutput:\n" + "x".repeat(34_766);
    const projector = await projectExec(
      output,
      "text(await tools.exec_command({cmd: 'transcript'}))",
    );
    await projector.handleNotification(h.turnCompleted());
    const outputResult = toolResult(projector);
    expect(outputResult).toMatchObject({ toolCallId: "outer-exec", isError: false });
    expect(outcome(outputResult)).toBeUndefined();
    expect(outputText(outputResult)).toBe(output);
  });

  it.each(["before", "after"])(
    "uses the native collaboration failure when output arrives %s completion",
    async (order) => {
      const projector = await h.createProjector();
      const callId = `spawn-${order}-failed`;
      await raw(projector, {
        type: "function_call",
        call_id: callId,
        name: "spawn_agent",
        arguments: JSON.stringify({ message: "inspect the owner" }),
      });
      const output = h.forCurrentTurn("rawResponseItem/completed", {
        item: { type: "function_call_output", call_id: callId, output: "Agent started." },
      });
      const native = {
        type: "collabAgentToolCall",
        id: callId,
        tool: "spawnAgent",
        senderThreadId: "thread-1",
        receiverThreadIds: ["child-1"],
        agentsStates: {},
      };
      await itemEvent(projector, "started", { ...native, status: "inProgress" });
      if (order === "before") {
        await projector.handleNotification(output);
      }
      await itemEvent(projector, "completed", { ...native, status: "failed" });
      if (order === "after") {
        await projector.handleNotification(output);
      }
      await projector.handleNotification(h.turnCompleted([{ ...native, status: "failed" }]));

      const result = toolResult(projector);
      expect(result).toMatchObject({
        toolCallId: callId,
        toolName: "spawn_agent",
        isError: true,
        content: [{ type: "text", text: "Agent started." }],
        __openclaw: { toolOutput: { source: "provider-response", modelInput: "unverified" } },
      });
      expect(outcome(result)).toBeUndefined();
    },
  );

  it("preserves the complete response after the terminal item with null aggregate", async () => {
    const projector = await h.createProjector();
    const output = " \n" + "transcript 😀\n".repeat(2_700) + "END OF TRANSCRIPT\n ";
    const command = {
      type: "commandExecution",
      id: "call-long",
      command: "transcript",
      status: "completed",
      aggregatedOutput: null,
      exitCode: 0,
    };
    await itemEvent(projector, "started", { ...command, status: "inProgress" });
    await itemEvent(projector, "completed", command);
    await raw(projector, { type: "function_call_output", call_id: command.id, output });
    await projector.handleNotification(h.turnCompleted([command]));
    const result = toolResult(projector);
    expect(outputText(result)).toBe(output);
    expect(result["__openclaw"]).toMatchObject({
      toolOutput: { source: "provider-response", modelInput: "unverified" },
    });
  });
});

describe("streamed-output-echo", () => {
  function expectNoReply(projector: Projector) {
    const value = snapshot(projector);
    expect(value).toMatchObject({
      assistantTexts: [],
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
    });
    return value;
  }

  it("keeps typed final answers that verbatim-equal tool output", async () => {
    const projector = await createVerboseProjector({ verboseLevel: "on", onToolResult: vi.fn() });
    const output = "command-output-line\nsecond-line";
    const item = createNativeCommandItem({
      id: "cmd-verbatim",
      command: "cat result.txt",
      aggregatedOutput: output,
      durationMs: 12,
    });
    await startCommand(projector, item);
    await delta(projector, item.id, output);
    await itemEvent(projector, "completed", item);
    await itemEvent(projector, "completed", {
      type: "agentMessage",
      id: "msg-verbatim",
      text: output,
    });
    await projector.handleNotification(h.turnCompleted());
    const value = snapshot(projector);
    expect(value.assistantTexts).toEqual([output]);
    expect(value.lastAssistant).toBeDefined();
    expect(value.currentAttemptAssistant).toBeDefined();
  });

  it("keeps a channel summary echo suppressed after later streamed output", async () => {
    const onToolResult = vi.fn();
    const onAgentEvent = vi.fn();
    const projector = await createVerboseProjector({
      messageChannel: "telegram",
      onToolResult,
      onAgentEvent,
    });
    const item = createNativeCommandItem({ id: "cmd-multi-shape" });
    await startCommand(projector, item);
    const summary = onToolResult.mock.calls[0]?.[0].text;
    expect(summary).toBe("Bash");
    const output = "streamed-output-chunk-that-would-overwrite-summary";
    await delta(projector, item.id, output);
    await itemEvent(projector, "completed", {
      ...item,
      aggregatedOutput: output,
      exitCode: 2,
      durationMs: 12,
    });
    const prepared = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.stream === "item" &&
          event.data.toolCallId === item.id &&
          !event.data.suppressChannelProgress,
      );
    expect(prepared.map((event) => event.data.itemId)).toEqual([
      "tool:cmd-multi-shape",
      "tool:cmd-multi-shape",
    ]);
    expect(prepared.at(-1)?.data.status).toBe("failed");
    expect(
      onToolResult.mock.calls.map(([payload]) => payload.channelData?.openclawToolProgressId),
    ).toEqual([prepared[0]?.data.itemId, prepared[0]?.data.itemId]);
    await rawAssistant(projector, summary, { id: "raw-echo" });
    await projector.handleNotification(h.turnCompleted());
    expectNoReply(projector);
  });

  it("retains oversized summary and normalized stream echo signatures across fine-grained deltas", async () => {
    const onToolResult = vi.fn();
    const projector = await createVerboseProjector({ onToolResult });
    const command = "pnpm test";
    const cwd = `/very-long-root/${"a".repeat(10_500)}`;
    const summary = h.formatToolAggregate(
      "bash",
      [h.inferToolMetaFromArgs("exec", { command, cwd }, { detailMode: "explain" }) ?? ""],
      { markdown: true },
    );
    expect(summary.length).toBeGreaterThan(10_000);
    const item = createNativeCommandItem({
      id: "cmd-summary-then-stream",
      command,
      cwd,
    });
    await startCommand(projector, item);
    expect(onToolResult.mock.calls[0]?.[0].text).toHaveLength(10_000);
    expect(onToolResult.mock.calls[0]?.[0].text).toContain(
      "OpenClaw truncated Codex native tool output",
    );
    // More than the former signature FIFO capacity; a trailing newline must not change matching.
    const chunks = Array.from(
      { length: 40 },
      (_, i) => `${"s".repeat(300)}${String(i).padStart(2, "0")}\n`,
    );
    for (const chunk of chunks) {
      await delta(projector, item.id, chunk);
    }
    expect(onToolResult).toHaveBeenCalledTimes(21);
    expect(onToolResult.mock.calls[20]?.[0].text).toContain("...(truncated)...");
    await rawAssistant(projector, summary, { id: "raw-summary" });
    await rawAssistant(projector, chunks.join(""), { id: "raw-stream" });
    await projector.handleNotification(
      h.turnCompleted([createNativeCommandItem({ id: item.id, command, cwd })]),
    );
    const result = expectNoReply(projector);
    const toolResult = result.messagesSnapshot.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({ toolCallId: item.id, toolName: "bash", isError: false });
    const output = toolResult?.content.find((block) => block.type === "text")?.text;
    expect(output).toHaveLength(10_000);
    expect(output).toContain("OpenClaw truncated Codex native tool output");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(summary.slice(0, 1_000));
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(chunks.join("").trim());
  });
});

it("keeps streamed progress UTF-16 safe with 7999 chars already emitted", async () => {
  const onToolResult = vi.fn();
  const projector = await createVerboseProjector({ onToolResult });

  await delta(projector, "cmd-progress-utf16", "a".repeat(7_999));
  onToolResult.mockClear();
  await delta(projector, "cmd-progress-utf16", "😀tail");

  expect(onToolResult).toHaveBeenCalledTimes(1);
  expect(onToolResult).toHaveBeenCalledWith({
    text: "Bash\n```txt\n...(truncated)...\n```",
  });
  const text = (h.mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string }).text;
  expect(text).not.toMatch(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
  );
});
