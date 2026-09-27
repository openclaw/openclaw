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
  const restartCheckpointTools = [
    {
      type: "function",
      name: "exec",
      parameters: guestCodeModeExecTool.parameters,
    },
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
    const tools = [
      ...restartCheckpointTools,
      { type: "function", name: "qa_restart_unsafe_probe", parameters: { type: "object" } },
    ];
    const input: Array<Record<string, unknown>> = [makeUserInput(prompt)];
    const execPayload = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
    expect(outputItems(execPayload)).toHaveLength(1);
    const execCall = outputToolCall(execPayload, "exec");
    const execArgs = outputToolArgsFromItem(execCall);
    await expectRestartCheckpointExecution(execArgs, 1);

    const runId = "kill-restart-checkpoint-1";
    input.push(
      execCall,
      makeToolOutputWithCallId(
        outputToolCallId(execCall, "kill-restart-exec"),
        JSON.stringify({ status: "waiting", runId }),
      ),
    );
    const waitPayload = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
    expect(outputItems(waitPayload)).toHaveLength(1);
    const waitCall = outputToolCall(waitPayload, "wait");
    expect(outputToolArgsFromItem(waitCall)).toEqual({ runId });
    input.push(waitCall, makeUserInput(restartRecoveryPrompt));

    const recovered = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
    expect(outputItems(recovered).map((item) => item.type)).toEqual(["message"]);
    expect(outputText(recovered)).toBe("KILL-RESTART-RECOVERED-OK");

    const freshPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [makeUserInput(prompt)],
    });
    expect(outputItems(freshPayload)).toHaveLength(1);
    expect(outputToolArgsFromItem(outputToolCall(freshPayload, "exec"))).toEqual(execArgs);
  });

  it.each([
    {
      label: "direct body tools",
      surface: "direct",
    },
    {
      label: "developer additional tools",
      surface: "developer",
    },
  ])(
    "derives three restart checkpoints from request history without server counters via $label",
    async ({ surface }) => {
      const server = await startMockServer();
      const prompt =
        "Code Mode restart wait QA check. Original prompt marker: RESTART-CODE-MODE-PROMPT.";
      const withDeclarationSurface = (
        tools: Array<Record<string, unknown>>,
        input: Array<Record<string, unknown>>,
      ) =>
        surface === "direct"
          ? { tools, input }
          : { input: [{ type: "additional_tools", role: "developer", tools }, ...input] };
      const input: Array<Record<string, unknown>> = [makeUserInput(prompt)];

      for (const checkpoint of [1, 2, 3]) {
        const execPayload = await expectOpenAiNonStreamingResponsesJson(
          server,
          withDeclarationSurface(restartCheckpointTools, input),
        );
        const execCall = outputToolCall(execPayload, "exec");
        const execArgs = outputToolArgsFromItem(execCall);
        await expectRestartCheckpointExecution(execArgs, checkpoint);

        const runId = `restart-checkpoint-${checkpoint}`;
        input.push(
          execCall,
          makeToolOutputWithCallId(
            outputToolCallId(execCall, `checkpoint-exec-${checkpoint}`),
            JSON.stringify({ status: "waiting", runId }),
          ),
        );
        const waitPayload = await expectOpenAiNonStreamingResponsesJson(
          server,
          withDeclarationSurface(restartCheckpointTools, input),
        );
        const waitCall = outputToolCall(waitPayload, "wait");
        expect(outputToolArgsFromItem(waitCall)).toEqual({ runId });
        input.push(waitCall, makeUserInput(restartRecoveryPrompt));
      }

      const finalPayload = await expectOpenAiNonStreamingResponsesJson(
        server,
        withDeclarationSurface(restartCheckpointTools, input),
      );
      expect(outputText(finalPayload)).toBe("unsafeVisible=false\nRESTART-CODE-MODE-WAIT-OK");

      const unsafePayload = await expectOpenAiNonStreamingResponsesJson(
        server,
        withDeclarationSurface(
          [
            ...restartCheckpointTools,
            {
              type: "function",
              name: "qa_restart_unsafe_probe",
              parameters: { type: "object" },
            },
          ],
          input,
        ),
      );
      expect(
        outputToolArgsFromItem(outputToolCall(unsafePayload, "qa_restart_unsafe_probe")),
      ).toEqual({});
      expect(outputItems(unsafePayload).map((item) => item.type)).toEqual(["function_call"]);

      const freshPayload = await expectOpenAiNonStreamingResponsesJson(
        server,
        withDeclarationSurface(restartCheckpointTools, [makeUserInput(prompt)]),
      );
      await expectRestartCheckpointExecution(
        outputToolArgsFromItem(outputToolCall(freshPayload, "exec")),
        1,
      );
    },
  );
});
