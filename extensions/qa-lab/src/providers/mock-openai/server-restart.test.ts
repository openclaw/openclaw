import { runInNewContext } from "node:vm";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
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

describe("mock provider restart checkpoints", () => {
  const restartCheckpointTools: Array<Record<string, unknown>> = [
    { type: "function", name: "exec", parameters: guestCodeModeExecTool.parameters },
    {
      type: "function",
      name: "wait",
      parameters: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
    },
  ];
  const restartRecoveryPrompt =
    "Your previous turn was interrupted by a gateway restart. Continue from the existing transcript.";
  const unsafeProbe = {
    type: "function",
    name: "qa_restart_unsafe_probe",
    parameters: { type: "object" },
  };

  async function checkpointWait(
    input: Array<Record<string, unknown>>,
    request: () => Promise<unknown>,
    checkpoint: number,
    runId: string,
    fallback: string,
    singleOutput = false,
  ) {
    const execPayload = await request();
    if (singleOutput) {
      expect(outputItems(execPayload)).toHaveLength(1);
    }
    const execCall = outputToolCall(execPayload, "exec");
    const execArgs = outputToolArgsFromItem(execCall);
    await expectRestartCheckpointExecution(execArgs, checkpoint);
    input.push(
      execCall,
      makeToolOutputWithCallId(
        outputToolCallId(execCall, fallback),
        JSON.stringify({ status: "waiting", runId }),
      ),
    );
    const waitPayload = await request();
    if (singleOutput) {
      expect(outputItems(waitPayload)).toHaveLength(1);
    }
    const waitCall = outputToolCall(waitPayload, "wait");
    expect(outputToolArgsFromItem(waitCall)).toEqual({ runId });
    input.push(waitCall, makeUserInput(restartRecoveryPrompt));
    return execArgs;
  }

  async function expectRestartCheckpointExecution(
    execArgs: Record<string, unknown>,
    checkpoint: number,
  ) {
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
    const calls: unknown[] = [];
    const target = Object.assign(
      (args: unknown) => {
        calls.push(args);
        started.resolve();
        return released.promise;
      },
      { toolName: "qa_restart_wait" },
    );
    let yielded = false;
    const execution: unknown = runInNewContext(`(async () => { ${String(execArgs.code)} })()`, {
      catalog: {
        search: async (name: string) => {
          expect(name).toBe("qa_restart_wait");
          return [target];
        },
      },
      yield_control: () => {
        yielded = true;
      },
    });
    try {
      await Promise.race([
        started.promise,
        Promise.resolve(execution).then(() => {
          throw new Error("checkpoint script completed before waiting");
        }),
      ]);
      expect(yielded).toBe(true);
    } finally {
      released.resolve();
      await expect(execution).resolves.toBe(`CHECKPOINT-${checkpoint}`);
    }
    expect(calls).toEqual([{}]);
  }

  it("settles hard-kill recovery after one real checkpoint and resets from request history", async () => {
    const server = await startMockServer();
    const prompt = "Code Mode restart wait QA check. Original prompt marker: KILL-RESTART-PROMPT.";
    const tools = [...restartCheckpointTools, unsafeProbe];
    const input: Array<Record<string, unknown>> = [makeUserInput(prompt)];
    const request = () => expectOpenAiNonStreamingResponsesJson(server, { tools, input });
    const execArgs = await checkpointWait(
      input,
      request,
      1,
      "kill-restart-checkpoint-1",
      "kill-restart-exec",
      true,
    );
    const recovered = await request();
    expect(outputItems(recovered).map((item) => item.type)).toEqual(["message"]);
    expect(outputText(recovered)).toBe("KILL-RESTART-RECOVERED-OK");

    const freshPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [makeUserInput(prompt)],
    });
    expect(outputItems(freshPayload)).toHaveLength(1);
    expect(outputToolArgsFromItem(outputToolCall(freshPayload, "exec"))).toEqual(execArgs);
  });

  it("derives three restart checkpoints from request history with developer additional tools", async () => {
    const server = await startMockServer();
    const prompt =
      "Code Mode restart wait QA check. Original prompt marker: RESTART-CODE-MODE-PROMPT.";
    const input: Array<Record<string, unknown>> = [makeUserInput(prompt)];
    const request = (history = input, tools = restartCheckpointTools) =>
      expectOpenAiNonStreamingResponsesJson(server, {
        input: [{ type: "additional_tools", role: "developer", tools }, ...history],
      });
    for (const checkpoint of [1, 2, 3]) {
      await checkpointWait(
        input,
        request,
        checkpoint,
        `restart-checkpoint-${checkpoint}`,
        `checkpoint-exec-${checkpoint}`,
      );
    }
    const finalPayload = await request();
    expect(outputText(finalPayload)).toBe("unsafeVisible=false\nRESTART-CODE-MODE-WAIT-OK");

    const unsafePayload = await request(input, [...restartCheckpointTools, unsafeProbe]);
    expect(
      outputToolArgsFromItem(outputToolCall(unsafePayload, "qa_restart_unsafe_probe")),
    ).toEqual({});
    expect(outputItems(unsafePayload).map((item) => item.type)).toEqual(["function_call"]);

    const freshPayload = await request([makeUserInput(prompt)]);
    await expectRestartCheckpointExecution(
      outputToolArgsFromItem(outputToolCall(freshPayload, "exec")),
      1,
    );
  });
});
