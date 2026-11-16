import { expect, it } from "vitest";
import {
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  guestCodeModeExecTool,
  makeToolOutputWithCallId,
  makeUserInput,
  outputText,
  outputToolArgsFromItem as callArgs,
  outputToolCall,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const shellExec = {
  type: "function",
  name: "exec",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};
async function startTurn(prompt: string, body: Record<string, unknown>) {
  const server = await startMockServer();
  const input: unknown[] = [makeUserInput(prompt)];
  const request = () => expectNonStreamingResponsesJson(server, { ...body, input });
  const complete = (call: Record<string, unknown>, output: string) => {
    input.push(call, makeToolOutputWithCallId(String(call.call_id), output));
    return request();
  };
  return { request, complete };
}

it("continues cron delivery before a generic QA tool plan", async () => {
  const plan = { calls: [{ name: "read", args: { path: "unreachable.txt" } }], reply: "wrong" };
  const turn = await startTurn(
    `Cron send-then-continue QA check. Delivery target: qa-recipient\nQA tool plan: ${JSON.stringify(plan)}`,
    { tools: ["message", "write", "read"].map((name) => ({ type: "function", name })) },
  );
  // The plan would call read first and then reply; the cron turn keeps every step.
  const send = outputToolCall(await turn.request(), "message");
  const write = outputToolCall(await turn.complete(send, "sent"), "write");
  expect(outputText(await turn.complete(write, "written"))).toBe("QA-CRON-SEND-CONTINUE-DONE");
});

it("runs a QA tool plan in order and names each result's media in the reply", async () => {
  const tools = ["image_generate", "music_generate"].map((name) => ({
    type: "function",
    name,
    parameters: { type: "object", properties: { prompt: { type: "string" } } },
  }));
  const plan = {
    calls: [
      { name: "image_generate", args: { prompt: "lighthouse" } },
      { name: "music_generate", args: { prompt: "melody" } },
    ],
    reply: "trusted {{media:0}} plugin {{media:1}}",
  };
  const turn = await startTurn(`QA tool plan: ${JSON.stringify(plan)}`, { tools });

  const first = outputToolCall(await turn.request(), "image_generate");
  expect(callArgs(first)).toEqual({ prompt: "lighthouse" });
  // Shaped like a Tool Search dispatcher result, which wraps the tool's own result.
  const imageResult = {
    tool: { id: "openclaw:image_generate", name: "image_generate" },
    result: { details: { media: { mediaUrls: ["/state/media/generated/a.png"] } } },
  };
  const second = outputToolCall(
    await turn.complete(first, JSON.stringify(imageResult)),
    "music_generate",
  );
  expect(callArgs(second)).toEqual({ prompt: "melody" });
  const done = await turn.complete(second, "Generated music at /state/media/generated/b.mp3");

  expect(outputText(done)).toBe(
    "trusted /state/media/generated/a.png plugin /state/media/generated/b.mp3",
  );
});

it("refuses a QA tool plan step the request does not declare", async () => {
  const plan = { calls: [{ name: "music_generate", args: {} }], reply: "unreachable" };
  const turn = await startTurn(`QA tool plan: ${JSON.stringify(plan)}`, { tools: [shellExec] });

  expect(outputText(await turn.request())).toBe("BUG-QA-TOOL-PLAN-UNDECLARED music_generate");
});

it("names a drive-rooted media path from a plain-text QA tool plan result", async () => {
  const tools = [{ type: "function", name: "music_generate", parameters: { type: "object" } }];
  const plan = { calls: [{ name: "music_generate", args: {} }], reply: "plugin {{media:0}}" };
  const turn = await startTurn(`QA tool plan: ${JSON.stringify(plan)}`, { tools });

  const call = outputToolCall(await turn.request(), "music_generate");
  const done = await turn.complete(call, "Generated music at C:\\state\\media\\generated\\b.mp3");

  expect(outputText(done)).toBe("plugin C:\\state\\media\\generated\\b.mp3");
});

it("waits for a QA tool plan step that Code Mode leaves running", async () => {
  const waitTool = {
    type: "function",
    name: "wait",
    parameters: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
  };
  const tools = [{ type: "function", ...guestCodeModeExecTool }, waitTool];
  const plan = {
    calls: [{ name: "music_generate", args: { prompt: "melody" } }],
    reply: "plugin {{media:0}}",
  };
  const turn = await startTurn(`QA tool plan: ${JSON.stringify(plan)}`, { tools });

  const exec = outputToolCall(await turn.request(), "exec");
  const waiting = JSON.stringify({ status: "waiting", runId: "qa-plan-music" });
  const wait = outputToolCall(await turn.complete(exec, waiting), "wait");
  expect(callArgs(wait)).toEqual({ runId: "qa-plan-music" });
  const done = await turn.complete(
    wait,
    JSON.stringify({
      status: "completed",
      value: "Generated music at /state/media/generated/b.mp3",
    }),
  );

  expect(outputText(done)).toBe("plugin /state/media/generated/b.mp3");
});
