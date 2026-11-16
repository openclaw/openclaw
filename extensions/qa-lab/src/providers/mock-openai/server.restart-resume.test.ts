import { expect, it } from "vitest";
import type { ResponsesInputItem } from "./mock-openai-contracts.js";
import {
  createMockServerTestHarness,
  expectOpenAiNonStreamingResponsesJson,
  guestCodeModeExecTool,
  makeToolOutputWithCallId,
  makeUserInput,
  outputText,
  outputToolArgsFromItem,
  outputToolCall,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

it("advances ordinary QA tool work once per fresh Gateway resume input", async () => {
  const server = await startMockServer();
  const input: ResponsesInputItem[] = [makeUserInput("Code Mode restart wait QA check.")];
  const tools = [
    guestCodeModeExecTool,
    {
      name: "wait",
      parameters: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
    },
  ];
  const request = () => expectOpenAiNonStreamingResponsesJson(server, { input, tools });

  for (const phase of [1, 2, 3]) {
    const exec = outputToolCall(await request(), "exec");
    expect(outputToolArgsFromItem(exec)).toMatchObject({
      code: expect.stringContaining(`CHECKPOINT-${phase}`),
    });
    expect(outputToolArgsFromItem(exec)).not.toHaveProperty("restartSafe");
    input.push(
      exec,
      makeToolOutputWithCallId(
        String(exec.call_id),
        JSON.stringify({ status: "waiting", runId: `cell-${phase}` }),
      ),
    );
    const wait = outputToolCall(await request(), "wait");
    expect(outputToolArgsFromItem(wait)).toEqual({ runId: `cell-${phase}` });
    input.push(
      wait,
      makeToolOutputWithCallId(String(wait.call_id), "The run was aborted."),
      makeUserInput(
        "The Gateway restarted while you were working. Resume your work: check the current state of anything that was in progress (files, processes, subagents, external actions) before repeating it, then continue.",
      ),
    );
  }

  expect(outputText(await request())).toBe("RESTART-CODE-MODE-WAIT-OK");
});
