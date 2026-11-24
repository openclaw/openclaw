import { expect, it } from "vitest";
import { functionCall, respond, userInputs } from "./server.fixtures.test-support.js";
import {
  createMockServerTestHarness,
  makeToolOutputWithCallId,
  outputText,
  outputToolArgs,
  outputToolArgsFromItem,
  outputToolCall,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const context = {
  type: "function_call_output",
  name: "notifications",
  namespace: "slack",
  output: "An unrelated notification.",
};
const markedContext = {
  role: "user",
  content: [
    {
      type: "input_text",
      text: "<external_openclaw_current_sender>QA</external_openclaw_current_sender>",
    },
  ],
};
const scratchPrompt = "Automation self scratch QA check: content=updated marker=SCRATCH_DONE";
const tools = ["automations", "exec", "message", "write", "dashboard"].map((name) => ({
  type: "function",
  name,
}));

it.each([
  { prompt: scratchPrompt, tool: "automations", args: { action: "scratch_get" } },
  {
    prompt: "Hook automations scope QA check: target=other-job",
    tool: "automations",
    args: { action: "remove", jobId: "other-job" },
  },
  {
    prompt: "Cron one-shot QA mode=service",
    tool: "exec",
    args: { command: "sleep 30; echo QA-ONE-SHOT-SERVICE-EXIT", background: true },
  },
  {
    prompt: "Trusted automation owner QA check: action=pause target=other-job marker=PAUSE_DONE",
    tool: "automations",
    args: { action: "update", jobId: "other-job", job: { enabled: false } },
  },
  {
    prompt: "Owner completion QA check: job=example",
    tool: "exec",
    args: { command: "sleep 6; echo QA-OWNER-COMPLETION-OUTPUT-example", background: true },
  },
  {
    prompt: "Cron send-then-continue QA check. Delivery target: qa-target",
    tool: "message",
    args: {
      action: "send",
      channel: "qa-channel",
      target: "qa-target",
      message: "QA-CRON-SEND-CONTINUE-SENT",
    },
  },
  {
    prompt: "Cron parent board QA check: tab=report",
    tool: "dashboard",
    args: { action: "tab_create", tabId: "report", title: "Scheduled report" },
  },
  {
    prompt:
      "Cron failure repair QA check. Automation repair request from the scheduler: created in this conversation, failed 3 consecutive runs",
    tool: "write",
    args: { path: "cron-repair-step.md", content: "Sync step fixed by the owner conversation.\n" },
  },
])("keeps context from completing $prompt", async ({ prompt, tool, args }) => {
  const server = await startMockServer();
  const request = (input: unknown) => respond(server, input, { tools });
  expect(outputToolArgsFromItem(outputToolCall(await request(prompt), tool))).toEqual(args);
  const input = userInputs(
    "An earlier task.",
    functionCall("read", { path: "earlier.txt" }, "earlier-read"),
    makeToolOutputWithCallId("earlier-read", "Earlier result."),
    markedContext,
    prompt,
    context,
  );
  const response = await request(input);
  expect(outputToolArgsFromItem(outputToolCall(response, tool))).toEqual(args);
});

it("advances scratch only for current linked results, including aliases and an empty completion", async () => {
  const server = await startMockServer();
  const request = (input: unknown) => respond(server, input, { tools });
  const input = userInputs(markedContext, scratchPrompt, context);
  const read = outputToolCall(await request(input), "automations");
  const afterRead = [
    ...input,
    read,
    { type: "function_call_output", tool_call_id: read.call_id, output: '{"currentRevision":7}' },
    context,
  ];
  const update = await request(afterRead);
  expect(outputToolArgs(update)).toEqual({
    action: "scratch_set",
    content: "updated",
    expectedRevision: 7,
  });
  const write = outputToolCall(update, "automations");
  const completed = [
    ...afterRead,
    write,
    { type: "function_call_output", tool_use_id: write.call_id, output: "" },
    context,
  ];
  expect(outputText(await request(completed))).toBe("SCRATCH_DONE");
  expect(outputToolArgs(await request(userInputs(...completed, scratchPrompt)))).toEqual({
    action: "scratch_get",
  });
});
