import { runInNewContext } from "node:vm";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import {
  createMockServerTestHarness,
  guestCodeModeExecTool,
  expectOpenAiNonStreamingResponsesJson,
  outputItems,
  outputToolArgsFromItem,
  outputToolCall,
  outputToolCallId,
  outputText,
  makeUserInput,
  makeToolOutputWithCallId,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
type JsonObject = Record<string, unknown>;
const tool = (name: string, parameters: JsonObject = { type: "object" }) => ({
  type: "function",
  name,
  parameters,
});
const restartCheckpointTools = [
  { type: "function", name: "exec", parameters: guestCodeModeExecTool.parameters },
  tool("wait", {
    type: "object",
    properties: { runId: { type: "string" } },
    required: ["runId"],
  }),
];
const restartRecoveryPrompt =
  "Your previous turn was interrupted by a gateway restart. Continue from the existing transcript.";
const unsafeProbe = tool("qa_restart_unsafe_probe");

function singleToolCall(payload: unknown, name: string) {
  expect(outputItems(payload)).toHaveLength(1);
  return outputToolCall(payload, name);
}

async function checkpointWait(
  input: JsonObject[],
  request: () => Promise<unknown>,
  checkpoint: number,
  [runId, fallback]: [string, string],
) {
  const execCall = singleToolCall(await request(), "exec");
  const execArgs = outputToolArgsFromItem(execCall);
  await expectCheckpoint(execArgs, checkpoint);
  input.push(
    execCall,
    makeToolOutputWithCallId(
      outputToolCallId(execCall, fallback),
      JSON.stringify({ status: "waiting", runId }),
    ),
  );
  const waitCall = singleToolCall(await request(), "wait");
  expect(outputToolArgsFromItem(waitCall)).toEqual({ runId });
  input.push(waitCall, makeUserInput(restartRecoveryPrompt));
  return execArgs;
}

async function expectCheckpoint(execArgs: JsonObject, checkpoint: number) {
  validateToolArguments(guestCodeModeExecTool, {
    type: "toolCall",
    id: "restart-checkpoint",
    name: "exec",
    arguments: execArgs,
  });
  expect(execArgs).toEqual({
    title: expect.any(String),
    code: expect.any(String),
    restartSafe: true,
  });
  const started = createDeferred<void>();
  const released = createDeferred<void>();
  const target = Object.assign(
    vi.fn((_args: unknown) => {
      started.resolve();
      return released.promise;
    }),
    { toolName: "qa_restart_wait" },
  );
  const yieldControl = vi.fn();
  const execution: unknown = runInNewContext(`(async () => { ${String(execArgs.code)} })()`, {
    catalog: {
      search: async (name: string) => {
        expect(name).toBe("qa_restart_wait");
        return [target];
      },
    },
    yield_control: yieldControl,
  });
  try {
    await Promise.race([
      started.promise,
      Promise.resolve(execution).then(() => {
        throw new Error("checkpoint script completed before waiting");
      }),
    ]);
    expect(yieldControl).toHaveBeenCalled();
  } finally {
    released.resolve();
    await expect(execution).resolves.toBe(`CHECKPOINT-${checkpoint}`);
  }
  expect(target.mock.calls.map(([args]) => args)).toEqual([{}]);
}

it("settles hard-kill recovery after one real checkpoint and resets from request history", async () => {
  const server = await startMockServer();
  const prompt = "Code Mode restart wait QA check. Original prompt marker: KILL-RESTART-PROMPT.";
  const tools = [...restartCheckpointTools, unsafeProbe];
  const input: JsonObject[] = [makeUserInput(prompt)];
  const request = () => expectOpenAiNonStreamingResponsesJson(server, { tools, input });
  const execArgs = await checkpointWait(input, request, 1, [
    "kill-restart-checkpoint-1",
    "kill-restart-exec",
  ]);
  const recovered = await request();
  expect(outputItems(recovered).map((item) => item.type)).toEqual(["message"]);
  expect(outputText(recovered)).toBe("KILL-RESTART-RECOVERED-OK");
  const freshPayload = await expectOpenAiNonStreamingResponsesJson(server, {
    tools,
    input: [makeUserInput(prompt)],
  });
  expect(outputToolArgsFromItem(singleToolCall(freshPayload, "exec"))).toEqual(execArgs);
});

it("derives three restart checkpoints from request history with developer additional tools", async () => {
  const server = await startMockServer();
  const prompt =
    "Code Mode restart wait QA check. Original prompt marker: RESTART-CODE-MODE-PROMPT.";
  const input: JsonObject[] = [makeUserInput(prompt)];
  const request = (history = input, tools = restartCheckpointTools) =>
    expectOpenAiNonStreamingResponsesJson(server, {
      input: [{ type: "additional_tools", role: "developer", tools }, ...history],
    });
  for (const checkpoint of [1, 2, 3]) {
    await checkpointWait(input, request, checkpoint, [
      `restart-checkpoint-${checkpoint}`,
      `checkpoint-exec-${checkpoint}`,
    ]);
  }
  const finalPayload = await request();
  expect(outputText(finalPayload)).toBe("unsafeVisible=false\nRESTART-CODE-MODE-WAIT-OK");
  const unsafePayload = await request(input, [...restartCheckpointTools, unsafeProbe]);
  expect(outputToolArgsFromItem(singleToolCall(unsafePayload, "qa_restart_unsafe_probe"))).toEqual(
    {},
  );
  const freshPayload = await request([makeUserInput(prompt)]);
  await expectCheckpoint(outputToolArgsFromItem(outputToolCall(freshPayload, "exec")), 1);
});
